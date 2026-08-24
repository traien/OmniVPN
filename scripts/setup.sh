#!/usr/bin/env bash
# ==============================================================================
# OmniVPN: Interactive Setup Wizard
# ==============================================================================

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

SERVER_ENV="${PROJECT_ROOT}/config/server.env"
VPN_ENV="${PROJECT_ROOT}/config/vpn.env"

echo -e "\033[1;36m================================================================\033[0m"
echo -e "\033[1;36m              Welcome to the OmniVPN Setup Wizard               \033[0m"
echo -e "\033[1;36m================================================================\033[0m"
echo ""

if [[ ! -f "${SERVER_ENV}" ]]; then
    echo -e "\033[1;33m>>> Configuring Server Connection (server.env) <<<\033[0m"
    read -rp "Enter your VPS IP Address: " vps_ip
    read -s -rp "Enter your VPS root password: " vps_password
    echo ""
    echo ""
    
    cat << ENV_EOF > "${SERVER_ENV}"
# ==============================================================================
# VPS Server Configuration (Auto-Generated)
# ==============================================================================
VPS_IP="${vps_ip}"
VPS_SSH_USER="root"
VPS_SSH_PORT="22"
VPS_ROOT_PASSWORD="${vps_password}"
SSH_KEY_PATH="keys/id_ed25519"
ENV_EOF
    echo -e "\033[0;32m[SUCCESS]\033[0m Saved server configuration."
    echo ""
fi

if [[ ! -f "${VPN_ENV}" ]]; then
    echo -e "\033[1;33m>>> Configuring VPN Master Passwords (vpn.env) <<<\033[0m"
    
    # Generate random secure IPsec PSK
    DEFAULT_PSK=$(LC_ALL=C tr -dc 'A-Za-z0-9' </dev/urandom | head -c 24)
    read -rp "Enter IPsec Pre-Shared Key (Press Enter to auto-generate: ${DEFAULT_PSK}): " vpn_psk
    vpn_psk=${vpn_psk:-${DEFAULT_PSK}}

    read -s -rp "Enter Web Dashboard Password (leave blank for 'admin'): " webui_pass
    webui_pass=${webui_pass:-admin}
    echo ""

    # Generate default VPN user
    read -rp "Enter Default VPN Username (leave blank for 'admin'): " vpn_user
    vpn_user=${vpn_user:-admin}
    
    DEFAULT_PASS=$(LC_ALL=C tr -dc 'A-Za-z0-9' </dev/urandom | head -c 16)
    read -s -rp "Enter Default VPN Password (Press Enter to auto-generate): " vpn_pass
    vpn_pass=${vpn_pass:-${DEFAULT_PASS}}
    echo ""
    
    if [[ -f "${SERVER_ENV}" ]]; then
        source "${SERVER_ENV}"
    fi

    cat << VPN_EOF > "${VPN_ENV}"
# ==============================================================================
# OmniVPN Master Credentials (Auto-Generated)
# ==============================================================================
VPN_PUBLIC_IP="${VPS_IP:-127.0.0.1}"
VPN_IPSEC_PSK="${vpn_psk}"
VPN_USER="${vpn_user}"
VPN_PASSWORD="${vpn_pass}"
WEBUI_PASSWORD="${webui_pass}"
WEBUI_PORT=8080
VPN_EOF
    
    echo -e "\033[0;32m[SUCCESS]\033[0m Saved VPN credentials."
    echo ""
fi
