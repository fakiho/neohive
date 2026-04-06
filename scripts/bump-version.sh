#!/usr/bin/env bash
# Usage:
#   bash scripts/bump-version.sh           # sync docs to version already in package.json
#   bash scripts/bump-version.sh 6.5.0     # bump package.json then sync everywhere
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PACKAGE_JSON="$REPO_ROOT/agent-bridge/package.json"

# ── 1. Optionally write a new version into package.json ─────────────────────
if [[ "${1:-}" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  NEW="$1"
  OLD=$(node -p "require('$PACKAGE_JSON').version")
  if [[ "$NEW" == "$OLD" ]]; then
    echo "Already at v$NEW — nothing to do."
    exit 0
  fi
  # Use npm to write version (also validates semver)
  npm --prefix "$REPO_ROOT/agent-bridge" version "$NEW" --no-git-tag-version --allow-same-version > /dev/null
  echo "package.json  → $NEW"
fi

VERSION=$(node -p "require('$PACKAGE_JSON').version")
MAJOR_MINOR=$(echo "$VERSION" | cut -d. -f1-2)

echo ""
echo "Bumping all files to v$VERSION"
echo ""

# ── 2. Regenerate package-lock.json ─────────────────────────────────────────
echo -n "  package-lock.json … "
npm --prefix "$REPO_ROOT/agent-bridge" install --package-lock-only --silent 2>/dev/null
echo "done"

# ── 3. Docs — sed patterns ──────────────────────────────────────────────────
# Format: "relative/path/to/file|sed-expression"
# Multiple patterns for the same file are fine.
FILES_AND_PATTERNS=(
  # docs/documentation.md — header badge
  "docs/documentation.md|s/\*\*Version [0-9][0-9]*\.[0-9][0-9]*\.[0-9][0-9]*\*\*/**Version $VERSION**/g"
  # docs/documentation.md — footer line
  "docs/documentation.md|s/Neohive v[0-9][0-9]*\.[0-9][0-9]*\.[0-9][0-9]*/Neohive v$VERSION/g"
  # docs/reference/configuration.md — footer line
  "docs/reference/configuration.md|s/Neohive v[0-9][0-9]*\.[0-9][0-9]*\.[0-9][0-9]*/Neohive v$VERSION/g"
  # dashboard.html — app footer (full semver)
  "agent-bridge/dashboard.html|s/Neohive v[0-9][0-9]*\.[0-9][0-9]*\.[0-9][0-9]*/Neohive v$VERSION/g"
  # dashboard.html — empty-state / docs headlines (major.minor only)
  "agent-bridge/dashboard.html|s/Neohive v[0-9][0-9]*\.[0-9][0-9]*/Neohive v$MAJOR_MINOR/g"
)

CHANGED=0

for entry in "${FILES_AND_PATTERNS[@]}"; do
  FILE="${entry%%|*}"
  PATTERN="${entry##*|}"
  FILEPATH="$REPO_ROOT/$FILE"

  if [[ ! -f "$FILEPATH" ]]; then
    echo "  SKIP     $FILE (not found)"
    continue
  fi

  BEFORE=$(cat "$FILEPATH")
  sed -i '' "$PATTERN" "$FILEPATH"
  AFTER=$(cat "$FILEPATH")

  if [[ "$BEFORE" != "$AFTER" ]]; then
    echo "  UPDATED  $FILE"
    CHANGED=$((CHANGED + 1))
  else
    echo "  OK       $FILE (already at v$VERSION)"
  fi
done

# ── 4. Sanity check — any stale semver left? ────────────────────────────────
STALE=$(grep -rn --include="*.md" --include="*.html" --include="*.json" \
  -E "v[0-9]+\.[0-9]+\.[0-9]+" "$REPO_ROOT" \
  --exclude-dir=node_modules \
  --exclude-dir=.git \
  | grep -v "$VERSION" \
  | grep -vE "package-lock|LICENSE|CHANGELOG|documentation-audit" \
  | grep -vE "Extension.{0,5}v[0-9]|\(v[0-9]" \
  | grep -vE "v[0-9]+\.[0-9]+\.[0-9]+ —" \
  | grep -vE "node_modules|\.git" \
  || true)

echo ""
echo "Done. $CHANGED file(s) updated to v$VERSION."

if [[ -n "$STALE" ]]; then
  echo ""
  echo "⚠️  Possible stale version strings found (review manually):"
  echo "$STALE" | sed 's/^/   /'
fi

echo ""
echo "Next step:"
echo "  git add -A && git commit -m \"chore(release): bump to v$VERSION\""
