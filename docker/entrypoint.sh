#!/bin/sh
# GitSlappin Docker entrypoint. Runs as the unprivileged `node` user with HOME on a tmpfs.
# Never prints GITSLAPPIN_TOKEN.
set -eu

die() { echo "gitslappin: $1" >&2; exit 1; }

[ -n "${GIT_USER_NAME:-}" ] || die "GIT_USER_NAME is required (set it in .env)."
[ -n "${GIT_USER_EMAIL:-}" ] || die "GIT_USER_EMAIL is required (set it in .env)."
[ -n "${GITSLAPPIN_TOKEN:-}" ] || die "GITSLAPPIN_TOKEN is required (set it in .env)."

# Git identity. core.autocrlf only when GITSLAPPIN_AUTOCRLF is set; otherwise git's default applies.
git config --global user.name "$GIT_USER_NAME"
git config --global user.email "$GIT_USER_EMAIL"
if [ -n "${GITSLAPPIN_AUTOCRLF:-}" ]; then
  case "$GITSLAPPIN_AUTOCRLF" in
    true|input|false) git config --global core.autocrlf "$GITSLAPPIN_AUTOCRLF" ;;
    *) die "GITSLAPPIN_AUTOCRLF must be true, input or false." ;;
  esac
fi

# SSH: private keys and known_hosts only. The user's own ssh config is never copied (ProxyCommand / LocalCommand risk).
SRC=/run/host-ssh
DST="$HOME/.ssh"
mkdir -p "$DST"
chmod 700 "$DST"
CONF="$DST/config"
{
  echo "Host *"
  echo "  StrictHostKeyChecking yes"
  echo "  UserKnownHostsFile $DST/known_hosts"
  echo "  BatchMode yes"
} > "$CONF"
for f in "$SRC"/id_*; do
  [ -f "$f" ] || continue
  name=$(basename "$f")
  case "$name" in
    *.pub) continue ;;
    *[!A-Za-z0-9._-]*) echo "gitslappin: skipping ssh key with an unusual name: $name" >&2; continue ;;
  esac
  cp "$f" "$DST/$name"
  chmod 600 "$DST/$name"
  echo "  IdentityFile $DST/$name" >> "$CONF"
done
if [ -f "$SRC/known_hosts" ]; then
  cp "$SRC/known_hosts" "$DST/known_hosts"
  chmod 600 "$DST/known_hosts"
else
  echo "gitslappin: warning: no known_hosts in the SSH folder; SSH remotes will fail until it exists." >&2
fi
chmod 600 "$CONF"

exec "$@"
