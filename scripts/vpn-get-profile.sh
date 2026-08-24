#!/usr/bin/env bash
# ==============================================================================
# OmniVPN: Download Client Configuration Profiles (iOS/macOS/Android)
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

PROFILES_DIR="${PROJECT_ROOT}/profiles/${USERNAME}"
mkdir -p "${PROFILES_DIR}"

log_info "Exporting client profiles for '${USERNAME}' from ${VPS_IP}..."

run_ssh "bash -s -- '${USERNAME}'" <<'REMOTE_EOF'
set -euo pipefail
USERNAME="$1"
docker exec ipsec-vpn-server ikev2.sh --exportclient "${USERNAME}" || true
REMOTE_EOF

# Copy generated files to local profiles folder
log_info "Downloading configuration files to ${PROFILES_DIR}..."
run_ssh "mkdir -p /tmp/ikev2-export && docker cp ipsec-vpn-server:/etc/ipsec.d/${USERNAME}.p12 /tmp/ikev2-export/ 2>/dev/null || true; docker cp ipsec-vpn-server:/etc/ipsec.d/${USERNAME}.mobileconfig /tmp/ikev2-export/ 2>/dev/null || true; docker cp ipsec-vpn-server:/etc/ipsec.d/${USERNAME}.sswan /tmp/ikev2-export/ 2>/dev/null || true"
run_scp_download "/tmp/ikev2-export/${USERNAME}*" "${PROFILES_DIR}/"
run_ssh "rm -rf /tmp/ikev2-export"

# Generate Windows 1-click installer script in the profiles folder
cat > "${PROFILES_DIR}/install_windows_ikev2.bat" <<BAT_EOF
@echo off
:: Check for Administrator privileges
net session >nul 2>&1
if %errorlevel% neq 0 (
    echo Requesting administrator privileges...
    powershell -Command "Start-Process cmd -ArgumentList '/c \"\"%~dpnx0\"\"' -Verb RunAs"
    exit /b
)

cd /d "%~dp0"
echo ========================================================
echo   Setting up IKEv2 VPN Connection: My IKEv2 VPN
echo ========================================================

echo [1/3] Importing ${USERNAME}.p12 certificate...
certutil -f -p "" -importpfx "%~dp0${USERNAME}.p12" NoExport

echo [2/3] Configuring Windows IPsec registry parameters...
REG ADD HKLM\SYSTEM\CurrentControlSet\Services\RasMan\Parameters /v NegotiateDH2048_AES256 /t REG_DWORD /d 0x1 /f

echo [3/3] Creating Windows IKEv2 VPN profile...
powershell -Command "Remove-VpnConnection -Name 'My IKEv2 VPN' -Force -ErrorAction SilentlyContinue; Add-VpnConnection -ServerAddress '${VPS_IP}' -Name 'My IKEv2 VPN' -TunnelType IKEv2 -AuthenticationMethod MachineCertificate -EncryptionLevel Required -PassThru; Set-VpnConnectionIPsecConfiguration -ConnectionName 'My IKEv2 VPN' -AuthenticationTransformConstants GCMAES128 -CipherTransformConstants GCMAES128 -EncryptionMethod AES256 -IntegrityCheckMethod SHA256 -PfsGroup None -DHGroup Group14 -PassThru -Force"

echo.
echo ========================================================
echo Setup complete! 
echo Click the Network icon on your taskbar and click Connect on 'My IKEv2 VPN'.
echo ========================================================
pause
BAT_EOF

log_success "Profiles and Windows 1-click installer saved to ${PROFILES_DIR}/"
ls -la "${PROFILES_DIR}"
