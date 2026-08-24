#!/usr/bin/env bash
# ==============================================================================
# OmniVPN: Add a new VPN User (IPsec/L2TP & IKEv2)
# ==============================================================================

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/common.sh
source "${SCRIPT_DIR}/common.sh"

USERNAME="${1:-}"
PASSWORD="${2:-}"

if [[ -z "${USERNAME}" ]]; then
  echo -e "${BOLD}Usage:${NC} $0 <username> [password]"
  echo "If password is not provided, a secure random one will be generated."
  exit 1
fi

if [[ -z "${PASSWORD}" ]]; then
  PASSWORD="$(LC_ALL=C tr -dc 'A-Za-z0-9!@#%^&*' </dev/urandom | head -c 16 || true)"
fi

log_info "Creating VPN user '${USERNAME}' on ${VPS_IP}..."

run_ssh "bash -s -- '${USERNAME}' '${PASSWORD}'" <<'REMOTE_EOF'
set -euo pipefail
USERNAME="$1"
PASSWORD="$2"

echo "[REMOTE] Calling WebUI API to generate IKEv2, L2TP, WireGuard, and Shadowsocks credentials..."
cd /opt/ipsec-vpn
export $(grep -v '^#' vpn.env | xargs)

# Login to WebUI API
curl -s -X POST http://localhost:${WEBUI_PORT:-8080}/api/auth/login \
  -H "Content-Type: application/json" \
  -d "{\"password\":\"${WEBUI_PASSWORD}\"}" \
  -c /tmp/vps_cookie.txt > /dev/null

# Create User
RESPONSE=$(curl -s -X POST http://localhost:${WEBUI_PORT:-8080}/api/users \
  -b /tmp/vps_cookie.txt \
  -H "Content-Type: application/json" \
  -d "{\"username\":\"${USERNAME}\", \"password\":\"${PASSWORD}\"}")

rm -f /tmp/vps_cookie.txt

if echo "$RESPONSE" | grep -q '"success":true'; then
  echo "[REMOTE] User ${USERNAME} created successfully across all protocols!"
else
  echo "[REMOTE] Failed to create user. API Response: $RESPONSE"
  exit 1
fi
REMOTE_EOF

log_success "VPN user '${USERNAME}' successfully created!"
echo ""
echo -e "${BOLD}=== VPN Connection Credentials ===${NC}"
echo -e "Server Address:   ${BOLD}${VPS_IP}${NC}"
echo -e "Username:         ${BOLD}${USERNAME}${NC}"
echo -e "Password:         ${BOLD}${PASSWORD}${NC}"
echo -e "IPsec PSK:        (check config/vpn.env or run: ./scripts/vpn-info.sh)"
echo ""
