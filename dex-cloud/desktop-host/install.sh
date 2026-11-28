#!/bin/bash
set -euo pipefail

slots=${DEXCLOUD_DESKTOP_SLOTS:-4}
tenant_memory=${DEXCLOUD_DESKTOP_TENANT_MEMORY:-4G}
tenant_cpu_quota=${DEXCLOUD_DESKTOP_TENANT_CPU_QUOTA:-200%}
provision_user=${DEXCLOUD_DESKTOP_PROVISION_USER:-dexcloud-desktop}

fail() {
  echo "install.sh: $*" >&2
  exit 1
}

[[ $EUID -eq 0 ]] || fail "run as root on the dedicated desktop VPS"
[[ $# -le 1 ]] || fail "usage: install.sh [provision-ed25519-public-key-file]"
[[ $slots =~ ^[0-9]+$ && $slots -ge 1 && $slots -le 32 ]] || fail "DEXCLOUD_DESKTOP_SLOTS must be 1..32"
[[ $tenant_memory =~ ^[0-9]+[MG]$ ]] || fail "DEXCLOUD_DESKTOP_TENANT_MEMORY must look like 4G or 4096M"
[[ $tenant_cpu_quota =~ ^[0-9]+%$ ]] || fail "DEXCLOUD_DESKTOP_TENANT_CPU_QUOTA must look like 200%"
[[ $provision_user =~ ^[a-z_][a-z0-9_-]{0,31}$ ]] || fail "invalid provisioning user name"

# shellcheck disable=SC1091
. /etc/os-release
[[ ${ID-} == "ubuntu" && ( ${VERSION_ID-} == "22.04" || ${VERSION_ID-} == "24.04" ) ]] || fail "Ubuntu 22.04 or 24.04 is required"
arch="$(dpkg --print-architecture)"
[[ $arch == "amd64" || $arch == "arm64" ]] || fail "an amd64 or arm64 VPS is required"
[[ -f /sys/fs/cgroup/cgroup.controllers ]] || fail "cgroup v2 is required for tenant resource limits"

export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y ca-certificates curl gnupg
install -m 0755 -d /etc/apt/keyrings
if [[ ! -f /etc/apt/keyrings/docker.asc ]]; then
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc
fi
cat > /etc/apt/sources.list.d/docker.list <<REPO
deb [arch=${arch} signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu ${VERSION_CODENAME} stable
REPO
apt-get update
apt-get install -y \
  dbus-user-session \
  docker-ce \
  docker-ce-cli \
  docker-ce-rootless-extras \
  fuse-overlayfs \
  iproute2 \
  openssh-server \
  slirp4netns \
  sudo \
  uidmap

systemctl disable --now docker.service docker.socket containerd.service >/dev/null 2>&1 || true
systemctl mask docker.service docker.socket containerd.service >/dev/null 2>&1 || true

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
install -m 0755 "$script_dir/dexcloud-docker-command" /usr/local/sbin/dexcloud-docker-command
install -m 0755 "$script_dir/dexcloud-desktop-provision-command" /usr/local/sbin/dexcloud-desktop-provision-command
install -m 0755 "$script_dir/dexcloud-desktop-slot" /usr/local/sbin/dexcloud-desktop-slot

mkdir -p /etc/dexcloud-desktop /var/lib/dexcloud-desktop/slots
chmod 700 /var/lib/dexcloud-desktop /var/lib/dexcloud-desktop/slots
: > /etc/dexcloud-desktop/users

ensure_subids() {
  local user=$1 file start highest
  for file in /etc/subuid /etc/subgid; do
    if ! grep -q "^${user}:" "$file"; then
      highest=$(awk -F: '{ if ($2 + $3 > highest) highest = $2 + $3 } END { print highest + 0 }' "$file")
      start=$(( highest < 100000 ? 100000 : highest ))
      printf '%s:%s:65536\n' "$user" "$start" >> "$file"
    fi
  done
}

create_user() {
  local user=$1 home uid dropin
  if ! id "$user" >/dev/null 2>&1; then
    useradd --create-home --user-group --shell /bin/sh "$user"
  fi
  usermod --shell /bin/sh "$user"
  passwd -l "$user" >/dev/null 2>&1 || true
  ensure_subids "$user"
  home=$(getent passwd "$user" | cut -d: -f6)
  chmod 700 "$home"
  if ! grep -qx "$user" /etc/dexcloud-desktop/users; then
    printf '%s\n' "$user" >> /etc/dexcloud-desktop/users
  fi

  uid=$(id -u "$user")
  dropin="/etc/systemd/system/user@${uid}.service.d"
  mkdir -p "$dropin"
  cat > "$dropin/dexcloud-tenant-limits.conf" <<LIMITS
[Service]
MemoryMax=${tenant_memory}
CPUQuota=${tenant_cpu_quota}
TasksMax=4096
LIMITS
  systemctl daemon-reload
  loginctl enable-linger "$user" >/dev/null
  systemctl start "user@${uid}.service"
  if systemctl is-active --quiet "user@${uid}.service"; then
    systemctl set-property "user@${uid}.service" MemoryMax="$tenant_memory" CPUQuota="$tenant_cpu_quota" TasksMax=4096 >/dev/null
  fi
  for ((attempt = 0; attempt < 50; attempt++)); do
    [[ -S /run/user/$uid/bus ]] && break
    sleep 0.1
  done
  [[ -S /run/user/$uid/bus ]] || fail "user systemd did not start for $user"
  runuser -u "$user" -- env \
    HOME="$home" \
    PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
    XDG_RUNTIME_DIR="/run/user/$uid" \
    DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/$uid/bus" \
    /usr/bin/systemctl --user reset-failed docker.service >/dev/null 2>&1 || true
  runuser -u "$user" -- env \
    HOME="$home" \
    PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
    XDG_RUNTIME_DIR="/run/user/$uid" \
    DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/$uid/bus" \
    /usr/bin/dockerd-rootless-setuptool.sh install >/dev/null
  runuser -u "$user" -- env \
    HOME="$home" \
    PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
    XDG_RUNTIME_DIR="/run/user/$uid" \
    DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/$uid/bus" \
    /usr/bin/systemctl --user enable --now docker.service >/dev/null
}

for ((index = 0; index < slots; index++)); do
  create_user "dxd${index}"
done

if ! id "$provision_user" >/dev/null 2>&1; then
  useradd --create-home --user-group --shell /bin/sh "$provision_user"
fi
usermod --shell /bin/sh "$provision_user"
passwd -l "$provision_user" >/dev/null 2>&1 || true
provision_home=$(getent passwd "$provision_user" | cut -d: -f6)
chmod 700 "$provision_home"
mkdir -p /etc/ssh/dexcloud-authorized_keys
chmod 755 /etc/ssh/dexcloud-authorized_keys
chown root:root /etc/ssh/dexcloud-authorized_keys

cat > /etc/sudoers.d/dexcloud-desktop <<SUDOERS
${provision_user} ALL=(root) NOPASSWD: /usr/local/sbin/dexcloud-desktop-slot
SUDOERS
chmod 0440 /etc/sudoers.d/dexcloud-desktop
visudo -cf /etc/sudoers.d/dexcloud-desktop >/dev/null

cat > /etc/ssh/sshd_config.d/99-dexcloud-desktop.conf <<SSHD
Match User ${provision_user},dxd*
    AuthorizedKeysFile /etc/ssh/dexcloud-authorized_keys/%u
    PasswordAuthentication no
    PubkeyAuthentication yes
    DisableForwarding yes
    PermitTTY no
SSHD
install -d -m 0755 /run/sshd
if ! /usr/sbin/sshd -t; then
  rm -f /etc/ssh/sshd_config.d/99-dexcloud-desktop.conf
  fail "the generated sshd configuration is invalid"
fi
systemctl reload ssh >/dev/null 2>&1 || systemctl reload sshd >/dev/null 2>&1 || true

if [[ $# -eq 1 ]]; then
  key_text=$(tr -d '\r\n' < "$1")
  [[ $key_text =~ ^ssh-ed25519\ [A-Za-z0-9+/=]+([[:space:]][^[:space:]]+)?$ ]] || fail "provisioning key must be one ssh-ed25519 public key"
  tmp=$(mktemp "/etc/ssh/dexcloud-authorized_keys/.${provision_user}.XXXXXX")
  printf 'command="/usr/local/sbin/dexcloud-desktop-provision-command",restrict %s\n' "$key_text" > "$tmp"
  chmod 644 "$tmp"
  chown root:root "$tmp"
  mv "$tmp" "/etc/ssh/dexcloud-authorized_keys/$provision_user"
else
  echo "No provisioning public key was installed. Add one as:" >&2
  echo "  command=\"/usr/local/sbin/dexcloud-desktop-provision-command\",restrict ssh-ed25519 AAAA..." >&2
  echo "in /etc/ssh/dexcloud-authorized_keys/${provision_user} (root-owned, mode 0644)." >&2
fi

printf 'installed %s tenant slots (dxd0..dxd%s), each capped at %s memory and %s CPU\n' "$slots" "$((slots - 1))" "$tenant_memory" "$tenant_cpu_quota"
