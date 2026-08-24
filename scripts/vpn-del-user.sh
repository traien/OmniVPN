#!/usr/bin/env bash
# ==============================================================================
# OmniVPN: Delete a VPN User
# ==============================================================================

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/common.sh
source "${SCRIPT_DIR}/common.sh"

USERNAME="${1:-}"

if [[ -z "${USERNAME}" ]]; then
  echo -e "${BOLD}Usage:${NC} $0 <username>"
  exit 1
fi

log_info "Deleting VPN user '${USERNAME}' on ${VPS_IP}..."

run_ssh "bash -s -- '${USERNAME}'" <<'REMOTE_EOF'
set -euo pipefail
USERNAME="$1"

echo "[REMOTE] Calling WebUI API to delete user ${USERNAME} from all protocols..."
cd /opt/ipsec-vpn
export $(grep -v '^#' vpn.env | xargs)

# Login to WebUI API
curl -s -X POST http://localhost:${WEBUI_PORT:-8080}/api/auth/login \
  -H "Content-Type: application/json" \
  -d "{\"password\":\"${WEBUI_PASSWORD}\"}" \
  -c /tmp/vps_cookie.txt > /dev/null

# Delete User
RESPONSE=$(curl -s -X DELETE http://localhost:${WEBUI_PORT:-8080}/api/users/${USERNAME} \
  -b /tmp/vps_cookie.txt)

rm -f /tmp/vps_cookie.txt

if echo "$RESPONSE" | grep -q '"success":true'; then
  echo "[REMOTE] User ${USERNAME} deleted successfully."
else
  echo "[REMOTE] Failed to delete user. API Response: $RESPONSE"
fi
REMOTE_EOF

log_success "VPN user '${USERNAME}' deleted!"
