#!/usr/bin/env bash
# Smoke test of a built OpenStar image: checks what the image promises
# (docs/docker-image.md). Usage: scripts/image-smoke.sh <image> <build id>
#
# It starts two containers (the default user, and `--user 99:100` as on
# Unraid) and removes them again with their volumes.
set -euo pipefail

image="${1:?usage: image-smoke.sh <image> <build id>}"
build_id="${2:?usage: image-smoke.sh <image> <build id>}"

fail() {
    echo "image-smoke: FAIL: $*" >&2
    exit 1
}
pass() { echo "image-smoke: ok: $*" >&2; }

# Every container this run starts is named openstar-smoke-<label>-<pid>; they
# are removed by that name (run_and_check runs in a subshell, so a list kept
# there would be lost), with their anonymous volumes.
cleanup() {
    # shellcheck disable=SC2086 # a list of temporary folders
    [ -z "${bridge_dirs:-}" ] || rm -rf $bridge_dirs
    docker ps -aq --filter "name=^openstar-smoke-.*-$$\$" | xargs -r docker rm -fv >/dev/null 2>&1 || true
}
trap cleanup EXIT

# Runs a command in a throwaway container of the image.
in_image() { docker run --rm --network none --entrypoint "$1" "$image" "${@:2}"; }

docker image inspect "$image" >/dev/null 2>&1 || fail "no image $image (build it with 'just image')"

# --- Image configuration -------------------------------------------------
platform="$(docker image inspect -f '{{.Os}}/{{.Architecture}}' "$image")"
[ "$platform" = linux/amd64 ] || fail "platform is $platform, not linux/amd64"
pass "platform linux/amd64"

user="$(docker image inspect -f '{{.Config.User}}' "$image")"
[ "$user" = 1000:1000 ] || fail "default user is '$user', not 1000:1000"
pass "default user 1000:1000"

volumes="$(docker image inspect -f '{{range $v, $_ := .Config.Volumes}}{{$v}} {{end}}' "$image")"
[ "$volumes" = "/appdata /songs " ] || fail "volumes are '$volumes', not /appdata and /songs"
pass "volumes /appdata and /songs"

entrypoint="$(docker image inspect -f '{{json .Config.Entrypoint}}{{json .Config.Cmd}}' "$image")"
case "$entrypoint" in
    *PUID* | *PGID* | *entrypoint.sh*) fail "the image has an entrypoint script: $entrypoint" ;;
esac
pass "entrypoint is the binary itself: $entrypoint"

health="$(docker image inspect -f '{{json .Config.Healthcheck.Test}}' "$image")"
[ "$health" = '["CMD","openstar","healthcheck"]' ] || fail "HEALTHCHECK is $health"
pass "HEALTHCHECK runs openstar healthcheck"

# --- Contents ------------------------------------------------------------
version="$(in_image openstar --version)"
[ "$version" = "$build_id" ] || fail "openstar --version prints '$version', not '$build_id'"
pass "openstar --version is $build_id"

# The Mic bridge folder is checked below; any other openstar* program is a
# second server binary.
binaries="$(in_image sh -c 'find / -xdev -path /usr/share/openstar/bridge -prune -o -type f -name "openstar*" -perm -u+x -print 2>/dev/null; true')"
[ "$binaries" = /usr/local/bin/openstar ] || fail "expected one openstar binary, found: $binaries"
pass "one server binary"

in_image sh -c '! command -v node && ! command -v nodejs && ! command -v pnpm' >/dev/null ||
    fail "Node or pnpm is in the runtime image"
pass "no Node in the runtime image"

# Outputs are captured before they are matched: under pipefail, a `grep -q`
# or `head` that closes the pipe early would fail the step.
for tool in "ffmpeg -version" "ffprobe -version" "yt-dlp --version" "deno --version"; do
    # shellcheck disable=SC2086 # the tool and its flag are two words
    out="$(in_image $tool)" || fail "$tool does not run"
    echo "${out%%$'\n'*}" >&2
done
encoders="$(in_image ffmpeg -hide_banner -encoders)"
[[ "$encoders" == *libx264* ]] || fail "ffmpeg has no libx264"
pass "ffmpeg, ffprobe, yt-dlp and deno run"

in_image test -s /etc/ssl/certs/ca-certificates.crt || fail "no system CA certificates (USDB needs TLS)"
pass "CA certificates for TLS"

# The Mic bridge of this very build (the Dockerfile's `bridge` stage), with
# the install script and the icon the server hands out under /bridge/.
bridge_files="$(in_image sh -c 'cd /usr/share/openstar/bridge && stat -c "%n %a %u:%g" * | sort')"
expected_bridge_files="install.sh 644 0:0
openstar-mic-bridge 755 0:0
openstar-mic-bridge.svg 644 0:0"
[ "$bridge_files" = "$expected_bridge_files" ] ||
    fail "/usr/share/openstar/bridge holds:"$'\n'"$bridge_files"$'\n'"expected:"$'\n'"$expected_bridge_files"
pass "Mic bridge folder: the bridge, install.sh and the icon"

# --- Running -------------------------------------------------------------
# The Mic bridge as a computer in the room gets it: fetched from the running
# server, checked against the served checksum, the same build identifier as
# the server, and started headless on a WAV file until the server asks for
# its approval on the Stage. It runs on this machine, outside the image.
check_bridge() {
    local label="$1" base="$2" dir
    dir="$(mktemp -d)"
    # Removed by the EXIT trap too, if a check fails.
    bridge_dirs="${bridge_dirs:-} $dir"
    (cd "$dir" &&
        curl -fsS -o openstar-mic-bridge "$base/bridge/openstar-mic-bridge" &&
        curl -fsS -o openstar-mic-bridge.sha256 "$base/bridge/openstar-mic-bridge.sha256") ||
        fail "$label: /bridge/openstar-mic-bridge or its .sha256 does not load"
    (cd "$dir" && sha256sum --check --strict --quiet openstar-mic-bridge.sha256) ||
        fail "$label: /bridge/openstar-mic-bridge does not match /bridge/openstar-mic-bridge.sha256"
    chmod +x "$dir/openstar-mic-bridge"
    local version
    version="$("$dir/openstar-mic-bridge" --version)" || fail "$label: the fetched bridge does not run"
    [ "$version" = "$build_id" ] || fail "$label: the bridge's --version is '$version', not the server's '$build_id'"
    pass "$label: /bridge/openstar-mic-bridge matches its checksum and is $build_id"

    local script
    script="$(curl -fsS "$base/bridge/install.sh")" || fail "$label: /bridge/install.sh does not load"
    [[ "$script" == "#!/bin/sh"*"$base"* ]] || fail "$label: /bridge/install.sh does not carry the address $base"
    local icon
    icon="$(curl -fsS -o /dev/null -w '%{http_code}' "$base/bridge/openstar-mic-bridge.svg")" || icon=failed
    [ "$icon" = 200 ] || fail "$label: /bridge/openstar-mic-bridge.svg answers $icon"
    pass "$label: serves install.sh with its own address, and the icon"

    # Two channels of a tone, made by the image's own ffmpeg.
    docker run --rm --network none --entrypoint sh "$image" -c \
        'ffmpeg -hide_banner -loglevel error -f lavfi -i "sine=frequency=220:duration=60" -ac 2 -ar 48000 /tmp/mics.wav && cat /tmp/mics.wav' \
        >"$dir/mics.wav" || fail "$label: ffmpeg in the image cannot write the test WAV"
    mkdir -p "$dir/config/openstar-mic-bridge"
    echo "$base" >"$dir/config/openstar-mic-bridge/server"
    env -i PATH="$PATH" HOME="$dir" XDG_CONFIG_HOME="$dir/config" \
        "$dir/openstar-mic-bridge" --wav "$dir/mics.wav" >"$dir/bridge.log" 2>&1 &
    local pid=$! waiting=""
    for _ in $(seq 1 100); do
        if grep -q "Waiting for approval on the Stage: code" "$dir/bridge.log"; then
            waiting=yes
            break
        fi
        kill -0 "$pid" 2>/dev/null || break
        sleep 0.2
    done
    kill "$pid" 2>/dev/null || true
    wait "$pid" 2>/dev/null || true
    if [ -z "$waiting" ]; then
        cat "$dir/bridge.log" >&2
        fail "$label: the headless bridge did not reach 'Waiting for approval' within 20 s"
    fi
    grep -q "Reading 2 channel(s) of mics.wav" "$dir/bridge.log" ||
        fail "$label: the headless bridge did not read the WAV's 2 channels"
    pass "$label: the bridge starts headless with --wav and waits for approval on the Stage"
}

# Starts a container with the given `docker run` options, waits for Docker
# to call it healthy, and checks the build id in its logs and server-info.
run_and_check() {
    local label="$1"
    shift
    local name="openstar-smoke-$label-$$"
    docker run -d --name "$name" \
        -e OPENSTAR_ADMIN_PIN=1234 -e OPENSTAR_PORT=8090 -e OPENSTAR_YTDLP_AUTOUPDATE=false \
        -p 127.0.0.1::8090 "$@" "$image" >/dev/null

    local status=""
    for _ in $(seq 1 60); do
        status="$(docker inspect -f '{{.State.Health.Status}}' "$name")"
        [ "$status" = healthy ] && break
        [ "$(docker inspect -f '{{.State.Running}}' "$name")" = true ] || break
        sleep 1
    done
    if [ "$status" != healthy ]; then
        docker logs "$name" >&2 || true
        fail "$label: container is '$status', not healthy, after 60 s"
    fi
    pass "$label: Docker reports healthy"

    local port
    port="$(docker port "$name" 8090/tcp | head -n 1 | sed 's/.*://')"
    local health
    health="$(curl -fsS -o /dev/null -w '%{http_code}' "http://127.0.0.1:$port/healthz")" ||
        fail "$label: /healthz does not answer"
    [ "$health" = 200 ] || fail "$label: /healthz answers $health"
    pass "$label: /healthz answers 200"

    local info
    info="$(curl -fsS "http://127.0.0.1:$port/api/server-info")"
    [[ "$info" == *"\"version\":\"$build_id\""* ]] || fail "$label: server-info is $info"
    pass "$label: server-info names $build_id"

    local page
    page="$(curl -fsS "http://127.0.0.1:$port/")"
    [[ "$page" == *'<script type="module"'* ]] || fail "$label: / does not serve the frontend"
    pass "$label: serves the embedded frontend"

    # The pitch-detection worklet and the detector's WASM (#105) are build
    # assets the server itself serves: follow the JS chunks from the page.
    local base="http://127.0.0.1:$port" queue seen js worklet="" wasm=""
    queue="$(grep -oE '/assets/[A-Za-z0-9_.-]+\.js' <<<"$page" | sort -u)"
    seen=""
    while [ -n "$queue" ]; do
        js="${queue%%$'\n'*}"
        [ "$js" = "$queue" ] && queue="" || queue="${queue#*$'\n'}"
        [[ " $seen " == *" $js "* ]] && continue
        seen="$seen $js"
        local code
        code="$(curl -fsS "$base$js")" || fail "$label: $js does not load"
        [[ "$js" == /assets/pitchProcessor-* ]] && worklet="$js"
        local found
        found="$(grep -oE '/?assets/[A-Za-z0-9_.-]+\.(js|wasm)' <<<"$code" | sed 's|^assets|/assets|' | sort -u || true)"
        for f in $found; do
            case "$f" in
                *.wasm) wasm="$f" ;;
                *) [[ " $seen " == *" $f "* ]] || queue="${queue:+$queue$'\n'}$f" ;;
            esac
        done
    done
    [ -n "$worklet" ] || fail "$label: the app references no pitchProcessor worklet"
    [ -n "$wasm" ] || fail "$label: the app references no detector WASM"
    local wasm_type
    wasm_type="$(curl -fsS -o /dev/null -w '%{content_type}' "$base$wasm")" || fail "$label: $wasm does not load"
    [ "$wasm_type" = application/wasm ] || fail "$label: $wasm is served as '$wasm_type'"
    # Saved first: under pipefail, `head` closing the pipe would fail curl.
    local body magic
    body="$(mktemp)"
    curl -fsS -o "$body" "$base$wasm" || fail "$label: $wasm does not load"
    magic="$(od -An -tx1 -N4 "$body" | tr -d ' ')"
    rm -f "$body"
    [ "$magic" = 0061736d ] || fail "$label: $wasm is not a WASM module"
    pass "$label: serves the pitch worklet $worklet and the detector $wasm"

    [ "$label" = default ] && check_bridge "$label" "$base"

    local logs
    logs="$(docker logs "$name" 2>&1)"
    [[ "$logs" == *"OpenStar is serving"*"version=\"$build_id\""* ]] || fail "$label: logs do not name $build_id"
    pass "$label: logs name $build_id"

    local who
    who="$(docker exec "$name" id -u):$(docker exec "$name" id -g)"
    echo "$who"
}

who="$(run_and_check default | tail -n 1)"
[ "$who" = 1000:1000 ] || fail "default container runs as $who"
pass "default container runs as 1000:1000"

# Unraid: the shares belong to 99:100 and the container runs as that user.
who="$(run_and_check unraid --user 99:100 \
    --tmpfs /appdata:rw,uid=99,gid=100,mode=0755 \
    --tmpfs /songs:rw,uid=99,gid=100,mode=0755 | tail -n 1)"
[ "$who" = 99:100 ] || fail "--user 99:100 container runs as $who"
deno_out="$(docker exec "openstar-smoke-unraid-$$" deno eval 'console.log("deno ok")')"
[ "$deno_out" = "deno ok" ] ||
    fail "deno cannot run as 99:100"
docker exec "openstar-smoke-unraid-$$" yt-dlp --version >/dev/null || fail "yt-dlp cannot run as 99:100"
pass "--user 99:100 starts, and deno and yt-dlp run as it"

echo "image-smoke: all checks passed for $image ($build_id)"
