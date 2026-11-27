# PROBE (probe/packaging, never merged): helpers shared by mac.sh and linux.sh (sourced).
# Probe steps never `set -e`: a failing check is evidence, so every step prints its exit codes and
# carries on. The lines that matter go through `res`: printed, kept in probe-out/results-<phase>.txt,
# then published as job-summary text and as notice annotations (readable without a login).

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DESK="$ROOT/apps/desktop"
PROBE="$ROOT/.github/probe"
OUT="$ROOT/probe-out"
WORK="${RUNNER_TEMP:-/tmp}/probe-work"
PHASE="${PHASE:-}"
mkdir -p "$OUT" "$WORK"

res() { # a result line, from the arguments or from stdin
  if [ $# -gt 0 ]; then printf '%s\n' "$*"; else cat; fi | tee -a "$OUT/results-$PHASE.txt"
}

flush_notes() {
  local file="$OUT/results-$PHASE.txt" title
  [ -s "$file" ] || return 0
  title="probe ${ImageOS:-${RUNNER_OS:-local}} $PHASE"
  if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
    {
      echo "### $title"
      echo '```'
      cat "$file"
      echo '```'
    } >>"$GITHUB_STEP_SUMMARY"
  fi
  python3 "$PROBE/annotate.py" "$title" "$file"
}

wait_file() { # path seconds: true once the file exists and is not empty
  local waited=0
  while [ ! -s "$1" ] && [ "$waited" -lt "$2" ]; do
    sleep 1
    waited=$((waited + 1))
  done
  [ -s "$1" ]
}

show_probe() { # probe json, label
  res "--- self-check ($2)"
  if [ -s "$1" ]; then
    { jq -r -f "$PROBE/summary.jq" "$1" || cat "$1"; } 2>&1 | res
    echo "::group::full self-check json ($2)"
    cat "$1"
    echo "::endgroup::"
  else
    res "(no self-check output: the app did not get as far as printing it)"
  fi
}

# What a crash left on disk. Lists the data dir (when given), anything crash-looking created since
# the marker, the system's crash report folders and the app data roots.
crash_snapshot() { # title marker data-dir-or-empty
  local found
  echo "::group::on disk: $1"
  res "== on disk: $1"
  if [ -n "$3" ] && [ -d "$3" ]; then
    echo "-- every file under the data dir $3:"
    find "$3" | head -200
    found="$(find "$3" \( -iname '*.dmp' -o -ipath '*crashpad*' \) | head -20)"
    res ".dmp files or Crashpad dirs under the data dir: ${found:-none}"
  fi
  found="$(find "$HOME" /var/crash /var/lib/systemd/coredump /Library/Logs/DiagnosticReports \
    -newer "$2" \( -iname '*.dmp' -o -ipath '*crashpad*' -o -iname '*.ips' -o -iname '*.crash' \
    -o -iname 'crash*' -o -iname 'core.*' \) \
    -not -path '*/node_modules/*' -not -path "$ROOT/*" 2>/dev/null | head -50)"
  res "crash-looking files created since launch (home, /var/crash, coredump, DiagnosticReports): ${found:-none}"
  if [ -d "$HOME/Library/Logs/DiagnosticReports" ]; then
    res "~/Library/Logs/DiagnosticReports: $(ls -1 "$HOME/Library/Logs/DiagnosticReports" | head -10 | tr '\n' ' ')"
  fi
  res "new entries under the app data roots since launch:"
  find "$HOME/Library/Application Support" "$HOME/.config" -maxdepth 5 -newer "$2" 2>/dev/null |
    head -60 | res
  echo "::endgroup::"
}

# Starts an app, sends SIGSEGV to its renderer, then to its main process, and looks at the disk
# after each. The app is never given crashReporter.start (nothing in it calls it).
crash_run() { # label main-regex data-dir-or-empty launch-command...
  local label=$1 regex=$2 data=$3
  shift 3
  local marker="$WORK/marker-$label"
  touch "$marker"
  sleep 1
  echo "launching: $*"
  "$@" >"$OUT/crash-$label.log" 2>&1 &
  sleep 30
  local main renderers
  main="$(python3 "$PROBE/proc.py" main "$regex")"
  res "[$label] main pid after 30 s: ${main:-none}"
  ps -axo pid,ppid,command | grep -E "$regex|--type=" | grep -v grep | cut -c1-200 | head -30
  if [ -z "$main" ]; then
    res "[$label] no main process: the app did not stay up. Its output:"
    tail -n 25 "$OUT/crash-$label.log" | cut -c1-300 | res
    return 1
  fi
  renderers="$(python3 "$PROBE/proc.py" renderers "$main")"
  res "[$label] renderer pids: ${renderers:-none}"
  for pid in $renderers; do kill -SEGV "$pid"; done
  sleep 10
  crash_snapshot "$label after SIGSEGV to the renderer" "$marker" "$data"
  res "[$label] main alive after the renderer's SIGSEGV: $(kill -0 "$main" 2>/dev/null && echo yes || echo no)"
  kill -SEGV "$main"
  sleep 15
  res "[$label] main alive after its own SIGSEGV: $(kill -0 "$main" 2>/dev/null && echo yes || echo no)"
  crash_snapshot "$label after SIGSEGV to the main process" "$marker" "$data"
  echo "-- app output:"
  tail -n 30 "$OUT/crash-$label.log" | cut -c1-300
  pkill -f "$regex" 2>/dev/null || true
  sleep 2
}

# error-logs P2: six scenarios of Electron's main process meeting an unhandled rejection or an
# uncaught exception. PROBE_PREFIX and PROBE_FLAGS (arrays) go before and after `electron`.
main_error_scenarios() {
  local scenario
  cd "$DESK" || return 1
  for scenario in "reject none" "throw none" "both none" "reject uncaught" "throw uncaught" \
    "reject rejection"; do
    # shellcheck disable=SC2086
    set -- $scenario
    echo "::group::error-logs P2: trigger=$1 listener=$2"
    python3 "$PROBE/run-timeout.py" 60 "${PROBE_PREFIX[@]}" pnpm exec electron "${PROBE_FLAGS[@]}" \
      "$PROBE/main-errors.cjs" "$1" "$2" >"$OUT/main-errors-$1-$2.log" 2>&1
    local status=$?
    cut -c1-400 "$OUT/main-errors-$1-$2.log" | tail -n 25
    echo "::endgroup::"
    if grep -q 'P2-RESULT' "$OUT/main-errors-$1-$2.log"; then
      grep 'P2-RESULT' "$OUT/main-errors-$1-$2.log" | cut -c1-600 | res
    else
      res "P2 trigger=$1 listener=$2: no result line, exit=$status (the process was gone or hung before 2 s). Last output: $(tail -n 3 "$OUT/main-errors-$1-$2.log" | tr '\n' ' ' | cut -c1-300)"
    fi
  done
}
