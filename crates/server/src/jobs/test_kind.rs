//! The test job kind: a harmless `sh` child that counts steps, so tests can
//! prove the runner without ffmpeg or yt-dlp. Only the test-only
//! `POST /api/test/jobs` starts it.

use openstar_protocol::UserMessage;
use serde::{Deserialize, Serialize};

use super::{JobContext, Lane};

/// Counts `steps` steps, `step_ms` apart, printing each; then exits with
/// `exit_code`. With `marker_dir` set, the child first writes into that
/// folder its PID (`pid`), its niceness (`nice`) and one line per start (`runs`).
/// A real kind has one fixed lane and one [`AfterRestart`] rule; the test kind
/// takes both from its parameters so tests can cover every lane and rule.
///
/// [`AfterRestart`]: super::AfterRestart
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TestJob {
    /// The test kind runs in any lane; a real kind always runs in its own.
    pub lane: Lane,
    pub steps: u32,
    pub step_ms: u32,
    #[serde(default)]
    pub exit_code: i32,
    #[serde(default)]
    pub marker_dir: Option<String>,
    /// Fail after a restart ([`AfterRestart::Fail`](super::AfterRestart::Fail))
    /// instead of starting again.
    #[serde(default)]
    pub fails_after_restart: bool,
}

const SCRIPT: &str = r#"
dir=$1 steps=$2 pause=$3 code=$4
if [ -n "$dir" ]; then
  mkdir -p "$dir"
  echo $$ > "$dir/pid"
  nice > "$dir/nice"
  echo start >> "$dir/runs"
fi
i=0
while [ "$i" -lt "$steps" ]; do
  i=$((i + 1))
  echo "$i"
  if [ "$pause" != 0 ]; then sleep "$pause"; fi
done
exit "$code"
"#;

impl TestJob {
    pub(super) async fn run(self, ctx: &mut JobContext) -> Result<(), UserMessage> {
        let steps = u64::from(self.steps.max(1));
        let pause = if self.step_ms == 0 {
            "0".to_owned()
        } else {
            format!("{}.{:03}", self.step_ms / 1000, self.step_ms % 1000)
        };
        let progress = &ctx.progress;
        ctx.slot
            .command("sh")
            .arg("-c")
            .arg(SCRIPT)
            .arg("sh")
            .arg(self.marker_dir.unwrap_or_default())
            .arg(self.steps.to_string())
            .arg(pause)
            .arg(self.exit_code.to_string())
            .run_lines(|line| {
                if let Ok(step) = line.trim().parse::<u64>() {
                    progress.report(u8::try_from(step * 100 / steps).unwrap_or(100));
                }
            })
            .await
    }
}
