#!/usr/bin/env bash
# A stand-in for yt-dlp in OpenStar's tests. Never downloads anything.
#
# Lives in its own folder, put first on PATH. Next to it:
#   calls/NNNNNN.args  one file per call, the arguments separated by NUL bytes;
#   behaviours         one line per scripted call, used up in order:
#                        fail <exit code> <message for stderr>
#                        hang
#                        delay <seconds>  (waits, then succeeds)
#                      With no line left, the call succeeds.
#   calls/NNNNNN.span  "<start> <end>" in Unix seconds, once the call exits.
#   calls/NNNNNN.pid   the call's process id (a hanging call keeps it).
#
# On success it writes tiny generated media (made with ffmpeg) where -o/--output
# and -P/--paths ask: audio with -x/--extract-audio (format from --audio-format,
# default m4a), else a tiny video (format from --merge-output-format or
# --remux-video, default mp4). -j/--dump-json prints one JSON line per URL
# instead and writes nothing: for a `ytsearchN:<query>` URL, N flat search hits
# (`stubsearch1` ...), as with --flat-playlist (no match filter is applied).
# With --progress-template, a download prints progress lines as the
# template asks (`percent|speed|eta`, the Download's template) before
# writing. --version prints a stub version.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
mkdir -p "$here/calls"
started="$(date +%s.%N)"

{
    flock 9
    count=$(find "$here/calls" -name '*.args' | wc -l)
    call="$(printf '%06d' "$((count + 1))")"
    printf '%s\0' "$@" >"$here/calls/$call.args"
    behaviour=""
    if [[ -s "$here/behaviours" ]]; then
        behaviour="$(head -n 1 "$here/behaviours")"
        tail -n +2 "$here/behaviours" >"$here/behaviours.next"
        mv "$here/behaviours.next" "$here/behaviours"
    fi
} 9>"$here/calls/.lock"
echo "$$" >"$here/calls/$call.pid"
trap 'printf "%s %s\n" "$started" "$(date +%s.%N)" >"$here/calls/$call.span"' EXIT

case "$behaviour" in
fail\ *)
    rest="${behaviour#fail }"
    code="${rest%% *}"
    message="${rest#* }"
    echo "$message" >&2
    exit "$code"
    ;;
hang)
    exec sleep 2147483647
    ;;
delay\ *)
    sleep "${behaviour#delay }"
    ;;
esac

output_template='%(title)s [%(id)s].%(ext)s'
home_path=""
extract_audio=false
audio_format=m4a
video_format=mp4
dump_json=false
progress=false
urls=()
while [[ $# -gt 0 ]]; do
    case "$1" in
    --version) echo "2099.01.01-openstar-stub"; exit 0 ;;
    -o | --output) output_template="$2"; shift ;;
    -P | --paths) home_path="${2#home:}"; shift ;;
    -x | --extract-audio) extract_audio=true ;;
    --audio-format) audio_format="$2"; shift ;;
    --merge-output-format | --remux-video) video_format="$2"; shift ;;
    -j | --dump-json) dump_json=true ;;
    --progress-template) progress=true; shift ;;
    # Options that take a value, so the value is not read as a URL.
    -f | --format | -S | --format-sort | --progress-template | --extractor-args | \
        --cookies | --user-agent | --referer | --add-header | -r | --limit-rate | \
        --retries | --socket-timeout | --ffmpeg-location | --match-filter | -I | \
        --playlist-items | --print | -O | --exec | --postprocessor-args | --ppa) shift ;;
    -*) ;;
    *) urls+=("$1") ;;
    esac
    shift
done

json_string() {
    local text="${1//\\/\\\\}"
    printf '"%s"' "${text//\"/\\\"}"
}

if $dump_json; then
    thumbnail='data:image/gif;base64,R0lGODlhAQABAIAAAP///wAAACwAAAAAAQABAAACAkQBADs='
    n=0
    for url in "${urls[@]}"; do
        if [[ "$url" =~ ^ytsearch([0-9]*):(.*)$ ]]; then
            hits="${BASH_REMATCH[1]:-1}"
            query="${BASH_REMATCH[2]}"
            for ((k = 1; k <= hits; k++)); do
                printf '{"_type":"url","ie_key":"Youtube","id":"stubsearch%s","url":"https://www.youtube.com/watch?v=stubsearch%s","title":%s,"duration":%s,"thumbnails":[{"url":"%s"}]}\n' \
                    "$k" "$k" "$(json_string "$query (stub hit $k)")" "$((170 + k))" "$thumbnail"
            done
            continue
        fi
        n=$((n + 1))
        printf '{"id":"stub%s","title":"Stub video %s","webpage_url":%s,"duration":2,"ext":"mp4","thumbnail":"%s"}\n' \
            "$n" "$n" "$(json_string "$url")" "$thumbnail"
    done
    exit 0
fi

if $extract_audio; then ext="$audio_format"; else ext="$video_format"; fi
path="${output_template//%(ext)s/$ext}"
path="${path//%(id)s/stub}"
path="${path//%(title)s/stub}"
if [[ -n "$home_path" && "$path" != /* ]]; then path="$home_path/$path"; fi
mkdir -p "$(dirname "$path")"

echo "[download] Destination: $path"
if $progress; then
    echo "  0.0%|Unknown B/s|Unknown"
    echo " 50.0%|  1.00MiB/s|00:01"
    echo "100.0%|  2.00MiB/s|00:00"
fi
if $extract_audio; then
    ffmpeg -hide_banner -loglevel error -nostdin -y \
        -f lavfi -i "sine=frequency=440:sample_rate=44100:duration=1" "$path"
else
    ffmpeg -hide_banner -loglevel error -nostdin -y \
        -f lavfi -i "testsrc=size=64x36:rate=10:duration=1" \
        -f lavfi -i "sine=frequency=440:sample_rate=44100:duration=1" \
        -pix_fmt yuv420p -shortest "$path"
fi
echo "[download] 100% of 1.00KiB"
