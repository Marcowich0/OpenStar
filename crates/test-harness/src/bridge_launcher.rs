//! A Mic bridge launcher: a local HTTP server that starts and stops Mic
//! bridge processes (`openstar-mic-bridge --wav`) on this machine, for a
//! Playwright spec that runs somewhere it cannot start the bridge itself
//! (`just e2e`'s Playwright container has an older glibc than the bridge was
//! built against).
//!
//! Every bridge it starts runs headless on the one WAV file it was given,
//! against the one server, with a fresh `HOME` and config folder of its own
//! (so it has no token and waits for its own approval) and a clean
//! environment (only `PATH` is kept).
//!
//! - `POST /bridges` with `{"wavName": "<file name>"}` (optional; the WAV's
//!   own name by default) starts one and answers `201 {"id": <n>}`. The WAV
//!   is linked under that name, which the bridge names its interface by, so
//!   a spec can tell its bridge apart from any other on the same WAV. A name
//!   that is empty or holds a `/` gets a 400.
//! - `GET /bridges/<id>/output`: everything it printed so far, stdout and
//!   stderr together, as text.
//! - `DELETE /bridges/<id>` kills it, waits for it to end and answers its
//!   whole output. 404 for an id that is not running.
//!
//! Dropping the [`BridgeLauncher`] kills and reaps every bridge still running.

use std::collections::HashMap;
use std::fs::File;
use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex, PoisonError};

use axum::Router;
use axum::extract::{Json, Path as UrlPath, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get, post};
use serde::Deserialize;
use tokio::task::JoinHandle;

/// What every bridge the launcher starts is given.
#[derive(Debug, Clone)]
pub struct LaunchSettings {
    /// The bridge binary (`openstar-mic-bridge`).
    pub bridge: PathBuf,
    /// The server address it connects to, as its config file holds it.
    pub server: String,
    /// The WAV file it reads (`--wav`).
    pub wav: PathBuf,
}

/// The running launcher; see the module docs.
pub struct BridgeLauncher {
    addr: SocketAddr,
    inner: Arc<Inner>,
    task: JoinHandle<()>,
}

struct Inner {
    settings: LaunchSettings,
    /// Holds one folder per bridge: its `HOME`, config, WAV link and output.
    root: tempfile::TempDir,
    state: Mutex<Launched>,
}

#[derive(Default)]
struct Launched {
    next_id: u64,
    running: HashMap<u64, Running>,
}

struct Running {
    child: Child,
    output: PathBuf,
}

impl Running {
    /// Kills the process and reaps it.
    fn end(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

impl Inner {
    fn launched(&self) -> std::sync::MutexGuard<'_, Launched> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn end_all(&self) {
        let running: Vec<Running> = self.launched().running.drain().map(|(_, r)| r).collect();
        for mut bridge in running {
            bridge.end();
        }
    }

    fn start(&self, wav_name: &str) -> std::io::Result<u64> {
        let id = {
            let mut launched = self.launched();
            launched.next_id += 1;
            launched.next_id
        };
        let dir = self.root.path().join(format!("bridge-{id}"));
        let config = dir.join("config");
        std::fs::create_dir_all(config.join("openstar-mic-bridge"))?;
        std::fs::write(
            config.join("openstar-mic-bridge/server"),
            format!("{}\n", self.settings.server),
        )?;
        let wav = dir.join(wav_name);
        std::os::unix::fs::symlink(absolute(&self.settings.wav)?, &wav)?;
        let output = dir.join("output.log");
        let stdout = File::create(&output)?;
        let stderr = stdout.try_clone()?;
        let mut command = Command::new(&self.settings.bridge);
        command
            .arg("--wav")
            .arg(&wav)
            .env_clear()
            .env("HOME", &dir)
            .env("XDG_CONFIG_HOME", &config)
            .stdin(Stdio::null())
            .stdout(stdout)
            .stderr(stderr);
        if let Some(path) = std::env::var_os("PATH") {
            command.env("PATH", path);
        }
        let child = command.spawn()?;
        self.launched()
            .running
            .insert(id, Running { child, output });
        Ok(id)
    }
}

impl Drop for Inner {
    fn drop(&mut self) {
        self.end_all();
    }
}

fn absolute(path: &Path) -> std::io::Result<PathBuf> {
    if path.is_absolute() {
        Ok(path.to_owned())
    } else {
        Ok(std::env::current_dir()?.join(path))
    }
}

impl BridgeLauncher {
    /// Serves on `addr` (port 0 picks a free one).
    pub async fn serve(settings: LaunchSettings, addr: SocketAddr) -> std::io::Result<Self> {
        let listener = tokio::net::TcpListener::bind(addr).await?;
        let addr = listener.local_addr()?;
        let inner = Arc::new(Inner {
            settings,
            root: tempfile::Builder::new()
                .prefix("openstar-bridge-launcher.")
                .tempdir()?,
            state: Mutex::new(Launched::default()),
        });
        let app = Router::new()
            .route("/bridges", post(start))
            .route("/bridges/{id}", delete(stop))
            .route("/bridges/{id}/output", get(output))
            .with_state(inner.clone());
        let task = tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });
        Ok(Self { addr, inner, task })
    }

    /// `http://127.0.0.1:<port>`, without a trailing slash.
    pub fn base_url(&self) -> String {
        format!("http://{}", self.addr)
    }

    /// Runs until the server task ends (in practice, until killed).
    pub async fn wait(&mut self) {
        let _ = (&mut self.task).await;
    }
}

impl Drop for BridgeLauncher {
    fn drop(&mut self) {
        self.task.abort();
        self.inner.end_all();
    }
}

#[derive(Debug, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct StartRequest {
    wav_name: Option<String>,
}

async fn start(State(inner): State<Arc<Inner>>, Json(request): Json<StartRequest>) -> Response {
    let name = match request.wav_name {
        Some(name) => name,
        None => match inner.settings.wav.file_name() {
            Some(name) => name.to_string_lossy().into_owned(),
            None => {
                return (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "the WAV path names no file",
                )
                    .into_response();
            }
        },
    };
    if name.is_empty() || name == "." || name == ".." || name.contains('/') {
        return (StatusCode::BAD_REQUEST, "wavName must be a file name").into_response();
    }
    match inner.start(&name) {
        Ok(id) => (StatusCode::CREATED, Json(serde_json::json!({ "id": id }))).into_response(),
        Err(error) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("starting the Mic bridge: {error}"),
        )
            .into_response(),
    }
}

async fn output(State(inner): State<Arc<Inner>>, UrlPath(id): UrlPath<u64>) -> Response {
    let Some(file) = inner.launched().running.get(&id).map(|r| r.output.clone()) else {
        return StatusCode::NOT_FOUND.into_response();
    };
    read_output(&file).into_response()
}

async fn stop(State(inner): State<Arc<Inner>>, UrlPath(id): UrlPath<u64>) -> Response {
    let Some(mut bridge) = inner.launched().running.remove(&id) else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let ended = tokio::task::spawn_blocking(move || {
        bridge.end();
        read_output(&bridge.output)
    })
    .await;
    match ended {
        Ok(text) => text.into_response(),
        Err(_) => StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    }
}

/// The output so far, lossily as text (a missing file reads as empty).
fn read_output(file: &Path) -> String {
    String::from_utf8_lossy(&std::fs::read(file).unwrap_or_default()).into_owned()
}
