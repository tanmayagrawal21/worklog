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
exit $fail
