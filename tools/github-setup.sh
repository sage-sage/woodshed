#!/usr/bin/env bash
# One-time: create the public "woodshed" repo with GitHub Pages and publish the first release.
# Run after `gh auth login`.  bash tools/github-setup.sh
set -euo pipefail
HOME_DIR=/c/Users/Shado
OWNER=$(gh api user -q .login)
ID=$(gh api user -q .id)
echo "GitHub account: $OWNER"

# Name the account in the amp and the extension (update URLs, allowed origin, default Woodshed address).
sed -i "s/__GH_OWNER__/$OWNER/g" $HOME_DIR/woodshed-amp/src/version.h
grep -rl "__GH_OWNER__" $HOME_DIR/woodshed-tab-grabber --include=*.js --include=*.json --include=*.html \
  | xargs -r sed -i "s/__GH_OWNER__/$OWNER/g"
(cd $HOME_DIR/woodshed-amp && ./build.sh >/dev/null && ./build/wsamp-ws-tests.exe | tail -1)

gh repo view "$OWNER/woodshed" >/dev/null 2>&1 || \
  gh repo create woodshed --public -d "Woodshed: guitar practice in the browser, with a low-latency amp and a tab grabber"
mkdir -p $HOME_DIR/woodshed-pub
cd $HOME_DIR/woodshed-pub
[ -d .git ] || git init -q -b main
git config user.name "$OWNER"
git config user.email "$ID+$OWNER@users.noreply.github.com"
git remote get-url origin >/dev/null 2>&1 || git remote add origin "https://github.com/$OWNER/woodshed.git"
gh auth setup-git

python -I $HOME_DIR/woodshed/tools/release.py "Woodshed Amp 1.3.0: updates itself from GitHub"
gh api -X POST "repos/$OWNER/woodshed/pages" -f "source[branch]=main" -f "source[path]=/" >/dev/null 2>&1 \
  || echo "(Pages already on)"
echo "Site: https://$OWNER.github.io/woodshed/  (first deploy takes a minute or two)"
