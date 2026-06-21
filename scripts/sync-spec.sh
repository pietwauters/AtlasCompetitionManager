#!/usr/bin/env bash
# sync-spec.sh — keep docs/level2.md in sync with the official OpenPiste spec.
#
# Usage:
#   ./scripts/sync-spec.sh          # show diff between official and local
#   ./scripts/sync-spec.sh --update # overwrite local with official version
#
# The official spec lives at:
#   https://github.com/OpenPiste/protocols/blob/main/docs/level2.md

set -euo pipefail

REMOTE_URL="https://raw.githubusercontent.com/OpenPiste/protocols/main/docs/level2.md"
LOCAL="docs/level2.md"
TMP=$(mktemp /tmp/level2_remote_XXXXXX.md)

echo "Fetching official spec..."
curl -fsSL "$REMOTE_URL" -o "$TMP"

REMOTE_LINES=$(wc -l < "$TMP")
LOCAL_LINES=$(wc -l < "$LOCAL")
echo "  Official: ${REMOTE_LINES} lines"
echo "  Local:    ${LOCAL_LINES} lines"

if diff -q "$TMP" "$LOCAL" > /dev/null 2>&1; then
  echo "✓ Files are identical — local is in sync with official spec."
  rm "$TMP"
  exit 0
fi

echo ""
if [[ "${1:-}" == "--update" ]]; then
  cp "$TMP" "$LOCAL"
  echo "✓ Local docs/level2.md updated to match official spec."
  echo "  Review the changes with: git diff docs/level2.md"
else
  ONLY_REMOTE=$(diff "$TMP" "$LOCAL" | grep -c '^<' || true)
  ONLY_LOCAL=$(diff  "$TMP" "$LOCAL" | grep -c '^>' || true)
  echo "Files differ. Summary:"
  echo "  Lines only in official: ${ONLY_REMOTE}"
  echo "  Lines only in local:    ${ONLY_LOCAL}"
  echo ""
  echo "Run with --update to overwrite local with the official version,"
  echo "or review the full diff with:"
  echo "  diff ${TMP} ${LOCAL} | less"
  echo ""
  echo "To push local additions upstream, open a PR at:"
  echo "  https://github.com/OpenPiste/protocols"
fi

rm "$TMP"
