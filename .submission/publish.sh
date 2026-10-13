#!/usr/bin/env bash
# Publish dsh-message-forward to GitHub and open the awesome-dsh-plugin PR.
#
# Run this from the plugin repo root, in a terminal where you are logged in to
# GitHub (the `gh` CLI, or git credentials that can push to Domaki-co).
#
#   bash .submission/publish.sh            # step 1+2: create repo, push, topic
#   bash .submission/publish.sh --pr       # step 3: fork the catalog and open the PR
#
# It is idempotent: re-running skips steps already done.

set -euo pipefail

REPO="Domaki-co/dsh-message-forward"
ENTRY=".submission/Domaki-co__dsh-message-forward.yml"
CATALOG="awesome-dsh-plugin/awesome-dsh-plugin"

say() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }

# ---------------------------------------------------------------- preflight
say "Preflight"
command -v gh >/dev/null || { echo "gh CLI not found: https://cli.github.com"; exit 1; }
gh auth status >/dev/null 2>&1 || { echo "not logged in — run: gh auth login"; exit 1; }
[ -f package.json ] || { echo "run this from the plugin repo root"; exit 1; }
[ -f "$ENTRY" ] || { echo "missing catalog entry: $ENTRY"; exit 1; }
echo "ok: gh authenticated, manifest and entry present"

# ------------------------------------------------------- 1. create + push
say "1/3  GitHub repository"
if gh repo view "$REPO" >/dev/null 2>&1; then
  echo "exists already: $REPO"
else
  gh repo create "$REPO" --public \
    --description "WeChat-style message forwarding for DeepSeek Harness: forward a message, a multi-selected batch, or just the code blocks between sessions."
  echo "created: $REPO"
fi

git remote get-url origin >/dev/null 2>&1 \
  || git remote add origin "https://github.com/$REPO.git"
git push -u origin HEAD
echo "pushed $(git rev-parse --short HEAD)"

# ------------------------------------------------------------- 2. topic
say "2/3  dsh-plugin topic"
gh repo edit "$REPO" --add-topic dsh-plugin,dsh,deepseek-harness,plugin
gh repo view "$REPO" --json repositoryTopics \
  --jq '.repositoryTopics[].name' | sed 's/^/  topic: /'

# ---------------------------------------------------------------- 3. PR
if [ "${1:-}" != "--pr" ]; then
  cat <<EOF

Next: the catalog requires the repo to be at least 1 day old.
Wait until tomorrow, then run:

  bash .submission/publish.sh --pr
EOF
  exit 0
fi

say "3/3  awesome-dsh-plugin pull request"
ROOT="$PWD"          # the plugin repo, so the entry path survives the cd below
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# Fork so the PR comes from your own account; fall back to a plain clone.
if ! gh repo fork "$CATALOG" --clone --default-branch-only; then
  gh repo clone "$CATALOG" "$WORK/catalog"
fi
[ -d "$WORK/catalog" ] || mv awesome-dsh-plugin "$WORK/catalog"
cd "$WORK/catalog"

BRANCH="add-dsh-message-forward"
git checkout -b "$BRANCH"
mkdir -p data/plugins
cp "$ROOT/$ENTRY" "data/plugins/$(basename "$ENTRY")"

# The READMEs are generated — regenerate rather than hand-editing them.
node scripts/generate-readme.mjs

git add "data/plugins/$(basename "$ENTRY")" README.md README.zh.md
git commit -m "Add Domaki-co/dsh-message-forward

WeChat-style cross-session forwarding for DSH: forward one model reply, a
user message, or a multi-selected batch of messages and images into another
session, with three delivery modes (silent send / fill draft / send-and-jump),
code-block-only extraction, and prompt templates."

git push -u origin "$BRANCH"

gh pr create --repo "$CATALOG" \
  --title "Add Domaki-co/dsh-message-forward" \
  --body "$(cat <<'BODY'
Adds one entry: `data/plugins/Domaki-co__dsh-message-forward.yml`.

**What it does** — WeChat-style cross-session forwarding for DSH. From any
model reply or user message you can forward the single message, a
multi-selected batch (long-press 2s to enter multi-select, then tick messages
in the floating bar or the quick-pick panel), or just the Markdown code blocks,
into another session. Three delivery modes: silent send, fill draft, and
send-and-jump. Images ride along as multimodal attachments. Batch merges
preserve the original timeline order.

**Manifest** — `dsh.bundle.patch` → `cordis.patch.yml`; `dsh.client.inject`
declares the five host UI packages it consumes
(`dsh-client-ui-slots`, `-conversation`, `-primitives`, `-workspace`,
`dsh-api-session-controller`). `engines.dsh` and every peer range carry an
explicit prerelease branch, so `0.2.0-rc.*` and `0.2.1-alpha.*` both resolve
without `ERESOLVE`.

**Verification** — 119 assertions across four suites (`node tests/run.mjs`),
run against the real DSH DOM contract extracted from `app.asar` in jsdom.
BODY
)"

echo
echo "PR opened. CI runs on it; a maintainer reads the repo before merging."
