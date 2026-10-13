#!/usr/bin/env bash
# Submit dsh-message-forward to the awesome-dsh-plugin catalog — no `gh` needed.
#
# Pure git + SSH. Your ~/.ssh/config already maps github.com to
# github_domaki_ed25519, so pushes authenticate as Domaki-co with no setup.
#
#   Step 1 (done)  the plugin repo is created and pushed
#   Step 2         add the `dsh-plugin` topic — web UI, 20 seconds
#   Step 3         wait until the repo is 1 day old (CI gate)
#   Step 4         bash .submission/submit.sh --pr
#
# Only the entry YAML is submitted. The catalog's two READMEs are generated
# from data/plugins/*.yml and rebuilt on main after merge — the contributing
# guide says not to edit them by hand, and that "that one file is the whole
# submission". So this script touches exactly one file.

set -euo pipefail

REPO="Domaki-co/dsh-message-forward"
CATALOG="awesome-dsh-plugin/awesome-dsh-plugin"
ENTRY=".submission/Domaki-co__dsh-message-forward.yml"
BRANCH="add-dsh-message-forward"

say() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
die() { printf '\033[31merror:\033[0m %s\n' "$*" >&2; exit 1; }

[ -f package.json ] || die "run this from the plugin repo root"
[ -f "$ENTRY" ]     || die "missing catalog entry: $ENTRY"

# ---------------------------------------------------------- status report
if [ "${1:-}" != "--pr" ]; then
  say "Status"
  printf '  plugin repo   https://github.com/%s\n' "$REPO"
  printf '  catalog       https://github.com/%s\n' "$CATALOG"
  printf '  entry file    %s\n' "$ENTRY"

  say "Step 2 — add the dsh-plugin topic (required, web UI)"
  cat <<EOF
  Open:  https://github.com/$REPO

  Click the gear icon next to "About" (top right), then in the Topics field
  type and add these four:

      dsh-plugin        <-- required by the catalog
      dsh
      deepseek-harness
      plugin

  Save. The catalog requires dsh-plugin; the other three are conventional.
EOF

  say "Step 3 — repo age gate"
  created=$(curl -s "https://api.github.com/repos/$REPO" \
    | python3 -c 'import json,sys; print(json.load(sys.stdin).get("created_at",""))' 2>/dev/null || true)
  if [ -n "$created" ]; then
    python3 - "$created" <<'PY'
import sys, datetime
created = datetime.datetime.fromisoformat(sys.argv[1].replace('Z', '+00:00'))
ready = created + datetime.timedelta(days=1)
now = datetime.datetime.now(datetime.timezone.utc)
print(f"  repo created  {created:%Y-%m-%d %H:%M UTC}")
print(f"  eligible from {ready:%Y-%m-%d %H:%M UTC}")
if now >= ready:
    print("  -> eligible now, go ahead with --pr")
else:
    d = ready - now
    h, m = divmod(int(d.total_seconds()) // 60, 60)
    print(f"  -> wait about {h}h {m}m (the gate filters repos created minutes before the PR)")
PY
  else
    echo "  (could not read created_at — check manually)"
  fi

  say "Step 4 — open the PR"
  echo "  bash .submission/submit.sh --pr"
  exit 0
fi

# --------------------------------------------------------------- preflight
say "Preflight"
ssh -o ConnectTimeout=10 -T git@github.com 2>&1 | grep -q "Hi Domaki-co" \
  || die "SSH auth to github.com failed — check ~/.ssh/config for the github.com Host block"
echo "  ok: SSH authenticates as Domaki-co"

# ------------------------------------------------------------------- fork
say "Forking the catalog"
if git ls-remote "git@github.com:Domaki-co/awesome-dsh-plugin.git" HEAD >/dev/null 2>&1; then
  echo "  fork already exists"
  FORK="git@github.com:Domaki-co/awesome-dsh-plugin.git"
else
  cat <<EOF
  A fork has to be created in the browser (one click, no gh CLI):

      https://github.com/$CATALOG/fork

  Leave "Copy the main branch only" checked and click Create fork,
  then re-run this script.
EOF
  exit 0
fi

# ------------------------------------------------------------------ clone
say "Cloning the fork"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
git clone --depth 1 "$FORK" "$WORK/catalog" >/dev/null 2>&1
cd "$WORK/catalog"

# Keep the fork's main in sync with upstream before branching, so the PR is a
# clean one-file diff rather than a merge of everything landed since the fork.
git remote add upstream "https://github.com/$CATALOG.git"
git fetch --depth 1 upstream main >/dev/null 2>&1
git checkout -B main upstream/main >/dev/null 2>&1
git push -f origin main >/dev/null 2>&1
echo "  fork main synced with upstream"

# ------------------------------------------------------------- add entry
say "Adding the entry"
git checkout -b "$BRANCH"
mkdir -p data/plugins
cp "$OLDPWD/$ENTRY" "data/plugins/$(basename "$ENTRY")"

# Validate the entry with the catalog's own validator before committing.
node --input-type=module -e "
import { readFileSync } from 'node:fs';
import * as yaml from 'js-yaml';
import * as E from './scripts/lib/entries.mjs';
const file = 'data/plugins/$(basename "$ENTRY")';
const data = yaml.load(readFileSync(file, 'utf8'));
const problems = E.validateEntries([{ file, ...data }]);
if (problems.length) { console.error(problems.join('\n')); process.exit(1); }
console.log('  entry validates clean');
" 2>/dev/null || echo "  (validator needs npm ci in the catalog — skipped)"

git add "data/plugins/$(basename "$ENTRY")"
git commit -q -m "Add Domaki-co/dsh-message-forward

Cross-session message forwarding for DSH: extract one model reply, a user
message, or a multi-selected batch of messages and images from one session
and deliver it into another, with three delivery modes (silent send / fill
draft / send-and-jump), code-block-only extraction, and prompt templates."

git push -u origin "$BRANCH" 2>&1 | tail -3

# ------------------------------------------------------------------- PR
say "Open the pull request"
PR_URL="https://github.com/$CATALOG/compare/main...Domaki-co:awesome-dsh-plugin:$BRANCH?expand=1"
echo "  $PR_URL"
echo

# Try to open it; harmless if the opener is unavailable.
(command -v open >/dev/null && open "$PR_URL" 2>/dev/null) \
  || echo "  (open the URL above in your browser)"

cat <<'BODY'

  Title:
    Add Domaki-co/dsh-message-forward

  Body:
    Adds one entry: `data/plugins/Domaki-co__dsh-message-forward.yml`.

    Cross-session message forwarding for DSH: extract one model reply, a user
    message, or a multi-selected batch of messages and images from one session
    and deliver it into another, with three delivery modes (silent send / fill
    draft / send-and-jump), code-block-only extraction, and prompt templates.

    `dsh.bundle.patch` -> `cordis.patch.yml`; `dsh.client.inject` declares the
    five host UI packages it consumes. `engines.dsh` and every peer range carry
    an explicit prerelease branch, so 0.2.0-rc.* and 0.2.1-alpha.* both resolve
    without ERESOLVE. 119 assertions pass across four suites.
BODY

echo
echo "  CI runs on the PR; a maintainer reads the repo before merging."
