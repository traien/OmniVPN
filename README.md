# OmniVPN: 1-Click Quad-Protocol VPN Infrastructure



A fully automated, reproducible Infrastructure-as-Code (IaC) management repository for your personal VPN server. 

OmniVPN allows you to provision, configure, and maintain your entire VPS—including security hardening, Docker engine, and a **Quad-Protocol VPN Stack**—with **a single click**.

---

## 🌟 Key Features

- **Quad-Protocol VPN Stack**: Unbeatable bypass and compatibility with simultaneous support for:
  - **WireGuard**: Modern, high-speed, UDP-based VPN for fast roaming on mobile devices.
  - **Shadowsocks (via Xray)**: Superior censorship circumvention and deep packet inspection evasion.
  - **IKEv2**: Perfect for native Windows, iOS, and macOS integration (no app needed).
  - **L2TP/IPsec**: Legacy fallback compatibility.
- **Custom Web Management Dashboard (`:8080`)**: Responsive, dark-themed control plane to create users, monitor active connections, and download client configurations or scan QR codes in 1 click.
- **1-Click Reproducible Provisioning**: From a fresh Debian/Ubuntu install to a fully secured, production-ready server in minutes.
- **Automated Security Hardening**:
  - UFW Firewall configured with strict inbound rules.
  - Fail2Ban enabled for brute-force SSH defense.
  - Ed25519 SSH key authentication.
  - Optimized Linux kernel networking and IP forwarding.
- **Docker-Powered**: VPN server, WireGuard, Xray, and WebUI run in isolated containers with auto-restart policies.
- **Zero Global Host Dependencies**: Pure Bash and standard macOS/Linux utilities.

---

## 🖥️ VPN Control Panel (Web Dashboard)

Access your live VPN control plane directly in your browser by visiting `http://<YOUR_VPS_IP>:8080`.

### Dashboard Capabilities:
- **🛡️ Per-Client Ad & Malware Blocking**: Toggle DNS-level ad, malware, and tracker blocking per client with over 95,000 unified rules.
- **📊 Real-Time Bandwidth Gauges**: Live inbound and outbound throughput chart (Mbps / KB/s) with a 60-second telemetry buffer.
- **🌍 GeoIP Client Telemetry**: Real-time country flag emoji (e.g. 🇩🇪, 🇺🇸, 🇫🇮) attached to every connected device.
- **Live Browsing Activity**: Real-time stream of websites visited by connected clients with timestamps.
- **1-Click User Provisioning**: Create new clients instantly with automatic credentials sync across all 4 protocols.
- **1-Click Download Center**: Scan QR codes for WireGuard & Shadowsocks, or download `.zip` profiles for IKEv2.
- **Server Migration & Backups**: 1-click "Export" to download a `.tar.gz` containing all certificates, credentials, SQLite logs, and configurations.

---

## 🚀 Quickstart
OmniVPN is entirely Dockerized and can be deployed anywhere.

### 1. Configure Credentials
Clone the repository and create your `.env` configuration file:

```bash
git clone https://github.com/traien/OmniVPN.git
cd OmniVPN

cat << EOF > .env
VPN_PUBLIC_IP="<YOUR_VPS_IP>"
VPN_IPSEC_PSK="MySecretPSK123"
VPN_USER="admin"
VPN_PASSWORD="MyVPNPassword123"
WEBUI_PASSWORD="admin"
WEBUI_PORT=8080
EOF
```

### 2. Deploy using Docker Compose
```bash
docker compose up -d
```
*Note: You must ensure your host firewall allows UDP 500/4500 (IPsec), UDP 51820 (WireGuard), and TCP/UDP 8388 (Shadowsocks).*

---

## 📱 Client Connection Guide

### Option 1: WireGuard (Recommended for Mobile)
1. Open the **WebUI** and create a user.
2. Click the **⚙️ (Gear Icon)** next to the user.
3. Open the **WireGuard** app on your phone, tap `+`, and scan the **QR Code**.

### Option 2: Shadowsocks / Xray (Best for Anti-Censorship)
1. Open the **WebUI** and click the **⚙️ (Gear Icon)** next to your user.
2. **Android/iOS:** Use **v2rayNG** (Android) or **Shadowrocket/V2Ray Tun** (iOS) and scan the **QR Code**.
3. **PC/Mac:** Click **Copy URI** (`ss://...`) and paste it into **v2rayN** (Windows) or **V2RayU** (Mac).

### Option 3: Windows 10 & 11 via IKEv2 (Native — No App Needed)
1. In the WebUI, click the download icon next to your user.
2. Unzip the downloaded file on your Windows PC.
3. Right-click on `install_windows_ikev2.bat` $\rightarrow$ **Run as administrator**.
4. Click on your Windows Network icon in the taskbar $\rightarrow$ Select **My IKEv2 VPN** $\rightarrow$ Click **Connect**.

### Option 4: macOS & iOS (IKEv2 via Profile)
1. In the WebUI, click the Apple download icon.
2. Transfer the `.mobileconfig` file via AirDrop to your Apple device.
3. Double click / tap the profile to install $\rightarrow$ toggle **Connect**.

---

## 🔒 Security Notes
- The `.env` file containing your master passwords is automatically ignored by `.gitignore`.
- Ensure you do not accidentally expose your `.env` file if you fork this repository.

## 🔮 Future Roadmap
- **📱 Instant Telegram Alerts**: Real-time notifications via Telegram Bot when devices connect/disconnect, admin logs in, or new certificates are created.
- **💾 Automated Encrypted Offsite Backups to Telegram**: Scheduled AES-256 encrypted backups of certificates, credentials, and SQLite logs sent directly to your Telegram chat.
