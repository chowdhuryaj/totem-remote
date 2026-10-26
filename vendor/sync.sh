#!/bin/sh
# Vendors Totem-Flask modules from a pinned commit, reading ONLY via `git show` (never the working tree,
# never modifying that repo). Only change: import specifiers lose their ?v=NN cache stamp.
# Usage: vendor/sync.sh [SHA]   (default: the SHA recorded in vendor/flask/SOURCE)
set -eu
cd "$(dirname "$0")"
REPO=/Users/aj/dev/Input/Flask-Svalboard/flask-web-unify
SHA=$(git -C "$REPO" rev-parse "${1:-$(sed -n 's/^sha=//p' flask/SOURCE 2>/dev/null || echo a61e524)}")
FILES="zmk-studio.js diag.js behavior-catalog.js zmk-keycodes.js keycodes.js zmk-totem-layout.js zmk-totem-default.js boards.js zmk.js zmk-endgame.js flaskproto.js svalboard-layout.js zmk-holdtap-codec.js zmk-tapdance-codec.js zmk-tapdance-io.js zmk-combos-codec.js zmk-macros-codec.js zmk-autoshift-codec.js zmk-adaptive-codec.js zmk-csk-codec.js"
mkdir -p flask
{ echo "repo=$REPO"; echo "sha=$SHA"; echo "files=$FILES"; } > flask/SOURCE.new
for f in $FILES; do
  git -C "$REPO" show "$SHA:$f" | perl -pe 's/(["\x27])(\.\/[^"\x27?]+)\?v=\d+(["\x27])/$1$2$3/g' > "flask/$f"
done
mv flask/SOURCE.new flask/SOURCE
echo "vendored $(echo $FILES | wc -w | tr -d ' ') files from $SHA"
