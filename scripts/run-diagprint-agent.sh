#!/usr/bin/env bash
set -euo pipefail

mode="${1:-once}"
if [[ "$mode" != "once" && "$mode" != "run" ]]; then
  printf 'usage: %s [once|run]\n' "$0" >&2
  exit 2
fi

repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
config_dir="/home/raven/.config/cybercore-agent"
credential_file="$config_dir/credential"
access_client_id_file="$config_dir/access-client-id"
access_client_secret_file="$config_dir/access-client-secret"
config_file="$config_dir/diagprint.json"

if [[ ! -f "$credential_file" ]]; then
  printf 'missing credential file: %s\n' "$credential_file" >&2
  exit 1
fi

if [[ "$(stat -c '%a' "$credential_file")" != "600" ]]; then
  chmod 600 "$credential_file"
fi

for access_file in "$access_client_id_file" "$access_client_secret_file"; do
  if [[ ! -f "$access_file" ]]; then
    printf 'missing Cloudflare Access credential file: %s\n' "$access_file" >&2
    printf 'Create both files with the Access service token values before running this script.\n' >&2
    exit 1
  fi
  if [[ "$(stat -c '%a' "$access_file")" != "600" ]]; then
    chmod 600 "$access_file"
  fi
done

if ! command -v cargo >/dev/null 2>&1; then
  printf 'cargo is required but was not found\n' >&2
  exit 1
fi

install -d -m 700 "$config_dir"
umask 077
printf '%s\n' '{
  "endpoint": "https://mission-control-staging.subgridsec.org",
  "agent_id": "agt_adf47fda27c846b99b52e9ec7c7e0ecd",
  "status": "online",
  "payload": {
    "platform": "linux",
    "connector": "cybercore-agent",
    "project": "diagprint"
  },
  "credential_file": "/home/raven/.config/cybercore-agent/credential",
  "access_client_id_file": "/home/raven/.config/cybercore-agent/access-client-id",
  "access_client_secret_file": "/home/raven/.config/cybercore-agent/access-client-secret",
  "timeout_secs": 10,
  "interval_secs": 60,
  "max_retries": 3,
  "retry_delay_ms": 250
}' > "$config_file"
chmod 600 "$config_file"

printf 'sending diagprint heartbeat (%s)\n' "$mode"
cd "$repo_root"
cargo run --locked -p cybercore-agent -- --config "$config_file" "$mode"
