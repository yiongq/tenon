#!/usr/bin/env bash
# PROBE (probe/packaging, never merged): the macOS half of the packaging probe.
# usage: mac.sh <phase>   (phases are listed at the bottom; the workflow runs them in order)
set -o pipefail
PHASE="${1:-}"
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
    res "open --env failed ($(cat "$OUT/$label.open-error")); retrying through launchctl setenv"
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
  if wait_file "$OUT/$label.json" 150; then res "[$label] self-check written"; else res "[$label] NO self-check in 150 s"; fi
  show_probe "$OUT/$label.json" "$label (open -n -a)"
  echo "-- stderr tail:"
  tail -n 15 "$OUT/$label.stderr" | cut -c1-300
  kill_tenon
}

probe_direct() { # app label: self-check started straight from the binary (runner PATH inherited)
  local app=$1 label=$2 status
  kill_tenon
  rm -f "$OUT/$label.json"
  TENON_PROBE=1 TENON_PROBE_OUT="$OUT/$label.json" \
    python3 "$PROBE/run-timeout.py" 180 "$app/Contents/MacOS/Tenon" >"$OUT/$label.log" 2>&1
  status=$?
  res "[$label] direct launch exit=$status"
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
  res "[$label] main pid after 30 s: ${main:-none (the app is not running)}"
  ps -axo pid,etime,command | grep -F 'Tenon.app' | grep -v grep | cut -c1-170 | head -12
  if [ -n "$main" ]; then
    kill -TERM "$main"
    while kill -0 "$main" 2>/dev/null && [ "$waited" -lt 20 ]; do
      sleep 1
      waited=$((waited + 1))
    done
    if kill -0 "$main" 2>/dev/null; then res "[$label] SIGTERM: still running after 20 s"; else res "[$label] SIGTERM: exited after ${waited} s"; fi
  fi
  echo "-- stdout:"
  tail -n 40 "$OUT/$label.stdout" | cut -c1-300
  echo "-- stderr:"
  tail -n 40 "$OUT/$label.stderr" | cut -c1-300
  res "[$label] lines in stdout+stderr that look like errors:"
  cat "$OUT/$label.stdout" "$OUT/$label.stderr" |
    grep -iE 'error|fail|cannot|uncaught|exception|ERR_' | cut -c1-240 | head -15 | res
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
  echo "::endgroup::"
  res "electron-builder $name exit=$status"
  if [ "$status" -ne 0 ]; then
    res "-- why $name failed (last lines):"
    grep -vE 'duplicate dependency references|platform-specific optional' "$OUT/build-$name.log" |
      cut -c1-300 | tail -n 12 | res
  fi
  return $status
}

cd_info() { # label app: the identity codesign reports
  echo "== $1 ($2)"
  codesign -dvvv "$2" 2>&1 | grep -E '^(Identifier|CodeDirectory|CDHash|Signature|Info.plist|Sealed|TeamIdentifier)'
  codesign -d -r- "$2" 2>&1 | grep -E '^designated'
}

cdhash_of() { codesign -dvvv "$1" 2>&1 | sed -n 's/^CDHash=//p'; }
dr_of() { codesign -d -r- "$1" 2>&1 | sed -n 's/^designated => //p'; }

phase_dev() {
  cd "$DESK" || exit 1
  res "== P6 (packaging): the development app name, unpackaged Electron on apps/desktop"
  rm -f "$OUT/dev-probe.json"
  TENON_PROBE=1 TENON_PROBE_OUT="$OUT/dev-probe.json" \
    python3 "$PROBE/run-timeout.py" 180 pnpm exec electron . >"$OUT/dev-probe.log" 2>&1
  res "dev self-check exit=$?"
  tail -n 15 "$OUT/dev-probe.log" | cut -c1-300
  show_probe "$OUT/dev-probe.json" "development build"
  PROBE_PREFIX=()
  PROBE_FLAGS=()
  res "== error-logs P2: main-process errors in Electron 44 (unpackaged)"
  main_error_scenarios
}

phase_crash_dev() { # error-logs P1: a development build, data dir in a temp dir
  local data="$WORK/ud-dev"
  rm -rf "$data"
  cd "$DESK" || exit 1
  res "== error-logs P1: crash dumps from a development build (data dir $data)"
  crash_run dev 'Electron\.app/Contents/MacOS/Electron( |$)' "$data" \
    pnpm exec electron . "--user-data-dir=$data"
}

phase_build() {
  local failed=0
  build_variant a1 || failed=1
  build_variant a2 --dir || failed=1
  build_variant b --dir -c.extraMetadata.version=0.0.1 || failed=1
  build_variant n --dir -c.extraMetadata.productName=Tenon || failed=1
  build_variant h --dir -c.mac.hardenedRuntime=true || failed=1
  ls -la "$DESK"/dist-a1 | head -20
  du -sh "$DESK"/dist-a1/*.zip 2>&1 | res
  return $failed
}

phase_p2() {
  local res_dir="$A1/Contents/Resources" asar_dir
  res "== P2: helper files in the real package"
  ls -l "$res_dir/sandbox/seccomp/arm64/apply-seccomp" "$res_dir/sandbox/java-proxy-agent/" 2>&1 | res
  if test -x "$res_dir/sandbox/seccomp/arm64/apply-seccomp"; then res "apply-seccomp: executable"; else res "apply-seccomp: NOT executable"; fi
  file "$res_dir/sandbox/seccomp/arm64/apply-seccomp" 2>&1 | res
  if test -f "$res_dir/sandbox/java-proxy-agent/srt-proxy-agent.jar"; then res "jar: present"; else res "jar: MISSING"; fi
  asar_dir="$(ls -d "$ROOT"/node_modules/.pnpm/@electron+asar@*/node_modules/@electron/asar | head -1)"
  res "-- app.asar entries for sandbox-runtime/vendor:"
  node "$PROBE/asar-list.cjs" "$asar_dir" "$res_dir/app.asar" 'sandbox-runtime/(vendor|package\.json)' 2>&1 | head -n 14 | res
  res "-- outside the asar (.node files, sandbox-runtime vendor):"
  find "$res_dir/app.asar.unpacked" \( -name '*.node' -o -path '*sandbox-runtime/vendor*' \) 2>/dev/null |
    sed "s#$res_dir/##" | head -n 12 | res
  res "-- codesign --verify --deep --strict with the Linux ELF inside:"
  codesign --verify --deep --strict --verbose=2 "$A1" 2>&1 | grep -v '^--' | tail -n 5 | res
  res "verify exit=${PIPESTATUS[0]}"
  { cd_info real "$A1"; } 2>&1 | res
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
  res "== P4: does the signature notice the changed asar byte? (codesign --verify before re-signing)"
  codesign --verify --deep --strict --verbose=2 "$WORK/c1/Tenon.app" 2>&1 | tail -n 4 | res
  res "verify exit=${PIPESTATUS[0]}"
  codesign --force -s - "$WORK/c1/Tenon.app" 2>&1 | tail -n 2
  res "== P4 table: CDHash, then designated requirement"
  local label app
  for entry in "dev Electron|$DEV_ELECTRON" "a1 real build|$A1" "a2 same source again|$A2" \
    "b version only|$B" "n productName injected|$N" "h hardened runtime|$H" \
    "c0 a2 re-signed unchanged|$WORK/c0/Tenon.app" "c1 one asar byte re-signed|$WORK/c1/Tenon.app"; do
    label="${entry%%|*}"
    app="${entry#*|}"
    res "$(printf '%-28s' "$label") CDHash=$(cdhash_of "$app")"
    res "$(printf '%-28s' '') DR: $(dr_of "$app")"
    codesign -dvvv "$app" 2>&1 | grep -E '^(CodeDirectory|Info.plist|Sealed)' | tr '\n' ' ' | cut -c1-200
    echo
  done
}

phase_p1() {
  local install="$WORK/install-a"
  rm -rf "$install"
  mkdir -p "$install"
  res "== P1: unzip the release zip the way a user would"
  ls -l "$DESK"/dist-a1/*.zip 2>&1 | res
  ditto -x -k "$DESK"/dist-a1/*.zip "$install"
  ls "$install"
  codesign --verify --deep --strict "$install/Tenon.app"
  res "codesign verify of the unzipped app exit=$?"
  res "== P1 A: plain launch (open -n -a), 30 s, SIGTERM"
  smoke_plain "$install/Tenon.app" p1-plain
  res "== P1 B: self-check through open -n -a"
  probe_open "$install/Tenon.app" p1-probe-open
  res "== P1 C: self-check started from the binary"
  probe_direct "$install/Tenon.app" p1-probe-direct
}

phase_p5() {
  res "== P5: hardened runtime on, ad-hoc"
  codesign -dvvv "$H" 2>&1 | grep -E '^(CodeDirectory|Signature|TeamIdentifier)' | res
  res "-- entitlements:"
  codesign -d --entitlements - "$H" 2>&1 | head -n 20 | res
  probe_direct "$H" p5-hardened-direct
  probe_open "$H" p5-hardened-open
}

phase_p6() {
  local asar_dir app
  res "== P6: app names"
  res "development build:  $(jq -c '.app | {name, getName, userData}' "$OUT/dev-probe.json" 2>&1)"
  probe_direct "$N" p6-n-direct
  res "packaged, config only (a1):    CFBundleName=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleName' "$A1/Contents/Info.plist")  $(jq -c '.app | {name, getName, userData}' "$OUT/p1-probe-direct.json" 2>&1)"
  res "packaged, + extraMetadata (n): CFBundleName=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleName' "$N/Contents/Info.plist")  $(jq -c '.app | {name, getName, userData}' "$OUT/p6-n-direct.json" 2>&1)"
  asar_dir="$(ls -d "$ROOT"/node_modules/.pnpm/@electron+asar@*/node_modules/@electron/asar | head -1)"
  res "-- package.json inside each app.asar:"
  for app in "$A1" "$N"; do
    node "$PROBE/asar-list.cjs" "$asar_dir" "$app/Contents/Resources/app.asar" 'a^' | sed -n 2p | res
  done
  res "-- app data root: $(ls "$HOME/Library/Application Support" | tr '\n' ' ')"
}

phase_crash_app() { # packaging P1, the crash half: the installed app
  rm -rf "$WORK/install-a"
  mkdir -p "$WORK/install-a"
  ditto -x -k "$DESK"/dist-a1/*.zip "$WORK/install-a"
  kill_tenon
  res "== packaging P1: crash dumps from the installed app"
  crash_run app "$TENON_MAIN" "" open_app "$WORK/install-a/Tenon.app" crash-app-open
}

phase_dmg() {
  local dmg
  build_variant dmg -c.mac.target=dmg || return 0
  dmg="$(ls "$DESK"/dist-dmg/*.dmg | head -1)"
  res "== dmg: $dmg"
  ls -l "$dmg" | res
  rm -rf "$WORK/dmg-app"
  mkdir -p "$WORK/dmg-mount" "$WORK/dmg-app"
  hdiutil attach -nobrowse -readonly -mountpoint "$WORK/dmg-mount" "$dmg" 2>&1 | tail -n 3
  res "hdiutil attach exit=${PIPESTATUS[0]}"
  ls -la "$WORK/dmg-mount"
  ditto "$WORK/dmg-mount/Tenon.app" "$WORK/dmg-app/Tenon.app"
  codesign --verify --deep --strict "$WORK/dmg-app/Tenon.app"
  res "codesign verify of the app from the dmg exit=$?"
  hdiutil detach "$WORK/dmg-mount"
  probe_open "$WORK/dmg-app/Tenon.app" dmg-probe-open
}

case "$PHASE" in
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
  echo "unknown phase: $PHASE"
  exit 2
  ;;
esac
status=$?
flush_notes
exit $status
