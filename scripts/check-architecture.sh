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
# 8. Hardcoded colors in public/*.html — opp2.html and tournaments.html
#    both shipped panel/header backgrounds and borders as literal hex
#    values instead of this app's theme-aware CSS variables (--clr-surface,
#    --clr-border, --clr-text-muted, etc. — see public/css/style.css's
#    :root block), so half the "Piste assignment" card and the tournament
#    header row stayed light in dark mode (found+fixed 2026-08-29).
#
#    Originally scoped to near-grayscale values only (structural colors
#    happened to all be grayscale, status colors hued). Broadened
#    2026-08-29 to flag every hardcoded hex color, not just grayscale: the
#    goal isn't only dark-mode correctness anymore but making a future
#    look-and-feel re-skin easy — any hardcoded color, hued or not (brand
#    blue, status colors, badge colors), is a color a re-skinner would have
#    to hunt down by hand instead of changing one variable in style.css.
#    public/css/style.css now carries a full token set for this: structural
#    (surface/bg/border/muted-text/row-hover/table-header/button) plus
#    semantic box colors (warn/danger/success/info bg+text+border) plus a
#    few small app-specific categories (neutral/secondary badge, pool/DE
#    badge). A 2026-08-29 pass converted ~608 sites to these tokens.
#
#    What's deliberately still hardcoded and NOT a bug: real-world fixed
#    conventions this app must never let a re-skin touch — e.g. FIE card
#    colors (yellow/red/black cards in scoresheet.html) and per-item
#    categorical color-coding (assigning a fencer/team/referee "red" vs
#    "black" as a chip color) are domain colors, not brand identity, and a
#    re-skin has no business changing what a black card looks like. These
#    should get a `theme-ok` comment to document the decision and silence
#    the warning; the check does not try to guess this itself, since only a
#    human can tell "domain-fixed color" from "brand color someone forgot
#    to tokenize."
#
#    Escape hatch: a `theme-ok` comment anywhere on the same line marks a
#    hardcoded color as deliberate — same pattern as the dynamic-sql-ok
#    marker for db.prepare() above. A page-local custom-property definition
#    (`--foo: #hex;`) is exempted automatically rather than needing
#    theme-ok on every one — that hex IS the token's definition, the same
#    role style.css's own :root block plays (which this check doesn't scan
#    at all, for the same reason).
#
#    CLAUDE.md hard rule (added 2026-08-30, "No new hardcoded colors"): new
#    code must reuse an existing var(--clr-...) token, or get the user's
#    explicit authorization before introducing a genuinely new color. This
#    is enforced here via scripts/color-debt-baseline.txt — every hardcoded
#    color already known about at the time the rule was added is grandfathered
#    in as a WARN; anything NOT in that baseline (a color in a file/value
#    combination that isn't already listed) is a FAIL. This is what makes the
#    rule bite only on new debt instead of blocking every commit over the
#    138 pre-existing warnings — see the baseline file's own header for how
#    to retire an entry (fix it) versus add one (don't, without authorization
#    — use an inline theme-ok comment for a genuine one-off instead).
# ─────────────────────────────────────────────────────────────────────────
section "Hardcoded colors in public/*.html"
COLOR_HITS=0
NEW_COLOR_HITS=0
declare -A COLOR_BASELINE
if [ -f scripts/color-debt-baseline.txt ]; then
  while IFS= read -r line; do
    [[ "$line" =~ ^#.*$ || -z "$line" ]] && continue
    COLOR_BASELINE["$line"]=1
  done < scripts/color-debt-baseline.txt
fi
for f in public/*.html; do
  [ -f "$f" ] || continue
  hits=$(awk '
    {
      n = $0
      off = 0
      while (match(n, /#[0-9a-fA-F]{3}([0-9a-fA-F]{3})?/)) {
        hex = substr(n, RSTART, RLENGTH)
        pre = substr($0, 1, off + RSTART - 1)
        n = substr(n, RSTART + RLENGTH)
        off += RSTART + RLENGTH - 1
        if ($0 !~ /theme-ok/ && pre !~ /--[a-zA-Z0-9-]+ *: *$/) {
          print FNR": "hex
        }
      }
    }
  ' "$f")
  if [ -n "$hits" ]; then
    while IFS= read -r hit; do
      hexval=$(echo "$hit" | sed -E 's/^[0-9]+: //' | tr 'A-F' 'a-f')
      key="$f:$hexval"
      if [ -n "${COLOR_BASELINE[$key]:-}" ]; then
        echo "  warn: $f:$hit — hardcoded color, use a var(--clr-...) token instead (grandfathered, see scripts/color-debt-baseline.txt)"
        WARN=$((WARN+1))
      else
        echo "  FAIL: $f:$hit — new hardcoded color, not in scripts/color-debt-baseline.txt. Reuse an existing var(--clr-...) token, or get explicit user authorization before adding a new one (then add it to style.css as a named token, not an inline literal)."
        FAIL=$((FAIL+1))
        NEW_COLOR_HITS=$((NEW_COLOR_HITS+1))
      fi
      COLOR_HITS=$((COLOR_HITS+1))
    done <<< "$hits"
  fi
done
[ "$COLOR_HITS" -eq 0 ] && echo "  (clean)"

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
