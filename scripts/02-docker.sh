#!/usr/bin/env bash
# ==============================================================================
# OmniVPN: Step 02 - Install Docker CE & Docker Compose Plugin
# ==============================================================================

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/common.sh
source "${SCRIPT_DIR}/common.sh"

log_info "Step 02: Installing/Verifying Docker CE & Docker Compose on ${VPS_IP}..."

run_ssh 'bash -s' <<'REMOTE_EOF'
set -euo pipefail

if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
  echo "[REMOTE] Docker is already installed:"
  docker --version
  docker compose version
  exit 0
fi

echo "[REMOTE] Setting up official Docker apt repository..."
mkdir -p /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg --yes || \
curl -fsSL https://download.docker.com/linux/debian/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg --yes

DISTRO="$(lsb_release -is | tr '[:upper:]' '[:lower:]')"
CODENAME="$(lsb_release -cs)"

echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/${DISTRO} ${CODENAME} stable" > /etc/apt/sources.list.d/docker.list

apt-get update -y
apt-get install -y --no-install-recommends \
    docker-ce \
    docker-ce-cli \
    containerd.io \
    docker-buildx-plugin \
    docker-compose-plugin

systemctl enable --now docker

echo "[REMOTE] Docker successfully installed:"
docker --version
docker compose version
REMOTE_EOF

log_success "Docker CE & Docker Compose plugin verified and running!"
