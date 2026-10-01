#!/usr/bin/env bash
# commit_data.sh — commits the data this run produced (data/ and, if THIS run changed it, tickers.txt) and pushes
# it to main. Never uses --force. Called by the workflow's "Commit changes" step.
#
# Push strategy:
#   1. up to 3 attempts of:  git pull --rebase -X theirs  (on a conflict the data of THIS run wins) + git push
#   2. if all fail: abort any rebase, snapshot -> fetch + reset to origin/main -> copy this run's files back on top ->
#      commit -> push (up to 3 attempts). The snapshot was taken before any rebase, so nothing this run produced is lost.
# Env: BRANCH (default main), RETRY_SLEEP (seconds multiplier between attempts, default 5).
set -u
BRANCH="${BRANCH:-main}"
SLEEP="${RETRY_SLEEP:-5}"

git add data tickers.txt 2>/dev/null || git add data
if git diff --cached --quiet; then
  echo "No changes to commit."
  exit 0
fi
git commit -q -m "chore: update SEC data"

# What this run produced, kept outside the work tree. tickers.txt only when this run changed it: otherwise a stale copy
# must never overwrite a newer tickers.txt that someone pushed meanwhile.
SNAP="$(mktemp -d)"
cp -R data "$SNAP/data"
TICKERS_CHANGED=0
if ! git diff --quiet HEAD~1 HEAD -- tickers.txt 2>/dev/null; then
  TICKERS_CHANGED=1
  cp tickers.txt "$SNAP/tickers.txt"
fi

for attempt in 1 2 3; do
  if git pull --rebase -X theirs origin "$BRANCH" && git push origin "HEAD:$BRANCH"; then
    echo "Pushed (attempt $attempt)."
    exit 0
  fi
  echo "Push attempt $attempt failed"
  git rebase --abort 2>/dev/null || true
  sleep $((attempt * SLEEP))
done

echo "Rebase/push kept failing: resetting to origin/$BRANCH and re-applying this run's data on top"
for attempt in 1 2 3; do
  git rebase --abort 2>/dev/null || true
  if git fetch origin "$BRANCH" && git reset --hard "origin/$BRANCH"; then
    cp -R "$SNAP/data/." data/
    if [ "$TICKERS_CHANGED" = "1" ]; then cp "$SNAP/tickers.txt" tickers.txt; fi
    git add data tickers.txt 2>/dev/null || git add data
    if git diff --cached --quiet; then
      echo "Nothing to re-apply: origin/$BRANCH already has this data."
      exit 0
    fi
    git commit -q -m "chore: update SEC data"
    if git push origin "HEAD:$BRANCH"; then
      echo "Pushed after reset (attempt $attempt)."
      exit 0
    fi
  fi
  echo "Re-apply attempt $attempt failed"
  sleep $((attempt * SLEEP))
done
echo "Push failed after all attempts"
exit 1
