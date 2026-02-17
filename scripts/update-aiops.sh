#!/usr/bin/env bash
set -euo pipefail

HOST=""
USER_NAME=""
REPO_URL="https://github.com/pgsousa/openclaw.git"
REPO_DIR="~/openclaw-aiops"
BRANCH="main"
CHANNEL="stable"
SSH_CONNECT_TIMEOUT=10
SSH_RETRIES=4
SSH_BACKOFF_SECONDS=2
REMOTE_RETRIES=3
REMOTE_BACKOFF_SECONDS=2

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
  --ssh-timeout <sec>   SSH connect timeout in seconds (default: 10)
  --ssh-retries <n>     SSH attempts before failing (default: 4)
  --ssh-backoff <sec>   Base backoff seconds between SSH retries (default: 2)
  --remote-retries <n>  Retry attempts for remote network/update commands (default: 3)
  --remote-backoff <s>  Base backoff seconds for remote retries (default: 2)
  -h, --help            Show this help
USAGE
}

require_value() {
  local option="$1"
  local value="${2:-}"
  if [[ -z "$value" || "$value" == --* ]]; then
    echo "Missing value for ${option}" >&2
    usage
    exit 1
  fi
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --host)
      require_value "$1" "${2:-}"
      HOST="$2"
      shift 2
      ;;
    --user)
      require_value "$1" "${2:-}"
      USER_NAME="$2"
      shift 2
      ;;
    --repo-url)
      require_value "$1" "${2:-}"
      REPO_URL="$2"
      shift 2
      ;;
    --repo-dir)
      require_value "$1" "${2:-}"
      REPO_DIR="$2"
      shift 2
      ;;
    --branch)
      require_value "$1" "${2:-}"
      BRANCH="$2"
      shift 2
      ;;
    --channel)
      require_value "$1" "${2:-}"
      CHANNEL="$2"
      shift 2
      ;;
    --ssh-timeout)
      require_value "$1" "${2:-}"
      SSH_CONNECT_TIMEOUT="$2"
      shift 2
      ;;
    --ssh-retries)
      require_value "$1" "${2:-}"
      SSH_RETRIES="$2"
      shift 2
      ;;
    --ssh-backoff)
      require_value "$1" "${2:-}"
      SSH_BACKOFF_SECONDS="$2"
      shift 2
      ;;
    --remote-retries)
      require_value "$1" "${2:-}"
      REMOTE_RETRIES="$2"
      shift 2
      ;;
    --remote-backoff)
      require_value "$1" "${2:-}"
      REMOTE_BACKOFF_SECONDS="$2"
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

for numeric in SSH_CONNECT_TIMEOUT SSH_RETRIES SSH_BACKOFF_SECONDS REMOTE_RETRIES REMOTE_BACKOFF_SECONDS; do
  value="${!numeric}"
  if ! [[ "$value" =~ ^[0-9]+$ ]] || (( value < 1 )); then
    echo "Invalid value for ${numeric}: ${value} (expected positive integer)" >&2
    exit 1
  fi
done

REMOTE_TARGET="${USER_NAME}@${HOST}"
echo "==> Remote target: ${REMOTE_TARGET}"
echo "==> Repo: ${REPO_URL} (${BRANCH})"
echo "==> Dir: ${REPO_DIR}"
echo "==> Update channel: ${CHANNEL}"
echo "==> SSH timeout/retries: ${SSH_CONNECT_TIMEOUT}s / ${SSH_RETRIES} attempts"
echo "==> Remote retries: ${REMOTE_RETRIES} attempts (base backoff ${REMOTE_BACKOFF_SECONDS}s)"

ssh_opts=(
  -o ConnectTimeout="${SSH_CONNECT_TIMEOUT}"
  -o ServerAliveInterval=15
  -o ServerAliveCountMax=3
)

attempt=1
while true; do
  echo "==> SSH attempt ${attempt}/${SSH_RETRIES}"
  ssh_status=0
  if ssh "${ssh_opts[@]}" "$REMOTE_TARGET" "bash -s" -- \
    "$REPO_URL" "$REPO_DIR" "$BRANCH" "$CHANNEL" "$REMOTE_RETRIES" "$REMOTE_BACKOFF_SECONDS" <<'REMOTE_SCRIPT'
set -euo pipefail

repo_url="$1"
repo_dir="$2"
branch="$3"
channel="$4"
retry_attempts="${5:-3}"
retry_backoff_seconds="${6:-2}"

log() {
  printf '\n[%s] %s\n' "$(date -u +%H:%M:%S)" "$*"
}

retry_run() {
  local attempt_no=1
  local max_attempts="$retry_attempts"
  local base_backoff="$retry_backoff_seconds"
  while true; do
    if "$@"; then
      return 0
    fi
    local status=$?
    if (( attempt_no >= max_attempts )); then
      return "$status"
    fi
    local sleep_for=$((base_backoff * attempt_no))
    log "Command failed (attempt ${attempt_no}/${max_attempts}): $*"
    log "Retrying in ${sleep_for}s..."
    sleep "$sleep_for"
    attempt_no=$((attempt_no + 1))
  done
}

run() {
  log "$*"
  "$@"
}

run_retry() {
  log "$*"
  retry_run "$@"
}

rollback_ref=""
rollback_armed="false"
expanded_repo_dir="$repo_dir"

perform_rollback() {
  if [[ "$rollback_armed" != "true" ]]; then
    return 0
  fi
  if [[ -z "$rollback_ref" ]]; then
    log "Rollback skipped: no previous revision captured."
    return 0
  fi
  log "Rollback: restoring repository to ${rollback_ref}"
  set +e
  git -C "$expanded_repo_dir" checkout "$rollback_ref"
  retry_run pnpm -C "$expanded_repo_dir" install --frozen-lockfile
  pnpm -C "$expanded_repo_dir" openclaw setup
  set -e
}

on_error() {
  local line="$1"
  local status="$2"
  log "ERROR at line ${line} (exit ${status})"
  perform_rollback
  exit "$status"
}

trap 'on_error "$LINENO" "$?"' ERR

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

if [[ "$expanded_repo_dir" == "~/"* ]]; then
  expanded_repo_dir="$HOME/${expanded_repo_dir#~/}"
fi

if [[ -d "$expanded_repo_dir/.git" ]]; then
  rollback_ref="$(git -C "$expanded_repo_dir" rev-parse HEAD)"
  run git -C "$expanded_repo_dir" remote set-url origin "$repo_url"
  run_retry git -C "$expanded_repo_dir" fetch origin --tags --prune
  run git -C "$expanded_repo_dir" checkout "$branch"
  run_retry git -C "$expanded_repo_dir" pull --rebase origin "$branch"
else
  run mkdir -p "$(dirname "$expanded_repo_dir")"
  run_retry git clone --branch "$branch" "$repo_url" "$expanded_repo_dir"
fi

run git -C "$expanded_repo_dir" status --short

if git -C "$expanded_repo_dir" remote get-url upstream >/dev/null 2>&1; then
  run git -C "$expanded_repo_dir" remote set-url upstream https://github.com/openclaw/openclaw.git
else
  run git -C "$expanded_repo_dir" remote add upstream https://github.com/openclaw/openclaw.git
fi

run_retry pnpm -C "$expanded_repo_dir" install --frozen-lockfile
run pnpm -C "$expanded_repo_dir" openclaw setup

log "Update status (before)"
run pnpm -C "$expanded_repo_dir" openclaw update status || true

rollback_armed="true"
log "Running update"
run_retry pnpm -C "$expanded_repo_dir" openclaw update --channel "$channel" --yes --no-restart

log "Update status (after)"
run pnpm -C "$expanded_repo_dir" openclaw update status

gateway_running() {
  if command -v pgrep >/dev/null 2>&1; then
    if pgrep -f "openclaw-gateway|openclaw gateway run" >/dev/null 2>&1; then
      return 0
    fi
  fi
  ps -ef | grep -Eq '[o]penclaw-gateway|[o]penclaw gateway run'
}

log "Post-update validation"
run pnpm -C "$expanded_repo_dir" openclaw --version
if gateway_running; then
  run pnpm -C "$expanded_repo_dir" openclaw channels status --probe
else
  log "Gateway process not detected; skipping channels status probe."
fi

rollback_armed="false"
log "Done"
REMOTE_SCRIPT
  then
    break
  else
    ssh_status=$?
  fi

  if (( ssh_status != 255 )); then
    echo "ERROR: Remote command failed with exit ${ssh_status} (not a transport error, skipping retry)." >&2
    exit "$ssh_status"
  fi

  if (( attempt >= SSH_RETRIES )); then
    echo "ERROR: SSH command failed after ${SSH_RETRIES} attempts." >&2
    exit 1
  fi
  sleep_for=$((SSH_BACKOFF_SECONDS * attempt))
  echo "SSH attempt ${attempt} failed, retrying in ${sleep_for}s..."
  sleep "$sleep_for"
  attempt=$((attempt + 1))
done
