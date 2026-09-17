#!/usr/bin/env bash
# Run the headless test suites.
#
# This project has no build step and no node_modules, so the tests run under
# JavaScriptCore, which ships with macOS. `jsc` is not on PATH by default, hence
# the explicit path below. Any ES-module-capable runtime works:
#   node --experimental-vm-modules test/store.test.js
set -euo pipefail
cd "$(dirname "$0")/.."

JSC="${JSC:-/System/Library/Frameworks/JavaScriptCore.framework/Versions/A/Helpers/jsc}"
if [ ! -x "$JSC" ]; then
  echo "jsc not found at $JSC" >&2
  echo "Set JSC=/path/to/a/js/runtime, or install one." >&2
  exit 1
fi

fail=0
for t in test/*.test.js; do
  "$JSC" -m "$t" || fail=1
done

# Calendar dates are local (see js/store.js localDate), so a suite that passes here has
# only been checked in this machine's zone. Re-run everything at the extremes and in UTC
# -- UTC being where a UTC-derived date looks correct, which is how the bug survived.
for tz in Pacific/Kiritimati Pacific/Niue UTC; do
  for t in test/*.test.js; do
    if ! out="$(TZ="$tz" "$JSC" -m "$t" 2>&1)"; then
      printf '%s\n' "--- FAILED under TZ=$tz: $t" "$out"
      fail=1
    fi
  done
done
[ "$fail" = 0 ] && echo "zones:    every suite also passes under Pacific/Kiritimati (UTC+14), Pacific/Niue (UTC-11) and UTC"

# bin/worklog.mjs is the one file that imports node:*, which jsc cannot resolve. Copy it
# next to the stubs with those specifiers rewritten, and expose its internals to the
# checks; the shipped file stays free of test hooks. See test/node-stubs/README.md.
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
cp test/node-stubs/stub-*.mjs "$tmp/"
sed -E "s#from 'node:([a-z_]+)'#from './stub-\1.mjs'#" bin/worklog.mjs > "$tmp/cli.mjs"
printf '\nglobalThis.__probe = { parseArgs, resolveFile, server, TYPES };\n' >> "$tmp/cli.mjs"
"$JSC" -m test/cli.check.js -- "$tmp/cli.mjs" || fail=1

exit $fail
