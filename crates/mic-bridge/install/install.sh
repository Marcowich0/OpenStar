#!/bin/sh
# Installs the OpenStar Mic bridge for the current user, from the OpenStar
# server that serves this script at /bridge/install.sh. The server fills in
# its own address below, so the Stage's one-line install is:
#
#   curl -fsSL <address>/bridge/install.sh | sh
#
# Safe to run again: it is also the repair command. It
#   1. downloads the bridge, checks it against the server's SHA-256 and puts
#      it in ~/.local/bin/openstar-mic-bridge;
#   2. writes the app-menu entry and its icon;
#   3. writes the server address into ~/.config/openstar-mic-bridge/,
#      replacing any old one (the approval token there is kept);
#   4. starts the bridge.
# It adds no autostart entry: the bridge works only while its window is open.
# `openstar-mic-bridge --uninstall` removes everything it installed.

set -eu

server='@OPENSTAR_SERVER@'

say() {
    printf 'OpenStar Mic bridge: %s\n' "$*"
}

fail() {
    printf 'OpenStar Mic bridge: %s\n' "$*" >&2
    exit 1
}

case $server in
    http://?* | https://?*) ;;
    *) fail "this copy of the script has no server address: run the install command shown on the Stage's Mics screen" ;;
esac

[ -n "${HOME:-}" ] || fail "HOME is not set"
command -v curl >/dev/null 2>&1 || fail "curl is needed"
command -v sha256sum >/dev/null 2>&1 || fail "sha256sum is needed"

# An XDG base directory, when it is set to an absolute path; otherwise $2.
base_dir() {
    case ${1:-} in
        /*) printf '%s' "$1" ;;
        *) printf '%s' "$2" ;;
    esac
}

data_home=$(base_dir "${XDG_DATA_HOME:-}" "$HOME/.local/share")
config_home=$(base_dir "${XDG_CONFIG_HOME:-}" "$HOME/.config")

bin=$HOME/.local/bin/openstar-mic-bridge
desktop=$data_home/applications/openstar-mic-bridge.desktop
icon=$data_home/icons/hicolor/scalable/apps/openstar-mic-bridge.svg
config_dir=$config_home/openstar-mic-bridge

# Every file is written beside its target first and renamed into place, so a
# failed run never leaves half a file. The one being written is removed on exit.
partial=
trap 'if [ -n "$partial" ]; then rm -f "$partial"; fi' EXIT
trap 'exit 1' HUP INT TERM

# begin <target>: a new partial file beside <target>, in $partial.
begin() {
    mkdir -p "$(dirname "$1")"
    partial=$(mktemp "$(dirname "$1")/.openstar-mic-bridge.XXXXXX")
}

# finish <target>: renames the partial file onto <target>.
finish() {
    mv -f "$partial" "$1"
    partial=
}

fetch() {
    curl -fsSL "$server/bridge/$1"
}

# 1. The bridge, checked before it is installed.
say "downloading the Mic bridge from $server"
expected=$(fetch openstar-mic-bridge.sha256) || fail "could not download the checksum from $server"
expected=${expected%%[!0-9a-f]*}
[ ${#expected} -eq 64 ] || fail "the server sent no SHA-256 checksum"
begin "$bin"
fetch openstar-mic-bridge >"$partial" || fail "could not download the Mic bridge from $server"
actual=$(sha256sum "$partial")
actual=${actual%% *}
if [ "$actual" != "$expected" ]; then
    fail "the download does not match the server's SHA-256 checksum; nothing was installed"
fi
chmod 755 "$partial"
finish "$bin"

# 2. The app-menu entry and its icon.
begin "$icon"
fetch openstar-mic-bridge.svg >"$partial" || fail "could not download the icon from $server"
chmod 644 "$partial"
finish "$icon"

begin "$desktop"
cat >"$partial" <<EOF
[Desktop Entry]
Type=Application
Name=OpenStar Mic bridge
Comment=Sends the mics wired to this computer to the OpenStar Stage
Exec="$bin"
Icon=$icon
Terminal=false
Categories=AudioVideo;Audio;
EOF
chmod 644 "$partial"
finish "$desktop"

# 3. The server address: one bridge talks to one server.
begin "$config_dir/server"
printf '%s\n' "$server" >"$partial"
finish "$config_dir/server"

say "installed $bin"

# 4. Start it, away from this shell, when there is a desktop to show it on.
if [ -n "${DISPLAY:-}${WAYLAND_DISPLAY:-}" ]; then
    nohup "$bin" </dev/null >/dev/null 2>&1 &
    say "started; next time, open it from the app menu"
else
    say "no desktop session here: open OpenStar Mic bridge from the app menu"
fi
