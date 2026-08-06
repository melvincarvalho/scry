#!/bin/bash
# Re-vendor the markets engine from its home in jss-plugins (the source of
# truth, with the 75-test suite). Run after upstream engine changes.
set -e
SRC="${1:-$HOME/remote/github.com/JavaScriptSolidServer/plugins/markets}"
cp "$SRC"/{plugin.js,lmsr.js,store.js,lifecycle.js,guard.js,ui.js} markets/
echo "vendored from $SRC:"
git diff --stat markets/ | tail -1
