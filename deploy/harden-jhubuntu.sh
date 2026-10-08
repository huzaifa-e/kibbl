#!/bin/bash
# Keeps the host from hanging for ever when it runs out of memory or the kernel locks up,
# as it did on 2026-10-08 (alive to ping, nothing else answering, no way to restart it from
# afar). Three layers, from gentlest to last resort:
#
#   1. earlyoom        ends the hungriest process before the machine starts thrashing, and
#                      keeps ssh, docker and tailscale alive so it stays reachable.
#   2. panic-on-OOM    if the kernel's own OOM killer still fires, the kernel panics and
#                      reboots after 10 s instead of thrashing on.
#   3. systemd + HW    the hardware watchdog (/dev/watchdog) reboots the box when systemd can
#      watchdog         no longer pet it: the case the last freeze was (hung, but not an OOM).
#
# Run on jhubuntu (needs sudo):   sudo bash deploy/harden-jhubuntu.sh
# Safe to run again; it only writes config and (re)starts the services.

set -euo pipefail
[ "$(id -u)" -eq 0 ] || exec sudo bash "$0" "$@"

echo "== 1/4  earlyoom (ends the biggest process before a lock-up) =="
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq || true
apt-get install -y earlyoom
# -r 60: report memory every 60 s to the journal.
# -m 8 -s 8: act when both free RAM and free swap fall under 8 %.
# --avoid: never kill the things we need to stay reachable and the database.
# --prefer: shoot a runaway node/chrome/python first.
cat > /etc/default/earlyoom <<'EOF'
EARLYOOM_ARGS="-r 60 -m 8 -s 8 --avoid '^(sshd|systemd|tailscaled|dockerd|containerd|mongod)$' --prefer '^(node|chrome|python3?|java)$'"
EOF
systemctl enable --now earlyoom
systemctl restart earlyoom

echo "== 2/4  reboot on a kernel OOM panic =="
cat > /etc/sysctl.d/99-oom-reboot.conf <<'EOF'
# the kernel panics when it runs fully out of memory instead of hanging
vm.panic_on_oom = 1
# and reboots 10 s after any panic
kernel.panic = 10
kernel.panic_on_oops = 1
EOF
sysctl --system >/dev/null

echo "== 3/4  hardware watchdog (reboots a hung kernel) =="
# load the on-die watchdog of the AMD chipset so /dev/watchdog exists
modprobe sp5100_tco 2>/dev/null || true
echo sp5100_tco > /etc/modules-load.d/watchdog.conf
mkdir -p /etc/systemd/system.conf.d
cat > /etc/systemd/system.conf.d/watchdog.conf <<'EOF'
[Manager]
# systemd pets the watchdog; if it cannot for 30 s the hardware resets the board
RuntimeWatchdogSec=30s
# give a reboot 5 min before the watchdog forces it
RebootWatchdogSec=5min
EOF
systemctl daemon-reexec
if [ -e /dev/watchdog ]; then
    echo "   /dev/watchdog present: hardware watchdog active"
else
    echo "   WARNING: no /dev/watchdog. The chipset watchdog may be off in the BIOS;"
    echo "   earlyoom and panic-on-OOM still protect against the memory case."
fi

echo "== 4/4  memory limits for the containers (one can no longer eat the whole box) =="
echo "   NOTE: set per service in ~/kibbl/docker-compose.yml (mem_limit) and in the EMONI stack."
echo "   Example for kibbl-app:   mem_limit: 1g   and for kibbl-mongo:   mem_limit: 2g"
echo "   Then:  cd ~/kibbl && docker compose up -d"

echo
echo "Done. Active protections:"
systemctl is-active earlyoom | sed 's/^/  earlyoom: /'
echo "  panic_on_oom=$(cat /proc/sys/vm/panic_on_oom)  kernel.panic=$(cat /proc/sys/kernel/panic)s"
echo "  watchdog: $( [ -e /dev/watchdog ] && echo "/dev/watchdog ok" || echo "no /dev/watchdog (check BIOS)" )"
