//! The build identifier: `X.Y.Z` for a release build from tag `vX.Y.Z`,
//! `edge-<sha>` for a build from `main`, `dev` for anything else.
//!
//! `build.rs` includes this file too and sets the result as
//! `OPENSTAR_BUILD_ID` at compile time, which [`crate::BUILD_ID`] reads.

/// What the build knows about where it comes from.
#[derive(Debug, Clone, Copy, Default)]
pub struct BuildSource<'a> {
    /// `OPENSTAR_BUILD_ID`, set explicitly (for example by a Docker build arg).
    pub explicit: Option<&'a str>,
    /// The git ref being built, as in `GITHUB_REF` (`refs/tags/v1.2.3`, `refs/heads/main`).
    pub git_ref: Option<&'a str>,
    /// The full commit SHA, as in `GITHUB_SHA`.
    pub sha: Option<&'a str>,
}

/// Length of the SHA in `edge-<sha>`, matching the `:sha-<short>` image tag.
pub const SHORT_SHA_LEN: usize = 7;

/// Works out the build identifier. An explicit identifier wins; it must
/// itself be a valid one.
pub fn build_id(source: BuildSource<'_>) -> Result<String, String> {
    if let Some(explicit) = source.explicit.filter(|id| !id.is_empty()) {
        return if is_valid(explicit) {
            Ok(explicit.to_owned())
        } else {
            Err(format!(
                "OPENSTAR_BUILD_ID must be X.Y.Z, edge-<sha> or dev, got {explicit:?}"
            ))
        };
    }
    if let Some(version) = source
        .git_ref
        .and_then(|r| r.strip_prefix("refs/tags/v"))
        .filter(|v| is_version(v))
    {
        return Ok(version.to_owned());
    }
    if source.git_ref == Some("refs/heads/main")
        && let Some(sha) = source.sha.filter(|s| s.len() >= SHORT_SHA_LEN && is_hex(s))
    {
        return Ok(format!(
            "edge-{}",
            sha[..SHORT_SHA_LEN].to_ascii_lowercase()
        ));
    }
    Ok("dev".to_owned())
}

/// Whether `id` is a build identifier: `X.Y.Z`, `edge-<hex sha>` or `dev`.
pub fn is_valid(id: &str) -> bool {
    id == "dev"
        || is_version(id)
        || id
            .strip_prefix("edge-")
            .is_some_and(|sha| sha.len() >= SHORT_SHA_LEN && is_hex(sha))
}

fn is_version(text: &str) -> bool {
    let parts: Vec<&str> = text.split('.').collect();
    parts.len() == 3
        && parts
            .iter()
            .all(|p| !p.is_empty() && p.bytes().all(|b| b.is_ascii_digit()))
}

fn is_hex(text: &str) -> bool {
    text.bytes().all(|b| b.is_ascii_hexdigit())
}

#[cfg(test)]
mod tests {
    use super::*;

    const SHA: &str = "ee9c270a1b2c3d4e5f60718293a4b5c6d7e8f901";

    fn id(explicit: Option<&str>, git_ref: Option<&str>, sha: Option<&str>) -> String {
        build_id(BuildSource {
            explicit,
            git_ref,
            sha,
        })
        .unwrap()
    }

    #[test]
    fn a_release_tag_gives_the_bare_version() {
        assert_eq!(id(None, Some("refs/tags/v1.4.0"), Some(SHA)), "1.4.0");
        assert_eq!(id(None, Some("refs/tags/v10.0.12"), None), "10.0.12");
    }

    #[test]
    fn main_gives_edge_and_the_short_sha() {
        assert_eq!(id(None, Some("refs/heads/main"), Some(SHA)), "edge-ee9c270");
    }

    #[test]
    fn anything_else_is_dev() {
        assert_eq!(id(None, None, None), "dev");
        assert_eq!(id(None, Some("refs/heads/ticket/60"), Some(SHA)), "dev");
        assert_eq!(id(None, Some("refs/pull/7/merge"), Some(SHA)), "dev");
        assert_eq!(id(None, Some("refs/tags/v1.4"), Some(SHA)), "dev");
        assert_eq!(id(None, Some("refs/tags/release-1"), Some(SHA)), "dev");
        assert_eq!(id(None, Some("refs/heads/main"), None), "dev");
    }

    #[test]
    fn an_explicit_identifier_wins_when_it_is_valid() {
        assert_eq!(
            id(Some("2.0.1"), Some("refs/heads/main"), Some(SHA)),
            "2.0.1"
        );
        assert_eq!(id(Some("edge-abc1234"), None, None), "edge-abc1234");
        assert_eq!(id(Some(""), Some("refs/tags/v1.0.0"), None), "1.0.0");
        for bad in ["v1.2.3", "latest", "edge-", "edge-xyz1234", "1.2"] {
            let error = build_id(BuildSource {
                explicit: Some(bad),
                ..BuildSource::default()
            })
            .unwrap_err();
            assert!(error.contains("OPENSTAR_BUILD_ID"), "{bad}: {error}");
        }
    }
}
