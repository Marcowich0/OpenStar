//! Sets `OPENSTAR_BUILD_ID` for the bridge at compile time, with the
//! server's own rule (`crates/server/src/build_id.rs`), so a bridge and a
//! server built together report the same identifier.

#[path = "../server/src/build_id.rs"]
mod build_id;

fn main() {
    println!("cargo::rerun-if-changed=build.rs");
    println!("cargo::rerun-if-changed=../server/src/build_id.rs");
    for name in ["OPENSTAR_BUILD_ID", "GITHUB_REF", "GITHUB_SHA"] {
        println!("cargo::rerun-if-env-changed={name}");
    }
    let explicit = std::env::var("OPENSTAR_BUILD_ID").ok();
    let git_ref = std::env::var("GITHUB_REF").ok();
    let sha = std::env::var("GITHUB_SHA").ok();
    let id = build_id::build_id(build_id::BuildSource {
        explicit: explicit.as_deref(),
        git_ref: git_ref.as_deref(),
        sha: sha.as_deref(),
    })
    .unwrap_or_else(|error| panic!("{error}"));
    println!("cargo::rustc-env=OPENSTAR_BUILD_ID={id}");
}
