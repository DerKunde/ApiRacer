#!/bin/bash
# Deploys one commit of the signaling server on the VPS and restarts it.
#
# Installed as /usr/local/bin/apiracer-deploy (owned by root, not writable by others).
# GitHub Actions calls it over SSH with a key that authorized_keys restricts to exactly this script:
#   restrict,command="sudo /usr/local/bin/apiracer-deploy \"$SSH_ORIGINAL_COMMAND\"" ssh-ed25519 AAAA… github-actions
# The commit SHA sent by the workflow arrives as $SSH_ORIGINAL_COMMAND and becomes $1 here.
#
# Note: restarting drops all rooms, they only live in the server's memory.
set -euo pipefail

APP_DIR=/opt/apiracer/app
SERVICE=apiracer-signaling
APP_USER=apiracer

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

echo "Fetching $sha …"
as_app git -C "$APP_DIR" fetch --quiet origin
as_app git -C "$APP_DIR" checkout --quiet --detach "$sha"

echo "Installing dependencies …"
as_app npm --prefix "$APP_DIR" ci --no-audit --no-fund

echo "Restarting $SERVICE …"
systemctl restart "$SERVICE"
# Give a crashing server a moment to exit before checking
sleep 2
systemctl is-active --quiet "$SERVICE"
echo "Deployed $(as_app git -C "$APP_DIR" log -1 --format='%h %s')"
