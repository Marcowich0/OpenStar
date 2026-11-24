// PROTOTYPE, throwaway. A relay for the phone mic latency prototype.
// Phones send JSON text; the relay forwards it verbatim to the one Stage.
// The Stage sends {"to": <phoneId>, ...}; the relay routes it to that Phone.
// It also serves ../web and writes POSTed results into ../results.

use std::{
    collections::HashMap,
    net::SocketAddr,
    path::PathBuf,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex,
    },
    time::{SystemTime, UNIX_EPOCH},
};

use axum::{
    serve::ListenerExt,
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        Query, State,
    },
    response::IntoResponse,
    routing::{get, post},
    Router,
};
use futures_util::{SinkExt, StreamExt};
use tokio::sync::mpsc::{unbounded_channel, UnboundedSender};
use tower_http::services::ServeDir;

type Tx = UnboundedSender<Message>;

#[derive(Default)]
struct Hub {
    stage: Option<(u64, Tx)>,
    phones: HashMap<u64, (String, Tx)>,
}

#[derive(Clone)]
struct App {
    hub: Arc<Mutex<Hub>>,
    next_id: Arc<AtomicU64>,
    results_dir: PathBuf,
}

#[tokio::main]
async fn main() {
    let base = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..");
    let app = App {
        hub: Arc::default(),
        next_id: Arc::new(AtomicU64::new(1)),
        results_dir: base.join("results"),
    };
    let router = Router::new()
        .route("/ws", get(ws))
        .route("/api/results", post(save_results))
        .fallback_service(ServeDir::new(base.join("web")))
        .with_state(app);
    let port: u16 = std::env::var("PORT").ok().and_then(|p| p.parse().ok()).unwrap_or(8787);
    // BIND=0.0.0.0 lets a Stage on the LAN connect over plain HTTP (it needs no mic).
    let ip: std::net::IpAddr = std::env::var("BIND").ok().and_then(|b| b.parse().ok()).unwrap_or([127, 0, 0, 1].into());
    let addr = SocketAddr::new(ip, port);
    println!("relay on http://{addr}");
    // Small frames at 100/s: turn Nagle off so the kernel never holds a reading back.
    let listener = tokio::net::TcpListener::bind(addr).await.unwrap().tap_io(|tcp| {
        let _ = tcp.set_nodelay(true);
    });
    axum::serve(listener, router).await.unwrap();
}

async fn ws(
    up: WebSocketUpgrade,
    Query(q): Query<HashMap<String, String>>,
    State(app): State<App>,
) -> impl IntoResponse {
    let role = q.get("role").cloned().unwrap_or_default();
    let name = q.get("name").cloned().unwrap_or_else(|| "phone".into());
    up.on_upgrade(move |socket| handle(socket, role, name, app))
}

async fn handle(socket: WebSocket, role: String, name: String, app: App) {
    let id = app.next_id.fetch_add(1, Ordering::Relaxed);
    let (mut sink, mut stream) = socket.split();
    let (tx, mut rx) = unbounded_channel::<Message>();
    let writer = tokio::spawn(async move {
        while let Some(m) = rx.recv().await {
            if sink.send(m).await.is_err() {
                break;
            }
        }
    });
    let is_stage = role == "stage";
    {
        let mut hub = app.hub.lock().unwrap();
        if is_stage {
            hub.stage = Some((id, tx.clone()));
            for (pid, (pname, _)) in &hub.phones {
                let _ = tx.send(text(serde_json::json!({"t":"join","id":pid,"name":pname})));
            }
        } else {
            hub.phones.insert(id, (name.clone(), tx.clone()));
            if let Some((_, s)) = &hub.stage {
                let _ = s.send(text(serde_json::json!({"t":"join","id":id,"name":name})));
            }
        }
    }
    let _ = tx.send(text(serde_json::json!({"t":"hello","id":id})));
    println!("{} {id} connected ({name})", if is_stage { "stage" } else { "phone" });

    while let Some(Ok(msg)) = stream.next().await {
        let Message::Text(body) = msg else { continue };
        if is_stage {
            // Route by "to" without re-encoding the payload.
            let to = serde_json::from_str::<serde_json::Value>(body.as_str())
                .ok()
                .and_then(|v| v.get("to").and_then(|t| t.as_u64()));
            if let Some(to) = to {
                if let Some((_, p)) = app.hub.lock().unwrap().phones.get(&to) {
                    let _ = p.send(Message::Text(body));
                }
            }
        } else if let Some((_, s)) = &app.hub.lock().unwrap().stage {
            let _ = s.send(Message::Text(body));
        }
    }

    {
        let mut hub = app.hub.lock().unwrap();
        if is_stage {
            if matches!(hub.stage, Some((sid, _)) if sid == id) {
                hub.stage = None;
            }
        } else {
            hub.phones.remove(&id);
            if let Some((_, s)) = &hub.stage {
                let _ = s.send(text(serde_json::json!({"t":"leave","id":id})));
            }
        }
    }
    writer.abort();
    println!("{id} disconnected");
}

fn text(v: serde_json::Value) -> Message {
    Message::Text(v.to_string().into())
}

async fn save_results(State(app): State<App>, body: String) -> impl IntoResponse {
    let ms = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_millis();
    let path = app.results_dir.join(format!("run-{ms}.json"));
    match std::fs::write(&path, body) {
        Ok(()) => format!("saved {}", path.file_name().unwrap().to_string_lossy()),
        Err(e) => format!("failed: {e}"),
    }
}
