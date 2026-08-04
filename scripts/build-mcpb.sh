#!/usr/bin/env bash
set -euo pipefail

# Builds the MCPB (Claude Desktop extension) bundle for the Voyagier CLI.
# The bundle is a zip with manifest.json at the root and the published npm package
# staged under server/node_modules/@voyagier/cli.

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

version="$(node -p "require('./package.json').version")"
pkg="@voyagier/cli@${version}"

out_dir="$repo_root/dist-mcpb"
out_file="$out_dir/voyagier-${version}.mcpb"
mkdir -p "$out_dir"

stage="$(mktemp -d)"
cleanup() { rm -rf "$stage"; }
trap cleanup EXIT

echo "Building MCPB for ${pkg}"

# Install the published package into the staging server dir.
# npm install in a bare dir without package.json silently no-ops, so init first.
mkdir -p "$stage/server"
(
  cd "$stage/server"
  npm init -y >/dev/null
  npm install "$pkg" --omit=dev --silent
)

# Stage the manifest, substituting the real version for the placeholder.
node -e '
  const fs = require("fs");
  const src = process.argv[1];
  const dst = process.argv[2];
  const version = process.argv[3];
  const text = fs.readFileSync(src, "utf8").replace(/__VERSION__/g, version);
  fs.writeFileSync(dst, text);
' "$repo_root/mcpb/manifest.json" "$stage/manifest.json" "$version"

# Zip the staging dir contents (manifest.json at root) into the .mcpb.
rm -f "$out_file"
(
  cd "$stage"
  zip -qr "$out_file" .
)

# Smoke test: initialize the MCP server from the staged copy and confirm it
# reports serverInfo. EPIPE from `head` closing the pipe early is harmless.
echo "Running smoke test..."
smoke_out="$(
  printf '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"smoke","version":"0"}}}\n' \
    | VOYAGIER_TOKEN=dummy node "$stage/server/node_modules/@voyagier/cli/dist/index.js" mcp 2>/dev/null \
    | head -1 || true
)"

if ! grep -q '"serverInfo"' <<<"$smoke_out"; then
  echo "Smoke test FAILED: no serverInfo in MCP initialize response" >&2
  echo "Output was: $smoke_out" >&2
  exit 1
fi
echo "Smoke test passed."

sha256="$(sha256sum "$out_file" | awk '{print $1}')"
echo ""
echo "Bundle: $out_file"
echo "sha256: $sha256"
