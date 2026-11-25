//! Test helpers for integration tests: the real app in-process, which can be
//! stopped and started again on the same songs and appdata folders and the
//! same address, for every area's restart tests.

use std::net::SocketAddr;
use std::path::Path;

use anyhow::Context;
use tokio::net::TcpListener;
use tokio::sync::oneshot;
use tokio::task::JoinHandle;

use crate::{Config, Server};

/// The real app, serving in-process on a local port.
pub struct TestApp {
    config: Config,
    addr: SocketAddr,
    running: Option<Running>,
}

struct Running {
    stop: oneshot::Sender<()>,
    served: JoinHandle<std::io::Result<()>>,
}

impl TestApp {
    /// Starts the app on `appdata` and `songs` with the test configuration
    /// ([`Config::for_tests`]) on a free port.
    pub async fn start(appdata: &Path, songs: &Path) -> anyhow::Result<Self> {
        Self::start_with(Config::for_tests(appdata, songs)).await
    }

    /// Starts the app with `config` on `127.0.0.1` and `config.port` (0 picks
    /// a free port).
    pub async fn start_with(config: Config) -> anyhow::Result<Self> {
        let listener = TcpListener::bind(("127.0.0.1", config.port)).await?;
        let addr = listener.local_addr()?;
        let running = launch(&config, listener).await?;
        Ok(Self {
            config,
            addr,
            running: Some(running),
        })
    }

    /// The address the app serves on; the same after [`Self::restart`].
    pub fn addr(&self) -> SocketAddr {
        self.addr
    }

    /// `http://<addr><path>`.
    pub fn http_url(&self, path: &str) -> String {
        format!("http://{}{path}", self.addr)
    }

    /// The WebSocket address, `ws://<addr>/ws`.
    pub fn ws_url(&self) -> String {
        format!("ws://{}/ws", self.addr)
    }

    /// The configuration the app runs with.
    pub fn config(&self) -> &Config {
        &self.config
    }

    /// Stops the app as a shutdown signal would: every WebSocket is closed
    /// and serving ends. Returns once the port is free.
    pub async fn stop(&mut self) {
        if let Some(running) = self.running.take() {
            let _ = running.stop.send(());
            match running.served.await {
                Ok(Ok(())) => {}
                Ok(Err(error)) => tracing::warn!(%error, "serving ended with an error"),
                Err(error) => tracing::warn!(%error, "the serving task failed"),
            }
        }
    }

    /// Stops the app and starts it again on the same folders and address.
    pub async fn restart(&mut self) -> anyhow::Result<()> {
        self.stop().await;
        let listener = TcpListener::bind(self.addr)
            .await
            .with_context(|| format!("binding {} again", self.addr))?;
        self.running = Some(launch(&self.config, listener).await?);
        Ok(())
    }
}

impl Drop for TestApp {
    fn drop(&mut self) {
        if let Some(running) = self.running.take() {
            let _ = running.stop.send(());
        }
    }
}

async fn launch(config: &Config, listener: TcpListener) -> anyhow::Result<Running> {
    let server = Server::start(config).await?;
    let (stop, stopped) = oneshot::channel::<()>();
    let served = tokio::spawn(server.serve_with_shutdown(listener, async {
        let _ = stopped.await;
    }));
    Ok(Running { stop, served })
}
