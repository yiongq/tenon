#!/usr/bin/env bash
# PROBE (probe/packaging, never merged): the macOS half of the packaging probe.
# usage: mac.sh <phase>   (phases are listed at the bottom; the workflow runs them in order)
set -o pipefail
# shellcheck source=common.sh
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"

A1="$DESK/dist-a1/mac-arm64/Tenon.app" # the real build, also zipped
A2="$DESK/dist-a2/mac-arm64/Tenon.app" # the same source built again
B="$DESK/dist-b/mac-arm64/Tenon.app"   # only the version changed
N="$DESK/dist-n/mac-arm64/Tenon.app"   # productName also injected through extraMetadata
H="$DESK/dist-h/mac-arm64/Tenon.app"   # hardened runtime on
DEV_ELECTRON="$DESK/node_modules/electron/dist/Electron.app"
TENON_MAIN='Tenon\.app/Contents/MacOS/Tenon( |$)'

kill_tenon() {
  pkill -f 'Tenon.app/Contents/' 2>/dev/null || true
  sleep 3
}

# Launch the way a user does: LaunchServices, the app's output going to files.
open_app() { # app label [VAR=value...]
  local app=$1 label=$2 args=() kv
  shift 2
  for kv in "$@"; do args+=(--env "$kv"); done
  : >"$OUT/$label.stdout"
  : >"$OUT/$label.stderr"
  if ! open -n -a "$app" ${args[@]+"${args[@]}"} --stdout "$OUT/$label.stdout" \
    --stderr "$OUT/$label.stderr" 2>"$OUT/$label.open-error"; then
    echo "open --env failed ($(cat "$OUT/$label.open-error")); retrying through launchctl setenv"
    for kv in "$@"; do launchctl setenv "${kv%%=*}" "${kv#*=}"; done
    open -n -a "$app" --stdout "$OUT/$label.stdout" --stderr "$OUT/$label.stderr"
    sleep 5
    for kv in "$@"; do launchctl unsetenv "${kv%%=*}"; done
  fi
}

probe_open() { # app label: self-check through `open`
  local app=$1 label=$2
  kill_tenon
  rm -f "$OUT/$label.json"
  open_app "$app" "$label" TENON_PROBE=1 "TENON_PROBE_OUT=$OUT/$label.json"
  if wait_file "$OUT/$label.json" 150; then echo "self-check written"; else echo "NO self-check in 150 s"; fi
  show_probe "$OUT/$label.json" "$label (open -n -a)"
  echo "-- stderr tail:"
  tail -n 15 "$OUT/$label.stderr" | cut -c1-300
  kill_tenon
}

probe_direct() { # app label: self-check started straight from the binary (runner PATH inherited)
  local app=$1 label=$2
  kill_tenon
  rm -f "$OUT/$label.json"
  TENON_PROBE=1 TENON_PROBE_OUT="$OUT/$label.json" \
    python3 "$PROBE/run-timeout.py" 180 "$app/Contents/MacOS/Tenon" >"$OUT/$label.log" 2>&1
  echo "direct launch exit=$?"
  tail -n 15 "$OUT/$label.log" | cut -c1-300
  show_probe "$OUT/$label.json" "$label (binary)"
  kill_tenon
}

smoke_plain() { # app label: launch with no self-check, watch 30 s, SIGTERM
  local app=$1 label=$2 main waited=0
  kill_tenon
  open_app "$app" "$label"
  sleep 30
  main="$(python3 "$PROBE/proc.py" main "$TENON_MAIN")"
  echo "main pid after 30 s: ${main:-none (the app is not running)}"
  ps -axo pid,etime,command | grep -F 'Tenon.app' | grep -v grep | cut -c1-170 | head -12
  if [ -n "$main" ]; then
    kill -TERM "$main"
    while kill -0 "$main" 2>/dev/null && [ "$waited" -lt 20 ]; do
      sleep 1
      waited=$((waited + 1))
    done
    if kill -0 "$main" 2>/dev/null; then echo "SIGTERM: still running after 20 s"; else echo "SIGTERM: exited after ${waited} s"; fi
  fi
  echo "-- stdout:"
  tail -n 40 "$OUT/$label.stdout" | cut -c1-300
  echo "-- stderr:"
  tail -n 40 "$OUT/$label.stderr" | cut -c1-300
  echo "-- lines that look like errors:"
  cat "$OUT/$label.stdout" "$OUT/$label.stderr" |
    grep -iE 'error|fail|cannot|uncaught|exception|ERR_' | cut -c1-300 | head -30
  kill_tenon
}

build_variant() { # name electron-builder-args...
  local name=$1 status
  shift
  echo "::group::electron-builder $name: $*"
  (cd "$DESK" && pnpm exec electron-builder --mac --arm64 --publish never \
    "-c.directories.output=dist-$name" "$@") >"$OUT/build-$name.log" 2>&1
  status=$?
  grep -vE 'duplicate dependency references|platform-specific optional' "$OUT/build-$name.log" |
    cut -c1-300 | tail -n 40
  echo "electron-builder $name exit=$status"
  echo "::endgroup::"
  return $status
}

cd_info() { # label app: the identity codesign reports
  echo "== $1 ($2)"
  codesign -dvvv "$2" 2>&1 | grep -E '^(Identifier|CodeDirectory|CDHash|Signature|Info.plist|Sealed|TeamIdentifier)'
  codesign -d -r- "$2" 2>&1 | grep -E '^designated'
}

cdhash_of() { codesign -dvvv "$1" 2>&1 | sed -n 's/^CDHash=//p'; }

phase_dev() {
  cd "$DESK" || exit 1
  echo "== P6 (packaging): the development app name, unpackaged Electron on apps/desktop"
  rm -f "$OUT/dev-probe.json"
  TENON_PROBE=1 TENON_PROBE_OUT="$OUT/dev-probe.json" \
    python3 "$PROBE/run-timeout.py" 180 pnpm exec electron . >"$OUT/dev-probe.log" 2>&1
  echo "exit=$?"
  tail -n 15 "$OUT/dev-probe.log" | cut -c1-300
  show_probe "$OUT/dev-probe.json" "development build"
  PROBE_PREFIX=()
  PROBE_FLAGS=()
  main_error_scenarios
}

phase_crash_dev() { # error-logs P1: a development build, data dir in a temp dir
  local data="$WORK/ud-dev"
  rm -rf "$data"
  cd "$DESK" || exit 1
  crash_run dev 'Electron\.app/Contents/MacOS/Electron( |$)' "$data" \
    pnpm exec electron . "--user-data-dir=$data"
}

phase_build() {
  build_variant a1
  build_variant a2 --dir
  build_variant b --dir -c.extraMetadata.version=0.0.1
  build_variant n --dir -c.extraMetadata.productName=Tenon
  build_variant h --dir -c.mac.hardenedRuntime=true
  ls -la "$DESK"/dist-a1 | head -20
  du -sh "$DESK"/dist-a1/*.zip
}

phase_p2() {
  local res="$A1/Contents/Resources" asar_dir
  echo "== P2: helper files in the real package ($A1)"
  ls -l "$res/sandbox/seccomp/arm64/apply-seccomp" "$res/sandbox/java-proxy-agent/"
  if test -x "$res/sandbox/seccomp/arm64/apply-seccomp"; then echo "apply-seccomp: executable"; else echo "apply-seccomp: NOT executable"; fi
  file "$res/sandbox/seccomp/arm64/apply-seccomp"
  if test -f "$res/sandbox/java-proxy-agent/srt-proxy-agent.jar"; then echo "jar: present"; else echo "jar: MISSING"; fi
  asar_dir="$(ls -d "$ROOT"/node_modules/.pnpm/@electron+asar@*/node_modules/@electron/asar | head -1)"
  echo "== P2: app.asar entries for sandbox-runtime/vendor"
  node "$PROBE/asar-list.cjs" "$asar_dir" "$res/app.asar" 'sandbox-runtime/(vendor|package\.json)'
  echo "== P2: what sits outside the asar"
  find "$res/app.asar.unpacked" -name '*.node' -o -path '*sandbox-runtime/vendor*' | head -30
  echo "== P2: codesign --verify --deep --strict with the Linux ELF inside"
  codesign --verify --deep --strict --verbose=2 "$A1" 2>&1 | grep -v '^--' | tail -n 8
  echo "exit=${PIPESTATUS[0]}"
  cd_info real "$A1"
}

phase_p4() {
  local flip="$WORK/c1/Tenon.app/Contents/Resources/app.asar"
  rm -rf "$WORK/c0" "$WORK/c1"
  mkdir -p "$WORK/c0" "$WORK/c1"
  ditto "$A2" "$WORK/c0/Tenon.app"
  ditto "$A2" "$WORK/c1/Tenon.app"
  # c0: same bytes, only re-signed (the control); c1: one byte of app.asar changed, then re-signed.
  codesign --force -s - "$WORK/c0/Tenon.app" 2>&1 | tail -n 2
  python3 - "$flip" <<'PY'
import sys

path = sys.argv[1]
with open(path, "r+b") as handle:
    handle.seek(-1, 2)
    last = handle.read(1)
    handle.seek(-1, 2)
    handle.write(bytes([last[0] ^ 1]))
print("flipped the last byte of", path)
PY
  echo "== does the signature notice the changed asar byte? (codesign --verify before re-signing)"
  codesign --verify --deep --strict --verbose=2 "$WORK/c1/Tenon.app" 2>&1 | tail -n 4
  echo "exit=${PIPESTATUS[0]}"
  codesign --force -s - "$WORK/c1/Tenon.app" 2>&1 | tail -n 2
  cd_info "dev Electron" "$DEV_ELECTRON"
  cd_info "a1 real build" "$A1"
  cd_info "a2 same source again" "$A2"
  cd_info "b version only" "$B"
  cd_info "n extraMetadata.productName" "$N"
  cd_info "h hardened runtime" "$H"
  cd_info "c0 a2 re-signed, unchanged" "$WORK/c0/Tenon.app"
  cd_info "c1 a2 with one asar byte changed, re-signed" "$WORK/c1/Tenon.app"
  echo "== P4 table (CDHash)"
  printf '%-34s %s\n' "dev Electron" "$(cdhash_of "$DEV_ELECTRON")"
  printf '%-34s %s\n' "a1 real build" "$(cdhash_of "$A1")"
  printf '%-34s %s\n' "a2 same source again" "$(cdhash_of "$A2")"
  printf '%-34s %s\n' "b version only" "$(cdhash_of "$B")"
  printf '%-34s %s\n' "n productName injected" "$(cdhash_of "$N")"
  printf '%-34s %s\n' "h hardened runtime" "$(cdhash_of "$H")"
  printf '%-34s %s\n' "c0 a2 re-signed, unchanged" "$(cdhash_of "$WORK/c0/Tenon.app")"
  printf '%-34s %s\n' "c1 one asar byte, re-signed" "$(cdhash_of "$WORK/c1/Tenon.app")"
}

phase_p1() {
  local install="$WORK/install-a"
  rm -rf "$install"
  mkdir -p "$install"
  echo "== P1: unzip the release zip the way a user would"
  ls -l "$DESK"/dist-a1/*.zip
  ditto -x -k "$DESK"/dist-a1/*.zip "$install"
  ls "$install"
  codesign --verify --deep --strict "$install/Tenon.app"
  echo "codesign verify of the unzipped app exit=$?"
  echo "== P1: A. plain launch (open -n -a), 30 s, SIGTERM"
  smoke_plain "$install/Tenon.app" p1-plain
  echo "== P1: B. self-check through open -n -a"
  probe_open "$install/Tenon.app" p1-probe-open
  echo "== P1: C. self-check started from the binary"
  probe_direct "$install/Tenon.app" p1-probe-direct
}

phase_p5() {
  echo "== P5: hardened runtime on, ad-hoc"
  codesign -dvvv "$H" 2>&1 | grep -E '^(CodeDirectory|Signature|TeamIdentifier)'
  echo "-- entitlements:"
  codesign -d --entitlements - "$H" 2>&1 | head -n 30
  probe_direct "$H" p5-hardened-direct
  probe_open "$H" p5-hardened-open
}

phase_p6() {
  echo "== P6: app names"
  printf 'development build:  %s\n' "$(jq -c '.app | {name, getName, userData}' "$OUT/dev-probe.json" 2>&1)"
  probe_direct "$N" p6-n-direct
  printf 'packaged, config only (a1):    CFBundleName=%s  %s\n' \
    "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleName' "$A1/Contents/Info.plist")" \
    "$(jq -c '.app | {name, getName, userData}' "$OUT/p1-probe-direct.json" 2>&1)"
  printf 'packaged, + extraMetadata (n): CFBundleName=%s  %s\n' \
    "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleName' "$N/Contents/Info.plist")" \
    "$(jq -c '.app | {name, getName, userData}' "$OUT/p6-n-direct.json" 2>&1)"
  echo "-- productName in the package.json inside each app.asar:"
  local asar_dir
  asar_dir="$(ls -d "$ROOT"/node_modules/.pnpm/@electron+asar@*/node_modules/@electron/asar | head -1)"
  for app in "$A1" "$N"; do
    node "$PROBE/asar-list.cjs" "$asar_dir" "$app/Contents/Resources/app.asar" 'a^' | sed -n 2p
  done
  echo "-- app data root:"
  ls -la "$HOME/Library/Application Support" | head -30
}

phase_crash_app() { # packaging P1, the crash half: the installed app
  rm -rf "$WORK/install-a"
  mkdir -p "$WORK/install-a"
  ditto -x -k "$DESK"/dist-a1/*.zip "$WORK/install-a"
  kill_tenon
  crash_run app "$TENON_MAIN" "" open_app "$WORK/install-a/Tenon.app" crash-app-open
}

phase_dmg() {
  local dmg
  build_variant dmg -c.mac.target=dmg || return 0
  dmg="$(ls "$DESK"/dist-dmg/*.dmg | head -1)"
  echo "== dmg: $dmg"
  ls -l "$dmg"
  rm -rf "$WORK/dmg-app"
  mkdir -p "$WORK/dmg-mount" "$WORK/dmg-app"
  hdiutil attach -nobrowse -readonly -mountpoint "$WORK/dmg-mount" "$dmg"
  echo "attach exit=$?"
  ls -la "$WORK/dmg-mount"
  ditto "$WORK/dmg-mount/Tenon.app" "$WORK/dmg-app/Tenon.app"
  codesign --verify --deep --strict "$WORK/dmg-app/Tenon.app"
  echo "codesign verify of the app from the dmg exit=$?"
  hdiutil detach "$WORK/dmg-mount"
  probe_open "$WORK/dmg-app/Tenon.app" dmg-probe-open
}

case "${1:-}" in
dev) phase_dev ;;
crash-dev) phase_crash_dev ;;
build) phase_build ;;
p2) phase_p2 ;;
p4) phase_p4 ;;
p1) phase_p1 ;;
p5) phase_p5 ;;
p6) phase_p6 ;;
crash-app) phase_crash_app ;;
dmg) phase_dmg ;;
*)
  echo "unknown phase: ${1:-}"
  exit 2
  ;;
esac
