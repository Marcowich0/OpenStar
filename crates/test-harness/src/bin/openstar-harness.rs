//! The fake USDB and the yt-dlp stub as standalone processes, for `just e2e`.
//!
//! ```text
//! openstar-harness fake-usdb [--port <port>] [--fixtures <dir>]
//!     Serves the saved USDB pages on 127.0.0.1 (port 0, the default, picks a
//!     free one), prints its base URL as the first line on stdout, and runs
//!     until killed. GET /__fake/requests and POST /__fake/script read and
//!     script it.
//! openstar-harness ytdlp-stub <dir>
//!     Installs the stub as <dir>/yt-dlp; put <dir> first on the PATH of the
//!     binary under test. Its calls are recorded in <dir>/calls/.
//! ```

use std::io::Write;
use std::net::{Ipv4Addr, SocketAddr};
use std::path::PathBuf;

use anyhow::{Context, bail};
use openstar_test_harness::{FakeUsdb, YtDlpStub};

const USAGE: &str = "usage: openstar-harness fake-usdb [--port <port>] [--fixtures <dir>]\n       \
                     openstar-harness ytdlp-stub <dir>";

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let mut args = std::env::args().skip(1);
    match args.next().as_deref() {
        Some("fake-usdb") => {
            let mut port = 0u16;
            let mut fixtures = FakeUsdb::default_fixtures();
            while let Some(flag) = args.next() {
                let value = args
                    .next()
                    .with_context(|| format!("{flag} needs a value"))?;
                match flag.as_str() {
                    "--port" => port = value.parse().context("--port must be a port number")?,
                    "--fixtures" => fixtures = PathBuf::from(value),
                    _ => bail!("unknown option {flag}\n{USAGE}"),
                }
            }
            let usdb = FakeUsdb::serve(fixtures, SocketAddr::from((Ipv4Addr::LOCALHOST, port)))
                .await
                .context("starting the fake USDB")?;
            let mut stdout = std::io::stdout();
            writeln!(stdout, "{}", usdb.base_url())?;
            stdout.flush()?;
            usdb.wait().await;
            Ok(())
        }
        Some("ytdlp-stub") => {
            let dir = args.next().context(USAGE)?;
            let path = YtDlpStub::install(&PathBuf::from(dir)).context("installing the stub")?;
            println!("{}", path.display());
            Ok(())
        }
        _ => bail!("{USAGE}"),
    }
}
