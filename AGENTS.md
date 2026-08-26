# Repository Guidelines

## Project Structure & Module Organization

OmniVPN is a Docker Compose deployment with a Node.js management dashboard. The root `docker-compose.yml` defines the IPsec, WireGuard, Xray, and WebUI services. Dashboard server modules live in `webui/` (`server.js`, `db.js`, `protocols.js`, DNS/ad-blocking, GeoIP, and bandwidth helpers). Browser assets are in `webui/public/`. GitHub Actions under `.github/workflows/` publish the WebUI image. Treat `profiles/`, `.env`, and runtime SQLite/log data as sensitive generated artifacts, not source code.

## Build, Test, and Development Commands

- `cd webui && npm install` installs the Node.js dependencies.
- `cd webui && npm start` runs the dashboard on `WEBUI_PORT` (default `8080`). Some API operations still require the VPN containers and Docker socket.
- `docker build -t ghcr.io/traien/omnivpn-webui:latest webui` builds the dashboard image used by Compose.
- `docker compose config` validates variable substitution and Compose syntax.
- `docker compose up -d` starts the complete VPN stack; use `docker compose logs -f vpn-webui` to inspect dashboard failures.
- `cd webui && npm run check` runs JavaScript syntax checks and the Node test suite.

## Coding Style & Naming Conventions

Use two-space indentation, semicolons, and single quotes in JavaScript. Keep CommonJS imports (`require`) consistent with the existing code. Name variables and functions in `camelCase`, configuration constants in `UPPER_SNAKE_CASE`, and modules with lowercase or kebab-case filenames such as `dns-proxy.js`. Keep route handlers thin; place persistence, protocol, and telemetry behavior in their existing focused modules. Preserve the section-comment style used in larger files.

## Testing Guidelines

Tests use Node's built-in `node:test` runner. Place tests in `webui/test/` and name them `*.test.js`. Before opening a PR, run `npm run check`, `npm audit --omit=dev`, `docker compose config`, and manually exercise affected dashboard/API flows against a disposable deployment.

## Commit & Pull Request Guidelines

Recent history follows Conventional Commit prefixes, especially `fix:`, `feat:`, and `docs:`. Write imperative, focused subjects, for example `fix: revoke IKEv2 certificate on user deletion`. PRs should explain the user-visible effect, list validation performed, link relevant issues, and include screenshots for dashboard changes. Call out port, volume, environment-variable, or privilege changes explicitly.

## Security & Configuration

Never commit real passwords, PSKs, certificates, private keys, client profiles, or runtime databases. Use a local `.env` and sanitized placeholders in documentation. Review changes involving `/var/run/docker.sock`, privileged containers, firewall ports, and shell-command construction with particular care.
