#!/usr/bin/env bash
# The fast inner loop (`just quick`): the checks that cover the files changed
# since the merge base with `base` (default origin/main), committed or not,
# plus untracked files. It is not a replacement for `just check`, which still
# runs before every push; it only skips what the change cannot affect.
#
# - Rust (crates/, Cargo.toml, Cargo.lock): rustfmt and clippy on the whole
#   workspace (cached crates cost nothing), and the tests of each changed crate
#   and of every workspace crate that depends on it. A root Cargo.toml or
#   Cargo.lock change tests the whole workspace.
# - crates/protocol: the generated-types drift check.
# - web/: ESLint on the changed files, tsc on the project, and the Vitest tests
#   related to the changed files (`vitest related`). A change to the detector,
#   the capture clock or the detector's WASM crate runs every Vitest test,
#   since the pitch worklet tests load the WASM build.
# - e2e/: the e2e suite's ESLint and tsc (not the browser run; that is
#   `just e2e`). fixtures/: the fixture guard.
# - Prettier on every changed file it knows.
# - Anything else (scripts/, .github/, the Dockerfile, compose files,
#   renovate.json, the Mic bridge install script) is named at the end as
#   covered by `just check` only.
#
# Usage: scripts/quick-check.sh [base]. Needs git and jq.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root"
base="${1:-origin/main}"

merge_base="$(git merge-base "$base" HEAD)"
mapfile -t changed < <(
  {
    git diff --name-only "$merge_base"
    git ls-files --others --exclude-standard
  } | sort -u
)
# Deleted files are part of the change but cannot be linted or formatted.
existing=()
for f in "${changed[@]}"; do
  [ -e "$f" ] && existing+=("$f")
done

if [ "${#changed[@]}" -eq 0 ]; then
  echo "quick: nothing changed since $base"
  exit 0
fi
echo "quick: ${#changed[@]} file(s) changed since $base ($(git rev-parse --short "$merge_base"))"

step() { printf '\n== %s\n' "$*"; }

rust_all=0
web_all=0
declare -A crate_dirs=()
web_files=()
others=()
e2e=0
fixtures=0
protocol=0
for f in "${changed[@]}"; do
  case "$f" in
    # compose-check holds docs/deployment.md to the compose files and settings.
    docs/deployment.md) others+=("$f") ;;
    *.md) ;;
    Cargo.toml | Cargo.lock | rust-toolchain.toml | .cargo/*) rust_all=1 ;;
    crates/mic-bridge/install/*) others+=("$f") ;;
    crates/*/*)
      dir="${f#crates/}"
      dir="${dir%%/*}"
      crate_dirs[$dir]=1
      case "$dir" in
        protocol) protocol=1 ;;
        detector | detector-wasm | capture-clock) web_all=1 ;;
      esac
      ;;
    web/*) web_files+=("${f#web/}") ;;
    e2e/*) e2e=1 ;;
    fixtures/*) fixtures=1 ;;
    *) others+=("$f") ;;
  esac
done

# Workspace packages to test: the changed crates and, transitively, every
# workspace crate that depends on one of them (dev-dependencies included).
packages=()
if [ "$rust_all" -eq 0 ] && [ "${#crate_dirs[@]}" -gt 0 ]; then
  metadata="$(cargo metadata --format-version 1 --no-deps --locked)"
  dirs_json="$(printf '%s\n' "${!crate_dirs[@]}" | jq -R . | jq -s .)"
  mapfile -t packages < <(jq -r --argjson dirs "$dirs_json" --arg root "$root/crates/" '
    [.packages[] | {name, dir: (.manifest_path | ltrimstr($root) | split("/")[0]),
                    deps: [.dependencies[] | select(.path != null) | .name]}] as $pkgs
    | [$pkgs[] | select(.dir as $d | $dirs | index($d)) | .name] as $start
    | {set: $start, grew: true}
    | until(.grew | not;
        .set as $s
        | ([$pkgs[] | select(any(.deps[]; . as $d | $s | index($d))) | .name] + $s | unique) as $next
        | {set: $next, grew: (($next | length) > ($s | length))})
    | .set[]' <<<"$metadata")
fi

if [ "$rust_all" -eq 1 ] || [ "${#packages[@]}" -gt 0 ]; then
  step "rustfmt"
  cargo fmt --all --check
  step "clippy (workspace)"
  cargo clippy --workspace --all-targets --locked -- -D warnings
  if [ "$rust_all" -eq 1 ]; then
    step "cargo test (workspace: Cargo.toml, Cargo.lock or the toolchain changed)"
    cargo test --workspace --locked
  else
    step "cargo test: ${packages[*]}"
    cargo test --locked "${packages[@]/#/--package=}"
  fi
fi

if [ "$protocol" -eq 1 ] || [ "$rust_all" -eq 1 ]; then
  step "generated-types drift check"
  just drift-check
fi

if [ "${#web_files[@]}" -gt 0 ] || [ "$web_all" -eq 1 ]; then
  just web-install wasm
  lintable=()
  for f in "${web_files[@]}"; do
    case "$f" in
      *.ts | *.tsx | *.js | *.mjs) [ -e "web/$f" ] && lintable+=("$f") ;;
    esac
  done
  if [ "${#lintable[@]}" -gt 0 ]; then
    step "eslint: ${#lintable[@]} file(s)"
    pnpm --dir web exec eslint --max-warnings 0 --no-warn-ignored "${lintable[@]}"
  fi
  step "tsc"
  pnpm --dir web typecheck
  if [ "$web_all" -eq 1 ]; then
    step "vitest (all: the detector or capture clock changed)"
    pnpm --dir web test
  else
    related=()
    for f in "${web_files[@]}"; do
      [ -e "web/$f" ] && related+=("$f")
    done
    if [ "${#related[@]}" -gt 0 ]; then
      step "vitest related to ${#related[@]} file(s)"
      pnpm --dir web exec vitest related --run --passWithNoTests "${related[@]}"
    fi
  fi
fi

if [ "$e2e" -eq 1 ]; then
  step "e2e lint and tsc"
  just e2e-check
fi

if [ "$fixtures" -eq 1 ]; then
  step "fixture guard"
  just fixtures-check
fi

if [ "${#existing[@]}" -gt 0 ]; then
  just web-install
  step "prettier: ${#existing[@]} file(s)"
  web/node_modules/.bin/prettier --check --ignore-unknown "${existing[@]}"
fi

echo
if [ "${#others[@]}" -gt 0 ]; then
  echo "quick: not covered here, only by \`just check\`: ${others[*]}"
fi
echo "quick: passed. Run \`just check\` before you push."
