# ==============================================================================
# OmniVPN: Automation Makefile
# ==============================================================================

.PHONY: help provision ssh check vpn-info vpn-status vpn-users vpn-add vpn-del reboot

help:
	@echo "Available commands:"
	@echo "  make provision    - Run complete 1-click provisioning pipeline on VPS"
	@echo "  make ssh          - Open direct SSH shell into the VPS using project key"
	@echo "  make vpn-info     - Display VPN connection details & client setup instructions"
	@echo "  make vpn-status   - Check status and logs of the VPN server"
	@echo "  make vpn-users    - List all active VPN users and certificates"
	@echo "  make vpn-add      - Add a new VPN user (e.g. make vpn-add USER=john PASS=secret)"
	@echo "  make vpn-del      - Delete a VPN user (e.g. make vpn-del USER=john)"
	@echo "  make backup       - Export full VPN state (certificates, DB, settings)"
	@echo "  make restore      - Import full VPN state (e.g. make restore FILE=backup.tar.gz)"
	@echo "  make reboot       - Gracefully reboot the remote VPS"

provision:
	@chmod +x provision.sh scripts/*.sh
	@./provision.sh

ssh:
	@chmod +x scripts/common.sh
	@bash -c "source scripts/common.sh && ssh -i \"\$${SSH_KEY_ABSOLUTE}\" -p \"\$${VPS_SSH_PORT:-22}\" \"\$${VPS_SSH_USER:-root}@\$${VPS_IP}\""

vpn-info:
	@bash scripts/vpn-info.sh

vpn-status:
	@bash -c "source scripts/common.sh && run_ssh 'docker compose -f /opt/ipsec-vpn/docker-compose.yml ps && docker logs ipsec-vpn-server --tail 25'"

vpn-users:
	@bash scripts/vpn-list-users.sh

vpn-add:
	@if [ -z "$(USER)" ]; then echo "Error: Specify USER=name (optional: PASS=pass)"; exit 1; fi
	@bash scripts/vpn-add-user.sh "$(USER)" "$(PASS)"

vpn-del:
	@if [ -z "$(USER)" ]; then echo "Error: Specify USER=name"; exit 1; fi
	@bash scripts/vpn-del-user.sh "$(USER)"

vpn-profile:
	@if [ -z "$(USER)" ]; then echo "Error: Specify USER=name (e.g. make vpn-profile USER=vpnclient)"; exit 1; fi
	@bash scripts/vpn-get-profile.sh "$(USER)"

reboot:
	@bash -c "source scripts/common.sh && run_ssh 'reboot' || true"

backup:
	@bash scripts/vpn-backup.sh

restore:
	@if [ -z "$(FILE)" ]; then echo "Error: Specify FILE=path/to/backup.tar.gz"; exit 1; fi
	@bash scripts/vpn-restore.sh "$(FILE)"
