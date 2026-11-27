#!/usr/bin/env bash
# PROBE (probe/packaging, never merged): the Linux half of the packaging probe.
# usage: linux.sh <phase>   (phases are listed at the bottom; the workflow runs them in order)
set -o pipefail
PHASE="${1:-}"
# shellcheck source=common.sh
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"

DEB_GLOB="$DESK/dist-a1/*.deb"
INSTALLED='/opt/Tenon/tenon'
INSTALLED_MAIN='/opt/Tenon/tenon( |$)'
SYSCTL_KEY=kernel.apparmor_restrict_unprivileged_userns

readings() {
  # shellcheck disable=SC1091
  res "os: $(. /etc/os-release && echo "$PRETTY_NAME"), kernel $(uname -r)"
  local key
  for key in kernel/apparmor_restrict_unprivileged_userns kernel/unprivileged_userns_clone \
    user/max_user_namespaces; do
    res "$(echo "$key" | tr / .) = $(cat "/proc/sys/$key" 2>/dev/null || echo '(absent)')"
  done
  res "bwrap: $(command -v bwrap || echo none) $(bwrap --version 2>/dev/null); socat: $(command -v socat || echo none); rg: $(command -v rg || echo none); xvfb-run: $(command -v xvfb-run || echo none)"
}

kill_tenon() {
  pkill -f "$INSTALLED" 2>/dev/null || true
  sleep 3
}

probe_app() { # label: self-check from the installed app, no --no-sandbox
  local label=$1 status
  kill_tenon
  rm -f "$OUT/$label.json"
  TENON_PROBE=1 TENON_PROBE_OUT="$OUT/$label.json" \
    python3 "$PROBE/run-timeout.py" 180 xvfb-run -a "$INSTALLED" >"$OUT/$label.log" 2>&1
  status=$?
  res "[$label] exit=$status"
  tail -n 20 "$OUT/$label.log" | cut -c1-300
  if [ ! -s "$OUT/$label.json" ]; then
    res "[$label] no self-check; the app's last output lines:"
    tail -n 8 "$OUT/$label.log" | cut -c1-240 | res
  fi
  show_probe "$OUT/$label.json" "$label"
  kill_tenon
}

phase_libs() {
  command -v xvfb-run >/dev/null || sudo apt-get install -y xvfb
  # The OS libraries Electron's own Chromium needs, for the development run below.
  (cd "$DESK" && pnpm exec playwright install-deps chromium) 2>&1 | tail -n 5
  readings
}

phase_dev() {
  cd "$DESK" || exit 1
  res "== P6 (packaging): the development app name, unpackaged Electron on apps/desktop"
  rm -f "$OUT/dev-probe.json"
  TENON_PROBE=1 TENON_PROBE_OUT="$OUT/dev-probe.json" \
    python3 "$PROBE/run-timeout.py" 180 xvfb-run -a pnpm exec electron . --no-sandbox \
    >"$OUT/dev-probe.log" 2>&1
  res "dev self-check exit=$?"
  tail -n 15 "$OUT/dev-probe.log" | cut -c1-300
  show_probe "$OUT/dev-probe.json" "development build"
  PROBE_PREFIX=(xvfb-run -a)
  PROBE_FLAGS=(--no-sandbox)
  res "== error-logs P2: main-process errors in Electron 44 (unpackaged)"
  main_error_scenarios
}

phase_crash_dev() { # error-logs P1: a development build, data dir in a temp dir
  local data="$WORK/ud-dev"
  rm -rf "$data"
  cd "$DESK" || exit 1
  res "== error-logs P1: crash dumps from a development build (data dir $data)"
  crash_run dev 'electron/dist/electron( |$)' "$data" \
    xvfb-run -a pnpm exec electron . --no-sandbox "--user-data-dir=$data"
}

phase_build() {
  local status
  echo "::group::electron-builder deb"
  (cd "$DESK" && pnpm exec electron-builder --linux --publish never \
    -c.directories.output=dist-a1) >"$OUT/build-a1.log" 2>&1
  status=$?
  grep -vE 'duplicate dependency references|platform-specific optional' "$OUT/build-a1.log" |
    cut -c1-300 | tail -n 40
  echo "::endgroup::"
  res "electron-builder deb exit=$status"
  res "dist-a1: $(ls "$DESK"/dist-a1 2>&1 | tr '\n' ' ')"
  if [ "$status" -ne 0 ]; then
    res "-- why the build failed (last lines):"
    grep -vE 'duplicate dependency references|platform-specific optional' "$OUT/build-a1.log" |
      cut -c1-300 | tail -n 14 | res
  fi
  return $status
}

phase_install() {
  local deb status
  # shellcheck disable=SC2086
  deb="$(ls $DEB_GLOB 2>/dev/null | head -1)"
  res "== P3: the deb: ${deb:-NOT FOUND ($DEB_GLOB)}"
  [ -n "$deb" ] || return 1
  ls -l "$deb" | res
  dpkg-deb -I "$deb" | grep -E '^ (Package|Version|Architecture|Depends|Maintainer|Installed-Size)' | cut -c1-300 | res
  sudo apt-get update -qq
  sudo apt-get install -y "$deb" >"$OUT/apt-install.log" 2>&1
  status=$?
  res "apt-get install ./deb exit=$status"
  tail -n 15 "$OUT/apt-install.log" | cut -c1-240
  [ "$status" -eq 0 ] || tail -n 8 "$OUT/apt-install.log" | cut -c1-240 | res
  res "dpkg status: $(dpkg -s tenon 2>&1 | grep -E '^Status' | head -1)"
  res "installed: $(ls /opt/Tenon 2>&1 | tr '\n' ' ' | cut -c1-300)"
  res "perms: $(stat -c '%a %U:%G %n' /opt/Tenon/chrome-sandbox "$INSTALLED" 2>&1 | tr '\n' ';')"
  res "sandbox helpers: $(ls -lR /opt/Tenon/resources/sandbox 2>&1 | grep -E 'apply-seccomp|srt-proxy-agent' | tr '\n' ';' | cut -c1-300)"
  res "missing shared libraries: $(ldd "$INSTALLED" 2>&1 | grep 'not found' | tr '\n' ';' || true)"
  res "-- AppArmor: $(ls -l /etc/apparmor.d 2>&1 | grep -iE 'tenon|bwrap' | tr '\n' ';' || echo 'no tenon or bwrap profile file')"
  for profile in /etc/apparmor.d/*tenon*; do
    [ -f "$profile" ] && {
      res "profile $profile:"
      cat "$profile" | res
    }
  done
  res "apparmor_status: $(sudo apparmor_status 2>&1 | grep -iE 'tenon|bwrap|profiles are loaded|apparmor module' | head -n 6 | tr '\n' ';')"
  res "desktop entry: $(grep -E '^(Exec|Name|Icon)=' /usr/share/applications/tenon.desktop 2>&1 | tr '\n' ';')"
  readings
}

phase_p1() {
  local exec_line main renderers pid waited=0
  exec_line="$(grep -m1 '^Exec=' /usr/share/applications/tenon.desktop | sed 's/^Exec=//; s/ %[UuFf]//g')"
  res "== P1: desktop entry Exec: ${exec_line:-none (is the deb installed?)}"
  case "$exec_line" in *--no-sandbox*) res "WARNING: the desktop entry passes --no-sandbox" ;; esac
  kill_tenon
  xvfb-run -a bash -c "$exec_line" >"$OUT/p1-plain.log" 2>&1 &
  sleep 30
  main="$(python3 "$PROBE/proc.py" main "$INSTALLED_MAIN")"
  res "[plain] main pid after 30 s: ${main:-none (the app is not running)}"
  ps -axo pid,etime,args | grep -E '/opt/Tenon/tenon' | grep -v grep | cut -c1-200 | head -n 12
  if [ -n "$main" ]; then
    res "main command line: $(tr '\0' ' ' </proc/"$main"/cmdline | cut -c1-200)"
    renderers="$(python3 "$PROBE/proc.py" renderers "$main")"
    for pid in $main $renderers; do
      res "pid $pid: $(grep -E '^(Seccomp|NoNewPrivs):' /proc/"$pid"/status | tr '\n\t' '  ') userns=$(readlink /proc/"$pid"/ns/user)"
    done
    kill -TERM "$main"
    while kill -0 "$main" 2>/dev/null && [ "$waited" -lt 20 ]; do
      sleep 1
      waited=$((waited + 1))
    done
    if kill -0 "$main" 2>/dev/null; then res "[plain] SIGTERM: still running after 20 s"; else res "[plain] SIGTERM: exited after ${waited} s"; fi
  fi
  echo "-- output:"
  tail -n 60 "$OUT/p1-plain.log" | cut -c1-300
  res "[plain] output lines that look like errors or mention the sandbox:"
  grep -iE 'error|fail|cannot|uncaught|exception|ERR_|sandbox' "$OUT/p1-plain.log" | cut -c1-240 | head -n 15 | res
  kill_tenon
}

phase_tools() {
  sudo apt-get install -y bubblewrap socat ripgrep 2>&1 | tail -n 3
  readings
}

phase_p3() {
  local original label
  original="$(cat /proc/sys/kernel/apparmor_restrict_unprivileged_userns 2>/dev/null || echo 1)"
  res "== P3 (a): nothing changed (sysctl=$original)"
  res "bwrap-like profiles in /etc/apparmor.d: $(ls /etc/apparmor.d | grep -iE 'bwrap|unpriv' | tr '\n' ' ')"
  probe_app p3-a-unchanged

  res "== P3 (c): sysctl $SYSCTL_KEY=0"
  sudo sysctl -w "$SYSCTL_KEY=0"
  probe_app p3-c-sysctl0
  sudo sysctl -w "$SYSCTL_KEY=$original"

  res "== P3 (b): the bwrap AppArmor profile from spec 04's fix (sysctl back at $original)"
  sudo tee /etc/apparmor.d/bwrap >/dev/null <<EOF
abi <abi/4.0>,
include <tunables/global>

profile bwrap $(command -v bwrap) flags=(unconfined) {
  userns,

  # Site-specific additions and overrides. See local/README for details.
  include if exists <local/bwrap>
}
EOF
  sudo apparmor_parser -r /etc/apparmor.d/bwrap
  res "apparmor_parser exit=$?"
  sudo systemctl reload apparmor 2>&1 | tail -n 3
  probe_app p3-b-bwrap-profile
  res "== P3 table (posture, reasons, echo, renderer seccomp, --no-sandbox switch)"
  for label in p3-a-unchanged p3-c-sysctl0 p3-b-bwrap-profile; do
    res "$(printf '%-20s' "$label") $(jq -c '{posture: .sandbox.posture.state, reasons: (.sandbox.reasons | map(.code)), echo: .sandbox.commands.echo.stdout, rendererSeccomp: .chromium.renderer.seccomp, noSandboxSwitch: .chromium.noSandboxSwitch}' "$OUT/$label.json" 2>&1 | head -n 2 | tr '\n' ' ')"
  done
}

phase_crash_app() { # packaging P1, the crash half: the installed app
  kill_tenon
  res "== packaging P1: crash dumps from the installed app"
  crash_run app "$INSTALLED_MAIN" "" xvfb-run -a "$INSTALLED"
}

case "$PHASE" in
libs) phase_libs ;;
dev) phase_dev ;;
crash-dev) phase_crash_dev ;;
build) phase_build ;;
install) phase_install ;;
p1) phase_p1 ;;
tools) phase_tools ;;
p3) phase_p3 ;;
crash-app) phase_crash_app ;;
*)
  echo "unknown phase: $PHASE"
  exit 2
  ;;
esac
status=$?
flush_notes
exit $status
