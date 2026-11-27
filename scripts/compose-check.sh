#!/usr/bin/env bash
# Checks the compose examples and the deployment docs (docs/deployment.md):
#
# - `docker compose config` accepts compose.yaml and compose.caddy.yaml;
# - compose.yaml runs OpenStar alone: `restart: unless-stopped`, port 8080,
#   the /songs and /appdata volumes and OPENSTAR_ADMIN_PIN;
# - compose.caddy.yaml puts it behind a Caddy built with the caddy-dns/cloudflare
#   module, one route to openstar:8080 for everything, a DNS-01 certificate,
#   OpenStar's port not published, and both say they are an example;
# - neither file names a real domain: only example.com and its subdomains;
# - the docs name every setting the server reads (crates/server/src/config.rs),
#   the `_FILE` variant of every secret, the /appdata folders and the image tags.
#
# Usage: scripts/compose-check.sh [repository root]. Run by `just compose-check`.
# Needs Docker with the compose plugin and jq.
set -euo pipefail

root="${1:-$(cd "$(dirname "$0")/.." && pwd)}"
problems=0
problem() {
    echo "compose: $*" >&2
    problems=$((problems + 1))
}

# config <file>: the file as `docker compose config` resolves it, as JSON.
config() {
    (cd "$root" && docker compose -f "$1" config --format json 2>&1)
}

# expect <file> <description> <jq filter that must yield true>
expect() {
    local file="$1" what="$2" filter="$3" json="$4"
    jq -e "$filter" >/dev/null 2>&1 <<<"$json" || problem "$file: $what"
}

plain="$(config compose.yaml)" || {
    problem "compose.yaml: docker compose config refuses it: $plain"
    plain='{}'
}
expect compose.yaml "has exactly one service, openstar" '.services | keys == ["openstar"]' "$plain"
expect compose.yaml "uses the ghcr.io/marcowich0/openstar image" \
    '.services.openstar.image | startswith("ghcr.io/marcowich0/openstar:")' "$plain"
expect compose.yaml "restarts unless stopped" '.services.openstar.restart == "unless-stopped"' "$plain"
expect compose.yaml "publishes port 8080 on 8080" \
    '[.services.openstar.ports[] | select(.target == 8080 and .published == "8080")] | length == 1' "$plain"
for target in /songs /appdata; do
    expect compose.yaml "mounts a volume on $target" \
        "[.services.openstar.volumes[] | select(.target == \"$target\")] | length == 1" "$plain"
done
expect compose.yaml "sets OPENSTAR_ADMIN_PIN" '.services.openstar.environment | has("OPENSTAR_ADMIN_PIN")' "$plain"

caddy="$(config compose.caddy.yaml)" || {
    problem "compose.caddy.yaml: docker compose config refuses it: $caddy"
    caddy='{}'
}
expect compose.caddy.yaml "has the services openstar and caddy" '.services | keys == ["caddy", "openstar"]' "$caddy"
expect compose.caddy.yaml "builds Caddy with the caddy-dns/cloudflare module" \
    '.services.caddy.build.dockerfile_inline | test("xcaddy build[^\n]*--with github.com/caddy-dns/cloudflare")' "$caddy"
expect compose.caddy.yaml "publishes Caddy on 443" \
    '[.services.caddy.ports[] | select(.target == 443 and .published == "443")] | length >= 1' "$caddy"
expect compose.caddy.yaml "does not publish OpenStar's own port (only Caddy reaches it)" \
    '(.services.openstar.ports // []) | length == 0' "$caddy"
expect compose.caddy.yaml "sets OPENSTAR_PUBLIC_URL to an https:// address" \
    '.services.openstar.environment.OPENSTAR_PUBLIC_URL | startswith("https://")' "$caddy"
expect compose.caddy.yaml "restarts both services unless stopped" \
    '[.services[].restart] | all(. == "unless-stopped")' "$caddy"
caddyfile="$(jq -r '.configs.caddyfile.content // ""' <<<"$caddy")"
grep -qE 'dns cloudflare' <<<"$caddyfile" || problem "compose.caddy.yaml: the Caddyfile does not get its certificate through Cloudflare DNS-01"
grep -qE '^\s*reverse_proxy openstar:8080\s*$' <<<"$caddyfile" || problem "compose.caddy.yaml: the Caddyfile has no single 'reverse_proxy openstar:8080' route"
[[ "$(grep -cE '^\s*(handle|route|handle_path)\b' <<<"$caddyfile")" == 0 ]] || problem "compose.caddy.yaml: the Caddyfile splits the routes; one route must cover pages, media, /bridge and WebSockets"
grep -qiE 'example' "$root/compose.caddy.yaml" || problem "compose.caddy.yaml: does not say it is an example"

for file in compose.yaml compose.caddy.yaml; do
    # Every domain-like name in a URL or on a Caddy site line is example.com.
    while IFS= read -r host; do
        [[ "$host" == example.com || "$host" == *.example.com || "$host" == localhost || "$host" == openstar ]] ||
            problem "$file: names the host $host; use example.com in examples"
    done < <(grep -oE 'https?://[A-Za-z0-9.-]+' "$root/$file" | sed -E 's#https?://##; s#\.+$##' | grep -vE '^(github\.com|caddyserver\.com|ghcr\.io|docs\.docker\.com|developers\.cloudflare\.com)$' || true)
    grep -nE '\b([0-9]{1,3}\.){3}[0-9]{1,3}\b' "$root/$file" | grep -vE '\b(127\.0\.0\.1|0\.0\.0\.0)\b' &&
        problem "$file: names an IP address; examples must not"
done

docs="$root/docs/deployment.md"
if [[ ! -f "$docs" ]]; then
    problem "docs/deployment.md is missing"
else
    # Every OPENSTAR_ variable the server reads is in the settings table.
    while IFS= read -r name; do
        grep -qE "^\|.*\`$name\`" "$docs" || problem "docs/deployment.md: the settings table has no row for $name"
    done < <(grep -oE '"OPENSTAR_[A-Z_]+"' "$root/crates/server/src/config.rs" | tr -d '"' | sort -u)
    # The secrets read through `secret(..)` also have a `_FILE` variant.
    while IFS= read -r name; do
        grep -qE "^\|.*\`${name}_FILE\`" "$docs" || problem "docs/deployment.md: the settings table does not name ${name}_FILE"
    done < <(grep -oE 'secret\(&var, "OPENSTAR_[A-Z_]+"\)' "$root/crates/server/src/config.rs" | grep -oE 'OPENSTAR_[A-Z_]+' | sort -u)
    for word in openstar.db cache/ bin/ trash/ backups/ drafts/ ':X.Y.Z' ':X.Y' ':X`' ':latest' ':edge' 'user: "99:100"' ':ro' 'OPENSTAR_PUBLIC_URL' 'http://localhost' 'self-signed' 'X-Forwarded-For' 'compose.caddy.yaml'; do
        grep -qF -- "$word" "$docs" || problem "docs/deployment.md: never mentions $word"
    done
fi

if [[ $problems -gt 0 ]]; then
    echo "compose: $problems problem(s)" >&2
    exit 1
fi
echo "compose: the examples and the deployment docs are in order"
