#!/usr/bin/env bash
# ==============================================================================
# OmniVPN: Common Environment & Helper Functions
# ==============================================================================

set -euo pipefail

# Project root directory
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

# Colors for terminal output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
BOLD='\033[1m'
NC='\033[0m' # No Color

# Logging functions
log_info() {
  echo -e "${BLUE}[INFO]${NC} $1"
}

log_success() {
  echo -e "${GREEN}[SUCCESS]${NC} $1"
}

log_warn() {
  echo -e "${YELLOW}[WARN]${NC} $1"
}

log_error() {
  echo -e "${RED}[ERROR]${NC} $1" >&2
}

# Load configurations
SERVER_ENV="${PROJECT_ROOT}/config/server.env"
VPN_ENV="${PROJECT_ROOT}/config/vpn.env"

if [[ -f "${SERVER_ENV}" ]]; then
  # shellcheck source=/dev/null
  source "${SERVER_ENV}"
else
  log_error "Missing config/server.env! Copy from config/server.env.example and configure."
  exit 1
fi

SSH_KEY_ABSOLUTE="${PROJECT_ROOT}/${SSH_KEY_PATH}"

# Common SSH command wrapper
run_ssh() {
  local cmd="$1"
  ssh -i "${SSH_KEY_ABSOLUTE}" \
      -o IdentitiesOnly=yes \
      -o StrictHostKeyChecking=accept-new \
      -o UserKnownHostsFile="${PROJECT_ROOT}/keys/known_hosts" \
      -o ConnectTimeout=10 \
      -p "${VPS_SSH_PORT:-22}" \
      "${VPS_SSH_USER:-root}@${VPS_IP}" \
      "${cmd}"
}

# Common SCP command wrapper (Local to Remote)
run_scp() {
  local src="$1"
  local dest="$2"
  scp -r -i "${SSH_KEY_ABSOLUTE}" \
      -o IdentitiesOnly=yes \
      -o StrictHostKeyChecking=accept-new \
      -o UserKnownHostsFile="${PROJECT_ROOT}/keys/known_hosts" \
      -o ConnectTimeout=10 \
      -P "${VPS_SSH_PORT:-22}" \
      "${src}" \
      "${VPS_SSH_USER:-root}@${VPS_IP}:${dest}"
}

# Common SCP command wrapper (Remote to Local)
run_scp_download() {
  local remote_src="$1"
  local local_dest="$2"
  scp -i "${SSH_KEY_ABSOLUTE}" \
      -o IdentitiesOnly=yes \
      -o StrictHostKeyChecking=accept-new \
      -o UserKnownHostsFile="${PROJECT_ROOT}/keys/known_hosts" \
      -o ConnectTimeout=10 \
      -P "${VPS_SSH_PORT:-22}" \
      "${VPS_SSH_USER:-root}@${VPS_IP}:${remote_src}" \
      "${local_dest}"
}
