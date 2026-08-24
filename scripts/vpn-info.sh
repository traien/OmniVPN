#!/usr/bin/env bash
# ==============================================================================
# OmniVPN: Display VPN Connection Information & Guide
# ==============================================================================

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/common.sh
source "${SCRIPT_DIR}/common.sh"

# Source VPN config
if [[ -f "${VPN_ENV}" ]]; then
  # shellcheck source=/dev/null
  source "${VPN_ENV}"
fi

echo -e "${BOLD}================================================================${NC}"
echo -e "${BOLD}              IPsec / IKEv2 VPN Connection Details               ${NC}"
echo -e "${BOLD}================================================================${NC}"
echo -e "Server Address (IP):  ${GREEN}${VPS_IP}${NC}"
echo -e "IPsec Pre-Shared Key: ${YELLOW}${VPN_IPSEC_PSK:-[Check config/vpn.env]}${NC}"
echo -e "Default VPN User:     ${GREEN}${VPN_USER:-admin}${NC}"
echo -e "Default VPN Password: ${YELLOW}${VPN_PASSWORD:-[Check config/vpn.env]}${NC}"
echo -e "Web Management UI:    ${BOLD}${GREEN}http://${VPS_IP}:${WEBUI_PORT:-8080}${NC}"
echo -e "Web Admin Password:   ${YELLOW}${WEBUI_PASSWORD:-[Check config/vpn.env]}${NC}"
echo ""
echo -e "${BOLD}--- How to Connect on Windows 10 / 11 (0 Apps Needed) ---${NC}"
echo "1. Open Windows Settings -> Network & Internet -> VPN -> Add VPN connection."
echo "2. Set VPN provider to: Windows (built-in)"
echo "3. Connection name: My VPS"
echo "4. Server name or address: ${VPS_IP}"
echo "5. VPN type: 'L2TP/IPsec with pre-shared key' OR 'IKEv2'"
echo "6. Pre-shared key: ${VPN_IPSEC_PSK:-[Your PSK]}"
echo "7. Type of sign-in info: User name and password"
echo "8. Enter Username and Password -> Save & Click Connect!"
echo ""
echo -e "${BOLD}--- How to Connect on macOS / iOS (0 Apps Needed) ---${NC}"
echo "1. System Settings -> VPN -> Add VPN Configuration -> L2TP over IPsec (or IKEv2)."
echo "2. Server Address: ${VPS_IP}"
echo "3. Account: ${VPN_USER:-admin}"
echo "4. Password: ${VPN_PASSWORD:-...} | Secret (PSK): ${VPN_IPSEC_PSK:-...}"
echo "5. Click Connect!"
echo -e "${BOLD}================================================================${NC}"
