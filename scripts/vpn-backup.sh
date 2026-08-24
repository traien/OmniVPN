#!/bin/bash
# ------------------------------------------------------------------------------
# OmniVPN: Export full VPN backup via local WebUI API
# ------------------------------------------------------------------------------

set -e
cd "$(dirname "$0")/.."

source scripts/common.sh
source config/server.env
source config/vpn.env

# Use WEBUI_PASSWORD from vpn.env
WEBUI_PORT=${WEBUI_PORT:-8080}
PASSWORD=${WEBUI_PASSWORD}

echo "📦 Requesting backup archive from WebUI API..."

# Create a temporary script on the remote host to fetch the backup via localhost
# This avoids needing to expose or hit the public IP
cat << 'EOF' > /tmp/OmniVPN-remote-backup.sh
#!/bin/bash
set -e
PASSWORD="$1"
PORT="$2"
DATE=$(date +%Y-%m-%d)
FILENAME="vpn_backup_${DATE}.tar.gz"

echo "-> Authenticating locally..."
curl -s -X POST -H "Content-Type: application/json" \
     -d "{\"password\":\"$PASSWORD\"}" \
     -c /tmp/vps_cookies.txt \
     "http://127.0.0.1:${PORT}/api/auth/login" > /dev/null

echo "-> Downloading backup..."
curl -s -b /tmp/vps_cookies.txt \
     -o "/tmp/${FILENAME}" \
     "http://127.0.0.1:${PORT}/api/backup/export"

rm -f /tmp/vps_cookies.txt
echo "/tmp/${FILENAME}"
EOF

chmod +x /tmp/OmniVPN-remote-backup.sh

# Upload script to VPS
scp -i "$SSH_KEY_ABSOLUTE" -P "${VPS_SSH_PORT:-22}" -q /tmp/OmniVPN-remote-backup.sh "${VPS_SSH_USER:-root}@${VPS_IP}:/tmp/"

# Execute remote script to generate the backup file path
REMOTE_FILE=$(ssh -i "$SSH_KEY_ABSOLUTE" -p "${VPS_SSH_PORT:-22}" "${VPS_SSH_USER:-root}@${VPS_IP}" "/tmp/OmniVPN-remote-backup.sh '$PASSWORD' '$WEBUI_PORT' | tail -n 1")

if [ -z "$REMOTE_FILE" ]; then
    echo "❌ Failed to generate backup on the remote server."
    exit 1
fi

LOCAL_FILE=$(basename "$REMOTE_FILE")

# Download the file
echo "⬇️ Downloading ${LOCAL_FILE} to host..."
scp -i "$SSH_KEY_ABSOLUTE" -P "${VPS_SSH_PORT:-22}" -q "${VPS_SSH_USER:-root}@${VPS_IP}:${REMOTE_FILE}" "./${LOCAL_FILE}"

# Cleanup remote
ssh -i "$SSH_KEY_ABSOLUTE" -p "${VPS_SSH_PORT:-22}" "${VPS_SSH_USER:-root}@${VPS_IP}" "rm -f /tmp/OmniVPN-remote-backup.sh ${REMOTE_FILE}"
rm -f /tmp/OmniVPN-remote-backup.sh

echo "✅ Backup successfully saved to: ./${LOCAL_FILE}"
