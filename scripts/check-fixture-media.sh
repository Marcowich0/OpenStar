#!/usr/bin/env bash
# Refuses audio and video files under fixtures/ unless a directory between the
# file and fixtures/ (its own directory or a parent below fixtures/) holds an
# ATTRIBUTION.md. Run from the repository root by `just fixtures-check`.
#
# It looks at every file git would commit: tracked files, and untracked ones
# that .gitignore does not exclude. Media generated at test time belongs in an
# ignored directory. See fixtures/README.md for the rules.
set -euo pipefail

media_extensions='3gp aac aif aifc aiff amr ape au avi caf flac flv m2ts m4a m4b m4v mid midi mka mkv mov mp2 mp3 mp4 mpeg mpg oga ogg ogv opus ra spx vob wav weba webm wma wmv wv'

is_media() {
  local path="$1" ext
  ext="${path##*.}"
  ext="${ext,,}"
  if [[ "$path" == *.* && " $media_extensions " == *" $ext "* ]]; then
    return 0
  fi
  # Catch media under another extension by its content.
  [[ -f "$path" ]] || return 1
  case "$(file --brief --mime-type -- "$path")" in
    audio/* | video/*) return 0 ;;
  esac
  return 1
}

has_attribution() {
  local dir
  dir="$(dirname "$1")"
  while [[ "$dir" == fixtures/* ]]; do
    [[ -f "$dir/ATTRIBUTION.md" ]] && return 0
    dir="$(dirname "$dir")"
  done
  return 1
}

refused=()
while IFS= read -r -d '' path; do
  if is_media "$path" && ! has_attribution "$path"; then
    refused+=("$path")
  fi
done < <(git ls-files -z --cached --others --exclude-standard -- fixtures | sort -zu)

if [[ ${#refused[@]} -gt 0 ]]; then
  echo "Audio or video under fixtures/ without an ATTRIBUTION.md in its directory tree:" >&2
  printf '  %s\n' "${refused[@]}" >&2
  echo "Generate media at test time into a git-ignored directory, or commit only openly licensed media next to an ATTRIBUTION.md (see fixtures/README.md)." >&2
  exit 1
fi
