use std::path::Path;
use std::process::ExitCode;

use anyhow::Context;
use openstar::{Config, Server};
use tracing_subscriber::EnvFilter;

const USAGE: &str = "usage: openstar [healthcheck | corpus <path> | --version]
  (no argument)  run the server, configured by OPENSTAR_* environment variables
  healthcheck    exit 0 when /healthz on OPENSTAR_PORT answers success
  corpus <path>  parse every Song text in the Library at <path> and check that
                 writing it unedited gives back its bytes (writes nothing);
                 exit 1 on any crash or mismatch
  --version      print the build identifier";

#[tokio::main]
async fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let result = match args
        .iter()
        .map(String::as_str)
        .collect::<Vec<_>>()
        .as_slice()
    {
        [] => serve().await,
        ["healthcheck"] => healthcheck().await,
        ["corpus", path] => return corpus(Path::new(path)),
        ["--version" | "-V"] => {
            println!("{}", openstar::BUILD_ID);
            Ok(())
        }
        ["--help" | "-h"] => {
            println!("{USAGE}");
            Ok(())
        }
        _ => {
            eprintln!("{USAGE}");
            return ExitCode::from(2);
        }
    };
    match result {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("OpenStar: {error:#}");
            ExitCode::FAILURE
        }
    }
}

/// `just corpus <path>`: the report on stdout, exit 1 on a crash, a
/// mismatch or a Library that cannot be listed.
fn corpus(path: &Path) -> ExitCode {
    match openstar::corpus::run(path) {
        Ok(report) => {
            println!("{report}");
            if report.passed() {
                ExitCode::SUCCESS
            } else {
                ExitCode::FAILURE
            }
        }
        Err(error) => {
            eprintln!(
                "OpenStar: cannot list the Library at {}: {error:#}",
                path.display()
            );
            ExitCode::FAILURE
        }
    }
}

async fn healthcheck() -> anyhow::Result<()> {
    let port = Config::port_from_vars(|name| std::env::var(name).ok())?;
    openstar::healthcheck::check(port).await
}

/// Startup in the spec's order: configuration, then (inside
/// [`Server::start`]) appdata, database, songs and live state, then serving.
async fn serve() -> anyhow::Result<()> {
    let config = Config::from_env().context("cannot start: the configuration is invalid")?;

    // Plain text on stdout, no colours: `docker logs` shows it as it is.
    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::try_new(&config.log)?)
        .with_ansi(false)
        .with_writer(std::io::stdout)
        .init();
    tracing::info!(
        version = openstar::BUILD_ID,
        port = config.port,
        appdata_dir = %config.appdata_dir.display(),
        songs_dir = %config.songs_dir.display(),
        public_url = config.public_url.as_deref().unwrap_or("(not set)"),
        usdb_login = config.usdb.is_some(),
        ytdlp_autoupdate = config.ytdlp_autoupdate,
        "configuration read"
    );

    let server = Server::start(&config).await.context("cannot start")?;
    let listener = tokio::net::TcpListener::bind(("0.0.0.0", config.port))
        .await
        .with_context(|| format!("cannot start: listening on port {}", config.port))?;
    tracing::info!(
        port = config.port,
        version = openstar::BUILD_ID,
        "OpenStar is serving"
    );
    server
        .serve_with_shutdown(listener, shutdown_signal())
        .await?;
    Ok(())
}

async fn shutdown_signal() {
    let ctrl_c = async {
        let _ = tokio::signal::ctrl_c().await;
    };
    let terminate = async {
        match tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) {
            Ok(mut signal) => {
                signal.recv().await;
            }
            Err(_) => std::future::pending().await,
        }
    };
    tokio::select! {
        () = ctrl_c => {},
        () = terminate => {},
    }
    tracing::info!("shutting down");
}
