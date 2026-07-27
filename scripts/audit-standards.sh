#!/usr/bin/env bash
# Rule 8 — "Weekly grep audit for banned patterns, reported as a metric."
#
# Covers what eslint/stylelint structurally cannot:
#   - hex literals inside index.css RULES (stylelint's color-no-hex has to be
#     off for that file, because the token DEFINITIONS live there)
#   - token-file contrast ratios (Rule 1: verified in the token file)
#   - system-level counts that are backlog metrics, not pass/fail gates
#
# Exit 1 if any HARD invariant regressed. Backlog counts never fail the build;
# they are printed so the trend is visible (Rule 8: "component reuse rate is
# the health signal -- if it falls, the system is becoming fiction").
set -uo pipefail
cd "$(dirname "$0")/.." || exit 1
SRC=frontend/src
STYLES=$SRC/styles
fail=0

hdr() { printf '\n\033[1m%s\033[0m\n' "$1"; }
# hard <label> <count> -- must be 0
hard() {
  if [ "$2" -eq 0 ]; then printf '  \033[32mPASS\033[0m  %-46s %s\n' "$1" "$2"
  else printf '  \033[31mFAIL\033[0m  %-46s %s\n' "$1" "$2"; fail=1; fi
}
soft() { printf '  ....  %-46s %s\n' "$1" "$2"; }

# --- Rule 1: tokens are the only visual truth -------------------------------
hdr "Rule 1 — tokens"

# Hex on a line that is NOT a custom-property declaration, with /* */ comments
# stripped first -- the token block's prose legitimately cites hex values.
strip_comments() { python3 -c "
import re,sys
for f in sys.argv[1:]:
    s = re.sub(r'/\*.*?\*/', '', open(f).read(), flags=re.S)
    print(s)
" "$@"; }

css_hex=$(strip_comments "$STYLES"/*.css | grep -E '#[0-9a-fA-F]{3,8}\b' \
          | grep -vE '^\s*--' | wc -l)
hard "hex literals in CSS rules" "$css_hex"

# Hex in app code. The one legitimate exception carries an eslint-disable.
tsx_hex=$(grep -hE '#[0-9a-fA-F]{3,8}' "$SRC"/components/*.tsx "$SRC"/*.tsx 2>/dev/null \
          | grep -vE 'eslint-disable|DEFAULT_REASON_COLOR' | wc -l)
hard "hex literals in components" "$tsx_hex"

raw_z=$( { strip_comments "$STYLES"/*.css; cat "$SRC"/components/*.tsx "$SRC"/*.tsx 2>/dev/null; } \
        | grep -oE 'z-index:\s*[0-9]+|zIndex: [0-9]+' | wc -l)
hard "raw numeric z-index" "$raw_z"

raw_r=$(grep -hE 'border-radius:\s*[^v;]' "$STYLES"/*.css | grep -v 'var(' \
        | grep -vE ':\s*0;' | wc -l)
hard "raw border-radius (non-zero)" "$raw_r"

vh=$(grep -hoE '[^d]100vh' "$STYLES"/*.css "$SRC"/components/*.tsx "$SRC"/*.tsx 2>/dev/null | wc -l)
hard "100vh (must be 100dvh)" "$vh"

# --- Rule 1/7: contrast verified in the token file --------------------------
hdr "Rule 1/7 — token contrast (>= 4.5:1 for text)"
python3 - <<'PY'
import re, sys
def lin(c):
    c /= 255
    return c/12.92 if c <= 0.04045 else ((c+0.055)/1.055)**2.4
def L(h):
    h = h.lstrip('#'); r,g,b = (int(h[i:i+2],16) for i in (0,2,4))
    return 0.2126*lin(r)+0.7152*lin(g)+0.0722*lin(b)
def ratio(f,b):
    a,c = L(f),L(b); hi,lo = max(a,c),min(a,c)
    return (hi+0.05)/(lo+0.05)
text = open('frontend/src/styles/index.css').read()
def block(p):
    m = re.search(p+r'\s*\{(.*?)\n\}', text, re.S)
    return dict(re.findall(r'(--[a-z0-9-]+)\s*:\s*(#[0-9a-fA-F]{6})\s*;', m.group(1))) if m else {}
FG_PREFIX = ('--text-','--accent-','--status-','--rank-','--reason-','--journey-')
SKIP = ('-bg','-glow','-border','-on-accent','-on-danger','-hover','-light','-soft')
# Fill-only tokens: never applied via `color:`, so the 4.5:1 text floor does not
# apply to them (Rule 7 requires only 3:1 for UI boundaries). Verified by
# grepping for `color: var(<token>)` -- re-check if that changes.
FILL_ONLY = ('--accent-secondary',)
bad = 0
for nm, pat in (('dark', r':root,\s*\n:root\[data-theme="dark"\]'),
                ('light', r':root\[data-theme="light"\]')):
    pal = block(pat)
    bgs = [b for b in ('--bg-primary','--bg-card') if b in pal]
    for t, v in pal.items():
        if not t.startswith(FG_PREFIX) or any(s in t for s in SKIP) or t in FILL_ONLY:
            continue
        worst = min(ratio(v, pal[b]) for b in bgs)
        if worst < 4.5:
            print(f"  \033[31mFAIL\033[0m  {nm:5} {t:24} {v}  {worst:.2f}:1")
            bad += 1
if bad == 0:
    print("  \033[32mPASS\033[0m  all text tokens clear 4.5:1 in both themes")
sys.exit(1 if bad else 0)
PY
[ $? -ne 0 ] && fail=1

# --- Rule 0 / A.1: one implementation per concept ---------------------------
hdr "Rule 0 / A.1 — consolidation backlog (metrics, not gates)"
soft "distinct <button> className strings" \
  "$(grep -ohE '<button[^>]*className="[^"]*"' "$SRC"/components/*.tsx "$SRC"/components/ui/*.tsx "$SRC"/*.tsx 2>/dev/null \
     | grep -oE 'className="[^"]*"' | sort -u | wc -l)"
soft "anchored-panel implementations" \
  "$(grep -lE 'getBoundingClientRect' "$SRC"/components/*.tsx 2>/dev/null | wc -l)"
soft "inline style={{ }} occurrences" \
  "$(grep -ohE 'style=\{\{' "$SRC"/components/*.tsx "$SRC"/*.tsx 2>/dev/null | wc -l)"
soft "physical props in CSS (want logical)" \
  "$(grep -hoE '(margin|padding|border)-(left|right):' "$STYLES"/*.css | wc -l)"
soft "@container queries (want > 0)" \
  "$(grep -hoE '@container' "$STYLES"/*.css | wc -l)"
soft "jsx-a11y warnings" \
  "$(cd frontend && npx eslint src -f json 2>/dev/null \
     | python3 -c 'import json,sys;d=json.load(sys.stdin);print(sum(1 for f in d for m in f["messages"] if (m.get("ruleId") or "").startswith("jsx-a11y")))' 2>/dev/null || echo '?')"

# ui/ adoption -- the reuse-rate health signal
ui_users=$(grep -lE "from '\./ui|from '\.\./ui" "$SRC"/components/*.tsx "$SRC"/*.tsx 2>/dev/null | wc -l)
total=$(ls "$SRC"/components/*.tsx "$SRC"/*.tsx 2>/dev/null | wc -l)
soft "ui/ adoption (files importing ui/)" "$ui_users / $total"

hdr "Result"
if [ $fail -eq 0 ]; then
  printf '  \033[32mall hard invariants hold\033[0m\n\n'; exit 0
else
  printf '  \033[31mone or more hard invariants regressed\033[0m\n\n'; exit 1
fi
