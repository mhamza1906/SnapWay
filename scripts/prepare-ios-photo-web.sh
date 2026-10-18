#!/bin/bash
# Run by Xcode, not by the agent. Rebuild web sources only when their fingerprint changes.
set -euo pipefail
script_directory="$(cd "$(dirname "$0")" && pwd)"
node_binary="${NODE_BINARY:-}"
if [ -z "$node_binary" ]; then
  for candidate in "$HOME"/.nvm/versions/node/v24.*/bin/node; do
    if [ -x "$candidate" ]; then node_binary="$candidate"; fi
  done
fi
if [ -z "$node_binary" ]; then node_binary="$(command -v node || true)"; fi
if [ -z "$node_binary" ]; then
  echo 'error: Node.js 24 is required to refresh the iPhone photo screen.' >&2
  exit 1
fi
export PATH="$(dirname "$node_binary"):$PATH"
export NG_BUILD_MAX_WORKERS=2
exec "$node_binary" "$script_directory/prepare-ios-photo-web.mjs" "$@"
