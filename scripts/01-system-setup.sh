#!/usr/bin/env bash
# ==============================================================================
# OmniVPN: Step 01 - Base System Update, Essential Tools & Kernel Optimization
# ==============================================================================

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/common.sh
source "${SCRIPT_DIR}/common.sh"

log_info "Step 01: Configuring base system, upgrading packages & kernel tuning on ${VPS_IP}..."

run_ssh 'bash -s' <<'REMOTE_EOF'
set -euo pipefail

export DEBIAN_FRONTEND=noninteractive

echo "[REMOTE] Updating package lists and upgrading system packages..."
apt-get update -y
apt-get upgrade -y

echo "[REMOTE] Installing essential management and networking packages..."
apt-get install -y --no-install-recommends \
    apt-transport-https \
    ca-certificates \
    curl \
    wget \
    gnupg \
    lsb-release \
    git \
    htop \
    iotop \
    net-tools \
    iptables \
    ufw \
    fail2ban \
    unzip \
    tar \
    software-properties-common \
    systemd-timesyncd

echo "[REMOTE] Enabling time synchronization..."
systemctl enable --now systemd-timesyncd || true

echo "[REMOTE] Configuring kernel parameters for VPN networking & IP forwarding..."
cat > /etc/sysctl.d/99-vps-networking.conf <<SYSCTL_EOF
net.ipv4.ip_forward = 1
net.ipv4.conf.all.accept_redirects = 0
net.ipv4.conf.all.send_redirects = 0
net.ipv4.conf.default.rp_filter = 0
net.ipv4.conf.default.accept_source_route = 0
net.ipv4.conf.default.send_redirects = 0
net.ipv4.conf.default.accept_redirects = 0
net.core.rmem_max = 67108864
net.core.wmem_max = 67108864
SYSCTL_EOF

sysctl --system >/dev/null

echo "[REMOTE] Base system setup completed successfully!"
REMOTE_EOF

log_success "Base system setup and kernel optimization complete!"
