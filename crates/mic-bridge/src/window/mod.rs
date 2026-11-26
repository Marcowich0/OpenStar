//! The bridge's window (v1 spec #51): an egui/eframe window that shows the
//! server address, the connection status and every channel with its name,
//! whether it is on and its meter. The bridge captures only while the
//! window is open: the connection runs beside it and is dropped when it
//! closes, so the Stage shows the bridge as closed and its Local mics stop.
//!
//! [`state`] is what the window shows and [`view`] how it draws it; both
//! are tested without a display (snapshots in `tests/window.rs`).
//! Graphics libraries (OpenGL/EGL, X11 or Wayland, xkbcommon) are loaded at
//! run time by eframe's glow backend and winit, so the binary links none.

pub mod state;
pub mod view;

use std::future::Future;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use crate::client::{self, Event, Input, Report};
use crate::config::ConfigDir;
use state::WindowState;

/// The window's title.
pub const TITLE: &str = "OpenStar Mic bridge";

/// How long the connection gets to wind down after the window closes.
const SHUTDOWN: Duration = Duration::from_secs(2);

/// What the window shows, shared between the connection and the window.
#[derive(Clone)]
pub struct Shared {
    state: Arc<Mutex<WindowState>>,
    repaint: Arc<OnceLock<egui::Context>>,
}

impl Shared {
    pub fn new(state: WindowState) -> Self {
        Self {
            state: Arc::new(Mutex::new(state)),
            repaint: Arc::new(OnceLock::new()),
        }
    }

    /// A copy of what the window shows now.
    pub fn snapshot(&self) -> WindowState {
        self.lock().clone()
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, WindowState> {
        // A panic while holding the lock leaves a state that is still whole.
        self.state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    fn changed(&self) {
        if let Some(ctx) = self.repaint.get() {
            ctx.request_repaint();
        }
    }

    /// The connection gave up: the window says why.
    pub fn stop(&self, problem: String) {
        self.lock().stop(problem);
        self.changed();
    }
}

impl Report for Shared {
    fn event(&mut self, event: Event<'_>) {
        self.lock().apply(event);
        self.changed();
    }
}

/// Runs the connection only while `window` runs: `window` blocks this
/// thread until the window is closed, then the connection is dropped (its
/// socket closes, so the server shows the bridge as closed) and every input
/// is closed with it.
pub fn while_open<C>(
    connection: C,
    window: impl FnOnce() -> anyhow::Result<()>,
) -> anyhow::Result<()>
where
    C: Future<Output = ()> + Send + 'static,
{
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .enable_all()
        .build()?;
    let task = runtime.spawn(connection);
    let shown = window();
    task.abort();
    runtime.shutdown_timeout(SHUTDOWN);
    shown
}

/// Opens the window and connects while it is open.
pub fn run(config: ConfigDir, inputs: Vec<Box<dyn Input>>) -> anyhow::Result<()> {
    let interfaces = inputs.iter().map(|i| i.interface().clone()).collect();
    let (server, problem) = match config.server() {
        Ok(server) => (server, None),
        Err(error) => (String::new(), Some(format!("{error:#}"))),
    };
    let mut state = WindowState::new(server, interfaces);
    if let Some(problem) = &problem {
        state.stop(problem.clone());
    }
    let shared = Shared::new(state);
    let connection = {
        let mut report = shared.clone();
        async move {
            if problem.is_some() {
                return;
            }
            if let Err(error) = client::run_reporting(config, inputs, &mut report).await {
                report.stop(format!("{error:#}"));
            }
        }
    };
    while_open(connection, || open_window(shared))
}

fn open_window(shared: Shared) -> anyhow::Result<()> {
    let options = eframe::NativeOptions {
        viewport: egui::ViewportBuilder::default()
            .with_title(TITLE)
            .with_app_id("openstar-mic-bridge")
            .with_inner_size(view::WINDOW_SIZE)
            .with_min_inner_size([360.0, 240.0]),
        ..Default::default()
    };
    eframe::run_native(
        TITLE,
        options,
        Box::new(move |cc| {
            view::set_style(&cc.egui_ctx);
            let _ = shared.repaint.set(cc.egui_ctx.clone());
            Ok(Box::new(App { shared }))
        }),
    )
    .map_err(|error| {
        anyhow::anyhow!("cannot open the window (--wav <file> runs without one): {error}")
    })
}

struct App {
    shared: Shared,
}

impl eframe::App for App {
    fn ui(&mut self, ui: &mut egui::Ui, _frame: &mut eframe::Frame) {
        let state = self.shared.snapshot();
        view::show(ui, &state);
    }
}
