#!/bin/sh
# Claude Code Stop hook: an extra gate on top of lefthook + CI.
# Blocks the stop (exit 2) when lint or typecheck fail, unless we are already
# continuing because of this hook (stop_hook_active), which would loop forever.
set -u
input=$(cat)
case "$input" in
  *'"stop_hook_active":true'*) exit 0 ;;
esac
cd "$(dirname "$0")/../.." || exit 0
[ -f package.json ] || exit 0
if pnpm lint && pnpm typecheck; then
  exit 0
fi
echo 'stop-gate: pnpm lint / pnpm typecheck failed; fix before stopping' >&2
exit 2
