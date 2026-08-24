#!/bin/bash
# ------------------------------------------------------------------------------
# OmniVPN: Import full VPN backup via local WebUI API
# ------------------------------------------------------------------------------

set -e
cd "$(dirname "$0")/.."

source scripts/common.sh
source config/server.env
source config/vpn.env

FILE_PATH="$1"

if [ -z "$FILE_PATH" ]; then
    echo "Usage: ./scripts/vpn-restore.sh <path/to/backup.tar.gz>"
    exit 1
fi

if [ ! -f "$FILE_PATH" ]; then
    echo "❌ Error: File not found at $FILE_PATH"
    exit 1
fi

FILENAME=$(basename "$FILE_PATH")
WEBUI_PORT=${WEBUI_PORT:-8080}
PASSWORD=${WEBUI_PASSWORD}

echo "⚠️ WARNING: This will overwrite ALL current certificates, user accounts, and credentials."
echo "⚠️ The VPN server will be restarted."
read -p "Are you sure you want to proceed? (y/N) " -n 1 -r
echo
if [[ ! $REPLY =~ ^[Yy]$ ]]; then
    echo "Aborted."
    exit 1
fi

echo "📤 Uploading ${FILENAME} to remote server..."
scp -i "$SSH_KEY_ABSOLUTE" -P "${VPS_SSH_PORT:-22}" -q "$FILE_PATH" "${VPS_SSH_USER:-root}@${VPS_IP}:/tmp/${FILENAME}"

# Create a temporary script on the remote host to upload via localhost
cat << 'EOF' > /tmp/OmniVPN-remote-restore.sh
#!/bin/bash
set -e
PASSWORD="$1"
PORT="$2"
FILEPATH="$3"

echo "-> Authenticating locally..."
curl -s -X POST -H "Content-Type: application/json" \
     -d "{\"password\":\"$PASSWORD\"}" \
     -c /tmp/vps_cookies.txt \
     "http://127.0.0.1:${PORT}/api/auth/login" > /dev/null

echo "-> Importing backup..."
RESPONSE=$(curl -s -b /tmp/vps_cookies.txt \
     -X POST -F "backup=@${FILEPATH}" \
     "http://127.0.0.1:${PORT}/api/backup/import")

rm -f /tmp/vps_cookies.txt
echo "$RESPONSE"
EOF

chmod +x /tmp/OmniVPN-remote-restore.sh
scp -i "$SSH_KEY_ABSOLUTE" -P "${VPS_SSH_PORT:-22}" -q /tmp/OmniVPN-remote-restore.sh "${VPS_SSH_USER:-root}@${VPS_IP}:/tmp/"

echo "📥 Executing import..."
ssh -i "$SSH_KEY_ABSOLUTE" -p "${VPS_SSH_PORT:-22}" "${VPS_SSH_USER:-root}@${VPS_IP}" "/tmp/OmniVPN-remote-restore.sh '$PASSWORD' '$WEBUI_PORT' '/tmp/${FILENAME}'" | jq -r 'if .success then "✅ " + .message + "\nRestored: " + (.restored | join(", ")) else "❌ " + .error end' || echo "Failed to parse response."

# Cleanup remote
ssh -i "$SSH_KEY_ABSOLUTE" -p "${VPS_SSH_PORT:-22}" "${VPS_SSH_USER:-root}@${VPS_IP}" "rm -f /tmp/OmniVPN-remote-restore.sh /tmp/${FILENAME}"
rm -f /tmp/OmniVPN-remote-restore.sh

echo "Done."
