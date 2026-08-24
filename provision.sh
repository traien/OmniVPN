#!/usr/bin/env bash
# ==============================================================================
# OmniVPN: Master 1-Click Provisioning & Reprovisioning Script
# ==============================================================================
# Run this script on a fresh VPS or after formatting to restore everything
# completely automatically in one click.
# ==============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Run setup wizard if env files are missing
bash "${SCRIPT_DIR}/scripts/setup.sh"

# shellcheck source=scripts/common.sh
source "${SCRIPT_DIR}/scripts/common.sh"

echo -e "${BOLD}================================================================${NC}"
echo -e "${BOLD}              OmniVPN: Automated 1-Click Provisioner             ${NC}"
echo -e "${BOLD}================================================================${NC}"
echo -e "Target Server: ${GREEN}${VPS_SSH_USER}@${VPS_IP}:${VPS_SSH_PORT:-22}${NC}"
echo ""

STEP_FILTER="${1:-all}"

run_step() {
  local script="$1"
  local name="$2"

  if [[ "${STEP_FILTER}" == "all" || "${STEP_FILTER}" == "${script}" || "${STEP_FILTER}" == *"${script}"* ]]; then
    echo ""
    echo -e "${BOLD}>>> Running Step: ${name} (${script}) <<<${NC}"
    bash "${PROJECT_ROOT}/scripts/${script}"
  fi
}

# Execute Provisioning Pipeline
run_step "00-init-ssh.sh"       "Initialize SSH Key & Passwordless Access"
run_step "01-system-setup.sh"   "Base System Upgrade & Kernel Tuning"
run_step "02-docker.sh"         "Install Docker CE & Compose Plugin"
run_step "03-security.sh"       "Firewall (UFW) & Fail2Ban Hardening"
run_step "04-vpn-deploy.sh"     "Deploy IPsec / IKEv2 VPN Server"

echo ""
echo -e "${BOLD}================================================================${NC}"
log_success "All provisioning steps completed successfully!"
echo -e "${BOLD}================================================================${NC}"
echo ""

# Show connection instructions
bash "${PROJECT_ROOT}/scripts/vpn-info.sh"
