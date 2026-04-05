#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VERSION=$(node -p "require('$REPO_ROOT/agent-bridge/package.json').version")

echo "Bumping docs to v$VERSION"
echo ""

# Patterns: match any semver-like version after known prefixes
FILES_AND_PATTERNS=(
  # docs/documentation.md — header line
  "docs/documentation.md|s/\*\*Version [0-9][0-9]*\.[0-9][0-9]*\.[0-9][0-9]*\*\*/**Version $VERSION**/g"
  # docs/documentation.md — footer line
  "docs/documentation.md|s/Neohive v[0-9][0-9]*\.[0-9][0-9]*\.[0-9][0-9]*/Neohive v$VERSION/g"
  # docs/reference/configuration.md — footer line
  "docs/reference/configuration.md|s/Neohive v[0-9][0-9]*\.[0-9][0-9]*\.[0-9][0-9]*/Neohive v$VERSION/g"
)

CHANGED=0

for entry in "${FILES_AND_PATTERNS[@]}"; do
  FILE="${entry%%|*}"
  PATTERN="${entry##*|}"
  FILEPATH="$REPO_ROOT/$FILE"

  if [ ! -f "$FILEPATH" ]; then
    echo "  SKIP  $FILE (not found)"
    continue
  fi

  BEFORE=$(cat "$FILEPATH")
  sed -i '' "$PATTERN" "$FILEPATH"
  AFTER=$(cat "$FILEPATH")

  if [ "$BEFORE" != "$AFTER" ]; then
    echo "  UPDATED  $FILE"
    CHANGED=$((CHANGED + 1))
  else
    echo "  OK       $FILE (already at v$VERSION)"
  fi
done

echo ""
echo "Done. $CHANGED file(s) updated to v$VERSION."
echo ""
echo "Next steps:"
echo "  git add -A && git commit -m \"chore(release): bump to v$VERSION\""
