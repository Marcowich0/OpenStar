//! Real capture (#205), as far as it can be checked without a sound
//! server: what the binary links. Capturing from a real interface is a
//! manual check (see `crates/mic-bridge/README.md`).

/// The libraries the binary needs at load time, by name.
fn needed() -> Vec<String> {
    let output = std::process::Command::new("readelf")
        .args(["--dynamic", env!("CARGO_BIN_EXE_openstar-mic-bridge")])
        .output()
        .expect("readelf (binutils) runs");
    assert!(output.status.success());
    String::from_utf8(output.stdout)
        .unwrap()
        .lines()
        .filter(|line| line.contains("(NEEDED)"))
        .filter_map(|line| Some(line.split_once('[')?.1.trim_end_matches(']').to_owned()))
        .collect()
}

#[test]
fn the_binary_links_only_glibc_and_the_system_pipewire_library() {
    let needed = needed();
    assert!(
        needed.iter().any(|l| l == "libpipewire-0.3.so.0"),
        "capture links libpipewire: {needed:?}"
    );
    for library in &needed {
        assert!(
            [
                "libc.so.6",
                "libm.so.6",
                "libgcc_s.so.1",
                "ld-linux-x86-64.so.2",
                "libpipewire-0.3.so.0",
            ]
            .contains(&library.as_str()),
            "{library} is linked: {needed:?}"
        );
    }
    assert!(
        needed.iter().all(|l| !l.contains("libpulse")),
        "no libpulse: {needed:?}"
    );
}
