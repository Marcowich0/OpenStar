#!/usr/bin/env bash
# Checks that every version pin is one Renovate keeps current (docs/renovate.md):
#
# - renovate.json is readable JSON, and Dependabot version updates are off;
# - every base image in the Dockerfile is pinned by digest;
# - every action in .github/workflows is pinned by a full commit SHA, with
#   the version as a comment (`uses: owner/repo@<sha> # vX.Y.Z`);
# - every `*_VERSION` build argument or environment variable in the
#   Dockerfile and the workflows has a `# renovate: datasource=… depName=…`
#   comment on the line above it;
# - every `*_SHA256` sits under its `*_VERSION`, and that version's datasource
#   is `github-release-attachments`, so a Renovate bump carries the new checksum;
# - the Playwright image in scripts/e2e.sh has the version of @playwright/test
#   in e2e/package.json, and a digest.
#
# Usage: scripts/check-pins.sh [repository root]. Run by `just pins-check`.
set -euo pipefail

root="${1:-$(cd "$(dirname "$0")/.." && pwd)}"
problems=0
problem() {
  echo "pins: $*" >&2
  problems=$((problems + 1))
}

if ! node -e 'JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))' "$root/renovate.json" 2>/dev/null; then
  problem "renovate.json is missing or is not valid JSON"
fi

for f in "$root/.github/dependabot.yml" "$root/.github/dependabot.yaml"; do
  [[ -e "$f" ]] && problem "${f#"$root/"}: Dependabot version updates are not used; Renovate bumps every pin"
done

# Base images: by digest, except a FROM that names an earlier stage.
stages=" "
while IFS= read -r line; do
  read -r -a words <<<"$line"
  image=""
  for word in "${words[@]:1}"; do
    [[ "$word" == --* ]] && continue
    image="$word"
    break
  done
  if [[ "$line" =~ [[:space:]][Aa][Ss][[:space:]]+([^[:space:]]+) ]]; then
    stages+="${BASH_REMATCH[1]} "
  fi
  [[ "$stages" == *" $image "* && "$image" != *[:@]* ]] && continue
  [[ "$image" == *@sha256:* ]] || problem "Dockerfile: base image $image is not pinned by digest"
done < <(grep -E '^FROM[[:space:]]' "$root/Dockerfile")

# Actions: by full commit SHA, with the version comment Renovate keeps in step.
for wf in "$root"/.github/workflows/*.y*ml; do
  while IFS= read -r line; do
    ref="$(sed -E 's/^[[:space:]-]*uses:[[:space:]]*//; s/[[:space:]].*$//' <<<"$line")"
    [[ "$ref" == ./* ]] && continue
    if [[ ! "$ref" =~ @[0-9a-f]{40}$ ]]; then
      problem "${wf#"$root/"}: $ref is not pinned by a full commit SHA"
    elif [[ ! "$line" =~ \#[[:space:]]*v?[0-9] ]]; then
      problem "${wf#"$root/"}: ${ref%@*} has no '# vX.Y.Z' comment after its SHA"
    fi
  done < <(grep -E '^[[:space:]-]*uses:' "$wf")
done

# `*_VERSION` and `*_SHA256` pins in the Dockerfile and the workflows.
for f in "$root/Dockerfile" "$root"/.github/workflows/*.y*ml; do
  awk -v file="${f#"$root/"}" '
    function name_of(line) {
      sub(/^[[:space:]]*(ARG[[:space:]]+)?/, "", line)
      sub(/[[:space:]]*[=:].*$/, "", line)
      return line
    }
    /^[[:space:]]*(ARG[[:space:]]+)?[A-Z0-9_]+_VERSION[[:space:]]*[=:]/ {
      name = name_of($0)
      prefix = name; sub(/_VERSION$/, "", prefix)
      if (prev !~ /^[[:space:]]*# renovate: datasource=[^[:space:]]+ depName=[^[:space:]]+/) {
        print "pins: " file ": " name " has no \"# renovate: datasource=... depName=...\" comment above it"
        bad = 1
      }
      datasource[prefix] = prev
      sub(/^.*datasource=/, "", datasource[prefix]); sub(/[[:space:]].*$/, "", datasource[prefix])
    }
    /^[[:space:]]*(ARG[[:space:]]+)?[A-Z0-9_]+_SHA256[[:space:]]*[=:]/ {
      name = name_of($0)
      prefix = name; sub(/_SHA256$/, "", prefix)
      if (!(prefix in datasource)) {
        print "pins: " file ": " name " has no " prefix "_VERSION above it"
        bad = 1
      } else if (datasource[prefix] != "github-release-attachments") {
        print "pins: " file ": " name " belongs to " prefix "_VERSION, whose datasource is " datasource[prefix] ", not github-release-attachments: Renovate would bump the version and leave the checksum"
        bad = 1
      }
    }
    NF { prev = $0 }
    END { exit bad }
  ' "$f" >&2 || problems=$((problems + 1))
done

# The Playwright pair: the image's browsers belong to that exact @playwright/test.
image="$(grep -oE 'mcr\.microsoft\.com/playwright:[^"[:space:]]+' "$root/scripts/e2e.sh" | head -n1 || true)"
image_version="$(sed -nE 's|^mcr\.microsoft\.com/playwright:v([0-9][^-@]*).*$|\1|p' <<<"$image")"
package_version="$(node -e 'console.log(require(process.argv[1]).devDependencies["@playwright/test"] ?? "")' "$root/e2e/package.json")"
if [[ -z "$image_version" || "$image" != *@sha256:* ]]; then
  problem "scripts/e2e.sh: the Playwright image is not pinned as mcr.microsoft.com/playwright:vX.Y.Z-<distro>@sha256:…"
elif [[ "$image_version" != "$package_version" ]]; then
  problem "scripts/e2e.sh runs Playwright $image_version, but e2e/package.json has @playwright/test $package_version: bump them together"
fi

if [[ $problems -ne 0 ]]; then
  exit 1
fi
echo "pins: every pin is one Renovate keeps current"
