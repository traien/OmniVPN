# OmniVPN

OmniVPN is a self-hosted, four-protocol VPN stack with a private operations dashboard. Docker Compose runs IKEv2/L2TP, WireGuard, Shadowsocks/Xray, the DNS policy service, and the WebUI as one deployment.

## What it provides

- IKEv2, L2TP/IPsec, WireGuard, and Shadowsocks client provisioning
- Live tunnel presence, host throughput, and gateway diagnostics
- Per-client DNS ad blocking, with browsing-history collection disabled by default
- Platform connection kits and local QR-code generation
- Authenticated, AES-256-GCM encrypted migration backups
- Rate-limited administration, bounded uploads, and CI security checks without complicating private deployments

## Requirements

- A Linux VPS with Docker Engine and Compose v2
- UDP ports `500`, `4500`, and `51820`; TCP/UDP `8388`
- Optional HTTPS reverse proxy or private SSH/Tailscale tunnel when accessing the dashboard remotely

The dashboard binds to `127.0.0.1:8080` by default and works over local HTTP. Use HTTPS if you expose it beyond the host.

## Deploy

```bash
cp .env.example .env
# Replace every placeholder with an independently generated secret.
docker compose config
docker compose up -d --build
docker compose ps
```

Long random credentials are recommended but not enforced for personal deployments. The default `WEBUI_SECURE_COOKIE=false` works over local HTTP; set it to `true` when using HTTPS. Set `WEBUI_TRUST_PROXY=true` only when exactly one trusted reverse proxy fronts the dashboard.

IKEv2 profile passwords are optional. Set `VPN_PROTECT_CONFIG=yes` to enable them; the generated Windows installer automatically includes the configured import password.

Open the dashboard locally or through your chosen reverse proxy. Use `docker compose logs -f vpn-webui` for startup diagnostics.

## Privacy controls

DNS history and external GeoIP lookup are opt-in:

```dotenv
DNS_LOGGING_ENABLED=false
DNS_LOG_RETENTION_DAYS=30
GEOIP_ENABLED=false
```

Ad blocking still works when DNS history is disabled. WireGuard profiles use the internal DNS policy service at `172.20.0.3`.

## Development

```bash
cd webui
npm ci
npm run check
npm audit --omit=dev
docker build -t omnivpn-webui:test .
```

The CI workflow runs these checks before publishing `ghcr.io/traien/omnivpn-webui`.

## Backups

Exports use the `.ovpnbackup` format and are encrypted with `BACKUP_PASSPHRASE`. Restore validates authentication, allowed paths, entry types, file count, and expanded size before touching active configuration. Store the passphrase separately from the backup.

## Security

Generated client profiles and private-key formats are ignored by Git. Never commit `.env`, `profiles/`, certificates, runtime databases, or backup archives. Review [SECURITY.md](SECURITY.md) before operating an internet-facing deployment.
