#!/usr/bin/env bash
set -euo pipefail

HOST=""
USER_NAME=""
REPO_URL="https://github.com/pgsousa/openclaw.git"
REPO_DIR="~/openclaw-aiops"
BRANCH="main"
CHANNEL="stable"

usage() {
  cat <<'USAGE'
Usage: scripts/update-aiops.sh [options]

Options:
  --host <host>         SSH host (required)
  --user <user>         SSH user (optional; defaults to current user)
  --repo-url <url>      Git repo URL (default: https://github.com/pgsousa/openclaw.git)
  --repo-dir <path>     Remote checkout dir (default: ~/openclaw-aiops)
  --branch <name>       Git branch to install from (default: main)
  --channel <name>      openclaw update channel: stable|beta|dev (default: stable)
  -h, --help            Show this help
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --host)
      HOST="$2"
      shift 2
      ;;
    --user)
      USER_NAME="$2"
      shift 2
      ;;
    --repo-url)
      REPO_URL="$2"
      shift 2
      ;;
    --repo-dir)
      REPO_DIR="$2"
      shift 2
      ;;
    --branch)
      BRANCH="$2"
      shift 2
      ;;
    --channel)
      CHANNEL="$2"
      shift 2
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage
      exit 1
      ;;
  esac
done

if [[ "$CHANNEL" != "stable" && "$CHANNEL" != "beta" && "$CHANNEL" != "dev" ]]; then
  echo "Invalid channel: $CHANNEL (expected stable|beta|dev)" >&2
  exit 1
fi

if [[ -z "$HOST" ]]; then
  echo "Missing required --host" >&2
  usage
  exit 1
fi

if [[ -z "$USER_NAME" ]]; then
  USER_NAME="$(id -un)"
fi

REMOTE_TARGET="${USER_NAME}@${HOST}"
echo "==> Remote target: ${REMOTE_TARGET}"
echo "==> Repo: ${REPO_URL} (${BRANCH})"
echo "==> Dir: ${REPO_DIR}"
echo "==> Update channel: ${CHANNEL}"

ssh "$REMOTE_TARGET" "bash -s" -- "$REPO_URL" "$REPO_DIR" "$BRANCH" "$CHANNEL" <<'REMOTE_SCRIPT'
set -euo pipefail

repo_url="$1"
repo_dir="$2"
branch="$3"
channel="$4"

log() {
  printf '\n[%s] %s\n' "$(date -u +%H:%M:%S)" "$*"
}

run() {
  log "$*"
  "$@"
}

run command -v git
run command -v node
run command -v npm
run node -v
run npm -v

prefix="$(npm config get prefix)"
if [[ -d "$prefix/bin" ]]; then
  export PATH="$prefix/bin:$PATH"
fi
export PATH="$HOME/.local/bin:$HOME/Library/pnpm:$PATH"

ensure_pnpm() {
  if command -v pnpm >/dev/null 2>&1; then
    return
  fi

  if command -v corepack >/dev/null 2>&1; then
    run mkdir -p "$HOME/.local/bin"
    cat > "$HOME/.local/bin/pnpm" <<'EOF'
#!/usr/bin/env bash
exec corepack pnpm "$@"
EOF
    run chmod +x "$HOME/.local/bin/pnpm"
  fi

  if command -v pnpm >/dev/null 2>&1; then
    return
  fi

  run npm install -g --prefix "$HOME/.local" pnpm
  export PATH="$HOME/.local/bin:$PATH"
}

if ! command -v pnpm >/dev/null 2>&1; then
  ensure_pnpm
fi
run pnpm -v

expanded_repo_dir="$repo_dir"
if [[ "$expanded_repo_dir" == "~/"* ]]; then
  expanded_repo_dir="$HOME/${expanded_repo_dir#~/}"
fi

if [[ -d "$expanded_repo_dir/.git" ]]; then
  run git -C "$expanded_repo_dir" remote set-url origin "$repo_url"
  run git -C "$expanded_repo_dir" fetch origin --tags --prune
  run git -C "$expanded_repo_dir" checkout "$branch"
  run git -C "$expanded_repo_dir" pull --rebase origin "$branch"
else
  run mkdir -p "$(dirname "$expanded_repo_dir")"
  run git clone --branch "$branch" "$repo_url" "$expanded_repo_dir"
fi

run git -C "$expanded_repo_dir" status --short

if git -C "$expanded_repo_dir" remote get-url upstream >/dev/null 2>&1; then
  run git -C "$expanded_repo_dir" remote set-url upstream https://github.com/openclaw/openclaw.git
else
  run git -C "$expanded_repo_dir" remote add upstream https://github.com/openclaw/openclaw.git
fi

run pnpm -C "$expanded_repo_dir" install --frozen-lockfile
run pnpm -C "$expanded_repo_dir" openclaw setup

log "Update status (before)"
run pnpm -C "$expanded_repo_dir" openclaw update status || true

log "Running update"
run pnpm -C "$expanded_repo_dir" openclaw update --channel "$channel" --yes --no-restart

log "Update status (after)"
run pnpm -C "$expanded_repo_dir" openclaw update status

log "Done"
REMOTE_SCRIPT
