#!/usr/bin/env bash
# setup.sh — create and seed a work log data repo from the terminal.
#
# The in-app wizard does the same thing; this is for people who would rather not paste
# a token into a browser before seeing what the app writes, and for seeding several
# repos for a team. The starter files come from js/bootstrap.js via scaffold.mjs, so
# this path and the app cannot drift apart.
#
# It never touches your tokens: you still paste one into the app to use it afterwards.
#
#   ./scripts/setup.sh                     # private repo, <you>/worklog-data
#   ./scripts/setup.sh --repo me/journal   # a name you pick
#   ./scripts/setup.sh --public            # public instead of private
#   ./scripts/setup.sh --no-examples       # skip the three example tasks
#   ./scripts/setup.sh --dry-run           # print the plan and the files, write nothing
#   ./scripts/setup.sh --yes               # skip the confirmation prompt
set -euo pipefail
cd "$(dirname "$0")/.."

SLUG=""
VISIBILITY="private"
EXAMPLES=1
DRY_RUN=0
ASSUME_YES=0
APP_URL=""   # resolved below from the git remote, so a fork advertises its own Pages URL

die() { echo "setup.sh: $*" >&2; exit 1; }

while [ $# -gt 0 ]; do
  case "$1" in
    --repo)        SLUG="${2:-}"; shift 2 ;;
    --repo=*)      SLUG="${1#*=}"; shift ;;
    --public)      VISIBILITY="public"; shift ;;
    --private)     VISIBILITY="private"; shift ;;
    --no-examples) EXAMPLES=0; shift ;;
    --dry-run)     DRY_RUN=1; shift ;;
    --yes|-y)      ASSUME_YES=1; shift ;;
    --app-url)     APP_URL="${2:-}"; shift 2 ;;
    --app-url=*)   APP_URL="${1#*=}"; shift ;;
    -h|--help)     sed -n '2,16p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *)             die "unknown option $1 (try --help)" ;;
  esac
done

# ---- runtimes -------------------------------------------------------------------
JSC="${JSC:-/System/Library/Frameworks/JavaScriptCore.framework/Versions/A/Helpers/jsc}"
if [ ! -x "$JSC" ]; then
  if command -v node >/dev/null 2>&1; then JSC="$(command -v node)"
  else die "no JS runtime found. Set JSC=/path/to/jsc-or-node."; fi
fi
command -v git >/dev/null 2>&1 || die "git is required."
command -v base64 >/dev/null 2>&1 || die "base64 is required."
command -v gh >/dev/null 2>&1 || die "the GitHub CLI is required: https://cli.github.com"
gh auth status >/dev/null 2>&1 || die "gh is not logged in. Run: gh auth login"

if [ -z "$SLUG" ]; then
  owner="$(gh api user --jq .login)" || die "could not read your GitHub login."
  SLUG="$owner/worklog-data"
fi

# Derive the app URL from whichever copy of the app this script came from, so a fork
# writes its own Pages URL into the data repo's README instead of upstream's.
if [ -z "$APP_URL" ]; then
  remote="$(git config --get remote.origin.url 2>/dev/null || true)"
  app_slug="$(printf '%s' "$remote" | sed -E 's#^(https://github\.com/|git@github\.com:)##; s#\.git$##')"
  case "$app_slug" in
    */*) APP_URL="https://${app_slug%%/*}.github.io/${app_slug##*/}/" ;;
    *)   APP_URL="https://github.com" ;;
  esac
fi
case "$SLUG" in */*) ;; *) die "--repo wants owner/name, got '$SLUG'" ;; esac

repo_exists=0
gh repo view "$SLUG" --json name >/dev/null 2>&1 && repo_exists=1

# ---- the plan -------------------------------------------------------------------
# Rendered by the same code the app uses, so what you approve here is what the app
# would have written.
manifest=$("$JSC" -m scripts/scaffold.mjs -- "$SLUG" "$APP_URL" "$EXAMPLES") \
  || die "could not render the starter files."
[ -n "$manifest" ] || die "the scaffolder produced nothing."

echo "Repo:       $SLUG $([ "$repo_exists" = 1 ] && echo '(exists)' || echo "(will be created, $VISIBILITY)")"
echo "App:        $APP_URL"
echo "Examples:   $([ "$EXAMPLES" = 1 ] && echo 'three example tasks' || echo 'none')"
echo "Will commit:"
while IFS=$'\t' read -r path b64; do
  [ -n "$path" ] || continue
  printf '  %s (%s bytes)\n' "$path" "$(printf '%s' "$b64" | base64 -d | wc -c | tr -d ' ')"
done <<< "$manifest"

if [ "$DRY_RUN" = 1 ]; then
  echo
  echo "--dry-run: nothing was created. Contents follow."
  while IFS=$'\t' read -r path b64; do
    [ -n "$path" ] || continue
    printf '\n===== %s =====\n' "$path"
    printf '%s' "$b64" | base64 -d
  done <<< "$manifest"
  exit 0
fi

if [ "$ASSUME_YES" != 1 ]; then
  printf '\nCreate and commit the above? [y/N] '
  read -r reply
  case "$reply" in y|Y|yes|YES) ;; *) echo "Nothing was created."; exit 1 ;; esac
fi

# ---- do it ----------------------------------------------------------------------
if [ "$repo_exists" = 0 ]; then
  gh repo create "$SLUG" "--$VISIBILITY" \
    --description "Personal work log data. The app lives at $APP_URL" >/dev/null
  echo "Created $SLUG ($VISIBILITY)."
fi

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
gh repo clone "$SLUG" "$work" -- --quiet 2>/dev/null || die "could not clone $SLUG."

# Refuse to write over an existing log rather than guess at merging one. The app knows
# how to open an existing repo, and how to upgrade an old layout; this script does not.
if [ -e "$work/data/manifest.json" ]; then
  die "$SLUG already holds a work log (data/manifest.json exists).
       Open the app and point it at $SLUG instead — it reads what is already there."
fi

while IFS=$'\t' read -r path b64; do
  [ -n "$path" ] || continue
  mkdir -p "$work/$(dirname "$path")"
  printf '%s' "$b64" | base64 -d > "$work/$path"
done <<< "$manifest"

git -C "$work" add -A
git -C "$work" -c user.name="${GIT_AUTHOR_NAME:-$(git config user.name || echo worklog)}" \
  -c user.email="${GIT_AUTHOR_EMAIL:-$(git config user.email || echo worklog@localhost)}" \
  commit -q -m "worklog: initialise data repo" \
  -m "Scaffolding created by the work log app." || die "nothing to commit."

branch="$(git -C "$work" symbolic-ref --short HEAD)"
git -C "$work" push -q -u origin "$branch"

echo
echo "Done. $SLUG is seeded on branch $branch."
echo "Next: open $APP_URL, and point it at $SLUG with a token that has Contents: Read and write."
echo "Read it on GitHub with no tooling: https://github.com/$SLUG/blob/$branch/data/BOARD.md"
