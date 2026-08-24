#!/usr/bin/env bash
# ==============================================================================
# OmniVPN: Step 03 - Firewall (UFW) & Fail2Ban Hardening
# ==============================================================================

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/common.sh
source "${SCRIPT_DIR}/common.sh"

log_info "Step 03: Hardening security, configuring UFW and fail2ban on ${VPS_IP}..."

run_ssh "bash -s -- '${VPS_SSH_PORT:-22}'" <<'REMOTE_EOF'
set -euo pipefail

SSH_PORT="$1"

echo "[REMOTE] Configuring UFW firewall rules..."
ufw --force reset >/dev/null

ufw default deny incoming
ufw default allow outgoing

# Allow SSH
ufw allow "${SSH_PORT}/tcp" comment 'SSH'

# Allow IPsec / IKEv2 / L2TP VPN ports
ufw allow 500/udp comment 'IPsec IKE'
ufw allow 4500/udp comment 'IPsec NAT-T'
ufw allow 1701/udp comment 'IPsec L2TP'

# Allow standard Web ports (for WebUI & apps)
ufw allow 80/tcp comment 'HTTP'
ufw allow 443/tcp comment 'HTTPS'
ufw allow 8080/tcp comment 'VPN WebUI'
ufw allow 51820/udp comment 'WireGuard'
ufw allow 8388/tcp comment 'Shadowsocks TCP'
ufw allow 8388/udp comment 'Shadowsocks UDP'

# Enable UFW
echo "y" | ufw enable

echo "[REMOTE] Configuring Fail2Ban for SSH..."
cat > /etc/fail2ban/jail.local <<FAIL2BAN_EOF
[DEFAULT]
bantime = 1h
findtime = 10m
maxretry = 5

[sshd]
enabled = true
port = ${SSH_PORT}
logpath = %(sshd_log)s
backend = %(sshd_backend)s
FAIL2BAN_EOF

systemctl restart fail2ban || true
systemctl enable fail2ban || true

echo "[REMOTE] Firewall and security status:"
ufw status verbose
systemctl is-active fail2ban >/dev/null && echo "Fail2ban is ACTIVE"
REMOTE_EOF

log_success "Security hardening and firewall rules applied successfully!"
