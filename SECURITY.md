# Security Policy

## Reporting

Do not open public issues containing vulnerabilities, credentials, server addresses, certificates, or client activity. Report vulnerabilities through the repository's private GitHub Security Advisory feature.

## Deployment baseline

- Terminate TLS before the WebUI and keep its default loopback binding.
- Use independent random values for every secret in `.env`.
- Set `WEBUI_SECURE_COOKIE=true` when the dashboard is served through HTTPS. Leave it `false` for loopback-only HTTP access.
- Leave DNS logging and GeoIP disabled unless users have been informed and retention is justified.
- Pin `IPSEC_IMAGE` to an architecture-specific digest in controlled environments.
- Store `.ovpnbackup` files and `BACKUP_PASSPHRASE` separately.
- Restrict host access: the WebUI can manage specific containers through the Docker socket, which remains a privileged trust boundary.

## Credential incident response

If a client profile, `.p12`, PSK, password, or backup is exposed, revoke the affected client, rotate the associated secret, remove the artifact from Git history and package registries, and review gateway logs for unauthorized access. Deleting a local file alone does not revoke it.
