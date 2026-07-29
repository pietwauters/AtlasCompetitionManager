#!/usr/bin/env bash
# check-architecture.sh — cheap, mechanical checks for the recurring
# architecture problems this project has actually hit (see
# docs/architecture-kpis.md for the full KPI list, including the
# judgment-based ones this script can't check).
#
# Run before committing any change under services/, routes/, lib/, or
# public/*.html. Non-blocking by design (always exits 0) except for the
# CLAUDE.md "hard rules" section — those exit 1 so they're hard to miss.
#
# Usage: ./scripts/check-architecture.sh

set -uo pipefail
cd "$(dirname "$0")/.."

WARN=0
FAIL=0

section() { echo; echo "== $1 =="; }

# ─────────────────────────────────────────────────────────────────────────
# 1. File size — the god-file early-warning signal. Thresholds picked from
#    this project's own history: pipeline.js/phases.js/opp2.html were all
#    flagged well past 1000 lines; the goal is to catch it far earlier.
# ─────────────────────────────────────────────────────────────────────────
section "File size (services/, routes/, lib/, public/*.html)"
JS_WARN=500
JS_FLAG=800
HTML_WARN=1000
HTML_FLAG=1500

while IFS= read -r f; do
  lines=$(wc -l < "$f")
  if   [ "$lines" -ge "$JS_FLAG" ]; then echo "  GOD-FILE: $f ($lines lines, >= $JS_FLAG)"; WARN=$((WARN+1))
  elif [ "$lines" -ge "$JS_WARN" ]; then echo "  large:    $f ($lines lines, >= $JS_WARN)"; WARN=$((WARN+1))
  fi
done < <(find services routes lib -maxdepth 1 -name '*.js' 2>/dev/null)

while IFS= read -r f; do
  lines=$(wc -l < "$f")
  if   [ "$lines" -ge "$HTML_FLAG" ]; then echo "  GOD-FILE: $f ($lines lines, >= $HTML_FLAG)"; WARN=$((WARN+1))
  elif [ "$lines" -ge "$HTML_WARN" ]; then echo "  large:    $f ($lines lines, >= $HTML_WARN)"; WARN=$((WARN+1))
  fi
done < <(find public -maxdepth 1 -name '*.html' 2>/dev/null)

# public/js/*.js — same JS thresholds as services/routes/lib. Added
# 2026-07-29 alongside the opp2.html split (the six opp2-*.js mixin files it
# produced): the pre-existing loop above only ever scanned services/routes/
# lib, so these — and any other public/js/ file — would have drifted
# unnoticed the same way opp2.html itself did before this review existed.
while IFS= read -r f; do
  lines=$(wc -l < "$f")
  if   [ "$lines" -ge "$JS_FLAG" ]; then echo "  GOD-FILE: $f ($lines lines, >= $JS_FLAG)"; WARN=$((WARN+1))
  elif [ "$lines" -ge "$JS_WARN" ]; then echo "  large:    $f ($lines lines, >= $JS_WARN)"; WARN=$((WARN+1))
  fi
done < <(find public/js -maxdepth 1 -name '*.js' 2>/dev/null)
[ "$WARN" -eq 0 ] && echo "  (none over threshold)"

# ─────────────────────────────────────────────────────────────────────────
# 2. Prepared statements must be module-level constants (CLAUDE.md hard
#    rule). Heuristic: a db.prepare( call on a line with zero leading
#    whitespace is a module-level `const stmtX = db.prepare(...)`; any
#    indented occurrence is inline inside a function/method — UNLESS the
#    immediately preceding line carries a `// dynamic-sql-ok` marker, which
#    is this project's documented escape hatch for genuinely dynamic SQL
#    (e.g. a WHERE clause built from optional filters, CLAUDE.md's own
#    stated exception to the module-level rule).
# ─────────────────────────────────────────────────────────────────────────
section "Prepared statements (services/*.js) — must be module-level"
for f in services/*.js; do
  [ -f "$f" ] || continue
  read -r total inline <<< "$(awk '
    /db\.prepare\(/ {
      total++
      indented = ($0 ~ /^[ \t]/)
      marked = (prev ~ /dynamic-sql-ok/)
      if (indented && !marked) inline++
    }
    { prev = $0 }
    END { print total+0, inline+0 }
  ' "$f")"
  [ "$total" -eq 0 ] && continue
  modlevel=$((total - inline))
  if [ "$inline" -gt 0 ]; then
    echo "  FAIL: $f — $inline inline / $modlevel module-level db.prepare() calls"
    FAIL=$((FAIL+1))
  fi
done
[ "$FAIL" -eq 0 ] && echo "  (all clean so far)"

# ─────────────────────────────────────────────────────────────────────────
# 3. Raw SQL must live in services/, never routes/ — routes should call a
#    service function, not prepare/run SQL directly.
# ─────────────────────────────────────────────────────────────────────────
section "Raw SQL confined to services/ (routes/*.js must not call db.prepare)"
ROUTE_SQL=$(grep -l "db\.prepare(" routes/*.js 2>/dev/null || true)
if [ -n "$ROUTE_SQL" ]; then
  echo "$ROUTE_SQL" | while IFS= read -r f; do echo "  FAIL: $f calls db.prepare() directly"; done
  FAIL=$((FAIL + $(echo "$ROUTE_SQL" | wc -l)))
else
  echo "  (clean)"
fi

# ─────────────────────────────────────────────────────────────────────────
# 4. No ALTER TABLE outside db/migrations/*.sql — schema changes must be a
#    new numbered migration file, never mutated in application code.
# ─────────────────────────────────────────────────────────────────────────
section "Schema changes confined to db/migrations/"
ALTER_HITS=$(grep -rli "ALTER TABLE" services routes lib 2>/dev/null || true)
if [ -n "$ALTER_HITS" ]; then
  echo "$ALTER_HITS" | while IFS= read -r f; do echo "  FAIL: $f contains ALTER TABLE outside db/migrations/"; done
  FAIL=$((FAIL + $(echo "$ALTER_HITS" | wc -l)))
else
  echo "  (clean)"
fi

# ─────────────────────────────────────────────────────────────────────────
# 5. 'use strict' at the top of every services/routes/lib file.
# ─────────────────────────────────────────────────────────────────────────
section "'use strict' present (services/, routes/, lib/)"
for f in services/*.js routes/*.js lib/*.js; do
  [ -f "$f" ] || continue
  first_line=$(head -1 "$f")
  if [ "$first_line" != "'use strict';" ]; then
    echo "  warn: $f missing 'use strict'; as its first line"
    WARN=$((WARN+1))
  fi
done

# ─────────────────────────────────────────────────────────────────────────
# 6. Duplicate function/method definitions within the same file — the
#    opp2.html pendingSlotCount duplicate is exactly what this catches.
# ─────────────────────────────────────────────────────────────────────────
section "Duplicate function/method names within one file"
for f in services/*.js routes/*.js lib/*.js public/*.html public/js/*.js; do
  [ -f "$f" ] || continue
  # Matches both `function name(` and Alpine/object method-shorthand
  # `  name(args) {` (needs a lookahead for `(`, hence -P not -E).
  dups=$(grep -oP '(function[[:space:]]+[A-Za-z_][A-Za-z0-9_]*|^[[:space:]]{2,8}[A-Za-z_][A-Za-z0-9_]*(?=\([^)]*\)[[:space:]]*\{)) *\(' "$f" 2>/dev/null \
    | sed -E 's/^[[:space:]]+//; s/function[[:space:]]+//; s/[[:space:]]*\(.*//' \
    | grep -vE '^(if|for|while|switch|catch|function|do|else|with|return)$' \
    | sort | uniq -d)
  if [ -n "$dups" ]; then
    while IFS= read -r name; do
      echo "  warn: $f defines '$name' more than once"
      WARN=$((WARN+1))
    done <<< "$dups"
  fi
done

# ─────────────────────────────────────────────────────────────────────────
# 7. Circular requires / layering (services must never require routes).
# ─────────────────────────────────────────────────────────────────────────
section "Circular requires / layering (services <-> routes <-> lib)"
if node scripts/check-circular-requires.js; then
  :
else
  FAIL=$((FAIL+1))
fi

# ─────────────────────────────────────────────────────────────────────────
echo
echo "== Summary =="
echo "  warnings: $WARN"
echo "  hard-rule failures: $FAIL"
if [ "$FAIL" -gt 0 ]; then
  echo "  -> hard CLAUDE.md rules violated; fix before committing."
  exit 1
fi
exit 0
