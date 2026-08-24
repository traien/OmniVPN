#!/usr/bin/env bash
# ==============================================================================
# OmniVPN: List all VPN Users & Status
# ==============================================================================

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/common.sh
source "${SCRIPT_DIR}/common.sh"

log_info "Fetching VPN users and server status from ${VPS_IP}..."

run_ssh 'bash -s' <<'REMOTE_EOF'
set -euo pipefail

echo "=================================================="
echo "         IPsec / IKEv2 Server Status              "
echo "=================================================="
docker ps --filter "name=ipsec-vpn-server" --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}"
echo ""

echo "=================================================="
echo "         IKEv2 Client Configurations              "
echo "=================================================="
docker exec ipsec-vpn-server ikev2.sh --listclients || echo "No IKEv2 clients generated yet."
echo ""

echo "=================================================="
echo "         L2TP / IPsec User Accounts               "
echo "=================================================="
docker exec ipsec-vpn-server bash -c "
  if [ -f /etc/ppp/chap-secrets ]; then
    grep -v '^#' /etc/ppp/chap-secrets | awk '{print \$1}' | tr -d '\"' | sort -u
  else
    echo 'No L2TP users configured.'
  fi
"
echo "=================================================="
REMOTE_EOF
