#!/usr/bin/env bash
# ==============================================================================
# OmniVPN: Step 00 - Initialize SSH Key & Passwordless Access
# ==============================================================================

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/common.sh
source "${SCRIPT_DIR}/common.sh"

log_info "Step 00: Checking SSH key and connectivity to ${VPS_SSH_USER}@${VPS_IP}..."

# 1. Ensure keys directory and keypair exist
mkdir -p "${PROJECT_ROOT}/keys"
chmod 700 "${PROJECT_ROOT}/keys"

if [[ ! -f "${SSH_KEY_ABSOLUTE}" ]]; then
  log_info "Generating dedicated Ed25519 SSH keypair at ${SSH_KEY_PATH}..."
  ssh-keygen -t ed25519 -f "${SSH_KEY_ABSOLUTE}" -N "" -C "admin@OmniVPN"
  chmod 600 "${SSH_KEY_ABSOLUTE}"
fi

PUB_KEY_CONTENT="$(cat "${SSH_KEY_ABSOLUTE}.pub")"

# 2. Test if key-based access already works
log_info "Testing existing key-based SSH access..."
if ssh -i "${SSH_KEY_ABSOLUTE}" \
       -o IdentitiesOnly=yes \
       -o StrictHostKeyChecking=accept-new \
       -o UserKnownHostsFile="${PROJECT_ROOT}/keys/known_hosts" \
       -o ConnectTimeout=5 \
       -o BatchMode=yes \
       -p "${VPS_SSH_PORT:-22}" \
       "${VPS_SSH_USER:-root}@${VPS_IP}" "echo 'SSH Key OK'" 2>/dev/null; then
  log_success "SSH key authentication is already working!"
  exit 0
fi

# 3. If password is provided, use expect to install public key
if [[ -z "${VPS_ROOT_PASSWORD}" ]]; then
  log_error "SSH key access failed and VPS_ROOT_PASSWORD is empty in config/server.env!"
  log_error "Please set VPS_ROOT_PASSWORD in config/server.env or copy ${SSH_KEY_PATH}.pub manually."
  exit 1
fi

log_info "Installing public SSH key on remote server using root credentials..."

# Use native macOS/Linux expect to authenticate and inject public key
/usr/bin/expect <<EOF
set timeout 30
spawn ssh -o PubkeyAuthentication=no -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile=${PROJECT_ROOT}/keys/known_hosts -p ${VPS_SSH_PORT:-22} ${VPS_SSH_USER:-root}@${VPS_IP} "mkdir -p ~/.ssh && chmod 700 ~/.ssh && echo '${PUB_KEY_CONTENT}' >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys"

expect {
  -nocase "password:" {
    send "${VPS_ROOT_PASSWORD}\r"
    exp_continue
  }
  -nocase "password" {
    send "${VPS_ROOT_PASSWORD}\r"
    exp_continue
  }
  -nocase "yes/no" {
    send "yes\r"
    exp_continue
  }
  eof
}
catch wait result
set exit_status [lindex \$result 3]
exit \$exit_status
EOF

# 4. Verify passwordless access
log_info "Verifying key-based passwordless access..."
if ssh -i "${SSH_KEY_ABSOLUTE}" \
       -o IdentitiesOnly=yes \
       -o StrictHostKeyChecking=accept-new \
       -o UserKnownHostsFile="${PROJECT_ROOT}/keys/known_hosts" \
       -o ConnectTimeout=10 \
       -o BatchMode=yes \
       -p "${VPS_SSH_PORT:-22}" \
       "${VPS_SSH_USER:-root}@${VPS_IP}" "echo 'SSH Key Authentication Successful'" ; then
  log_success "Passwordless SSH key authentication configured successfully!"
else
  log_error "Failed to verify key-based authentication. Please check credentials."
  exit 1
fi
