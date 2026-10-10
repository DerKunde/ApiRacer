#!/bin/bash
# Deploys one commit of the signaling server on the VPS and restarts it.
# If the new version does not come up, it rolls back to the previous commit.
#
# Installed as /usr/local/bin/apiracer-deploy (owned by root, not writable by others).
# GitHub Actions calls it over SSH with a key that authorized_keys restricts to exactly this script:
#   restrict,command="sudo /usr/local/bin/apiracer-deploy \"$SSH_ORIGINAL_COMMAND\"" ssh-ed25519 AAAA… github-actions
# The commit SHA sent by the workflow arrives as $SSH_ORIGINAL_COMMAND and becomes $1 here.
#
# Exit codes: 0 = deployed, 1 = failed (rolled back if anything had changed), 2 = rollback failed too, server is down.
# Lines starting with ::error:: are shown as errors in the GitHub Actions run summary.
#
# Note: restarting drops all rooms, they only live in the server's memory.
set -euo pipefail

APP_DIR=/opt/apiracer/app
SERVICE=apiracer-signaling
APP_USER=apiracer
# A plain HTTP request to the WebSocket server is answered with 426 Upgrade Required
HEALTH_URL=http://127.0.0.1:3001/
HEALTH_TIMEOUT_S=10

sha="${1:-}"
# Untrusted input: accept a full commit SHA only
if [[ ! "$sha" =~ ^[0-9a-f]{40}$ ]]; then
  echo "Usage: apiracer-deploy <40-char commit sha>" >&2
  exit 1
fi

# Run as the app user with its own HOME, so git finds the GitHub deploy key
as_app() {
  sudo -u "$APP_USER" -H -- "$@"
}

health_check() {
  for _ in $(seq "$HEALTH_TIMEOUT_S"); do
    sleep 1
    [[ "$(curl -s -o /dev/null -w '%{http_code}' "$HEALTH_URL")" == 426 ]] && return 0
  done
  echo "Health check failed: no 426 from $HEALTH_URL within ${HEALTH_TIMEOUT_S}s" >&2
  return 1
}

# Called inside `if`, where bash ignores set -e – hence the explicit `|| return 1`
switch_to() {
  echo "Checking out ${1:0:7} …"
  as_app git -C "$APP_DIR" checkout --quiet --detach "$1" || return 1
  echo "Installing dependencies …"
  as_app npm --prefix "$APP_DIR" ci --no-audit --no-fund || return 1
  echo "Restarting $SERVICE …"
  systemctl restart "$SERVICE" || return 1
  health_check
}

previous=$(as_app git -C "$APP_DIR" rev-parse HEAD)

# Nothing has changed yet if these fail, so no rollback needed (set -e exits)
echo "Fetching …"
as_app git -C "$APP_DIR" fetch --quiet origin
if ! as_app git -C "$APP_DIR" cat-file -e "$sha^{commit}" 2>/dev/null; then
  echo "::error::Commit ${sha:0:7} not found on origin – was it pushed?"
  exit 1
fi

if switch_to "$sha"; then
  echo "Deployed $(as_app git -C "$APP_DIR" log -1 --format='%h %s')"
  exit 0
fi

echo "Deploy of ${sha:0:7} failed, rolling back to ${previous:0:7} …" >&2
if switch_to "$previous"; then
  echo "::error::Deploy of ${sha:0:7} failed, rolled back to ${previous:0:7} – the server runs the previous version"
  exit 1
fi
echo "::error::Deploy of ${sha:0:7} failed and rollback to ${previous:0:7} failed too – signaling server is down"
exit 2
