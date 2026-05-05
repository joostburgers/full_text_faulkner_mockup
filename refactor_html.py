"""
refactor_html.py
Performs four cleanup tasks on DIGITAL Yoknapatawpha.html:
  1. Extracts the <style> block to dy-mockup.css and replaces it with <link>
  2. Extracts the new mockup <script> IIFE to dy-mockup.js and replaces with <script src>
  3. Removes the dead .ft-menu-wrap / .ft-menu-btn / .ft-dropdown CSS rules
  4. Removes live console.log statements from the legacy map JS section
"""

import re, os

SRC  = r'a_rose_for_emily_model\DIGITAL Yoknapatawpha.html'
CSS_OUT = r'a_rose_for_emily_model\dy-mockup.css'
JS_OUT  = r'a_rose_for_emily_model\dy-mockup.js'

with open(SRC, encoding='utf-8') as f:
    html = f.read()

original_len = len(html)

# ── 1. Extract <style> block ──────────────────────────────────────────────────
# The style block sits between (and including) the opening/closing tags.
# We want to capture everything between <style> and </style> (including newlines).
style_match = re.search(r'    <style>\n(.*?)\n    </style>', html, re.DOTALL)
if not style_match:
    raise RuntimeError('Could not find <style> block')

css_content = style_match.group(1)
print(f'CSS block: {len(css_content.splitlines())} lines')

# ── 3. Remove dead .ft-menu-* CSS from the extracted CSS ─────────────────────
# The rules run from ".ft-menu-wrap { ... }" through ".ft-dropdown label:hover { ... }"
# Identify them by looking for the first rule and matching forward to a blank line after
# the last .ft-dropdown rule.
dead_css_pattern = re.compile(
    r'\n\t\.ft-menu-wrap \{ position: relative; \}\n'
    r'\t\.ft-menu-btn \{.*?\}\n'
    r'\t\.ft-menu-btn:hover.*?\n'
    r'\t\.ft-menu-btn::after \{.*?\}\n'
    r'\t\.ft-dropdown \{.*?\n.*?\n.*?\n.*?\}\n'
    r'\t\.ft-dropdown\.open \{.*?\}\n'
    r'\t\.ft-dropdown label \{.*?\n.*?\n.*?\}\n'
    r'\t\.ft-dropdown label:hover \{.*?\}',
    re.DOTALL
)
before = len(css_content)
css_content_cleaned = dead_css_pattern.sub('', css_content)
if len(css_content_cleaned) == before:
    # Fallback: remove line-by-line approach
    lines = css_content.split('\n')
    out_lines = []
    skip = False
    for i, ln in enumerate(lines):
        stripped = ln.strip()
        if stripped.startswith('.ft-menu-wrap') or stripped.startswith('.ft-menu-btn') or stripped.startswith('.ft-dropdown'):
            skip = True
        if skip:
            if stripped == '}' or stripped.endswith('}'):
                skip = False
                continue
            continue
        out_lines.append(ln)
    css_content_cleaned = '\n'.join(out_lines)
    print(f'Dead CSS removed (fallback): {before - len(css_content_cleaned)} chars')
else:
    print(f'Dead CSS removed: {before - len(css_content_cleaned)} chars')

# Write CSS file
with open(CSS_OUT, 'w', encoding='utf-8') as f:
    f.write(css_content_cleaned)
print(f'Written: {CSS_OUT}')

# Replace <style>...</style> in HTML with <link>
html = html.replace(
    style_match.group(0),
    '    <link rel="stylesheet" href="./dy-mockup.css">'
)
print('Style block replaced with <link>')

# ── 2. Extract new mockup <script> IIFE ──────────────────────────────────────
# The block starts with the comment banner and <script> on line 3729.
# Exact anchors:
SCRIPT_OPEN_MARKER = '''<!-- ═══════════════════════════════════════════════════════════════
     FULL-TEXT + INFO PANEL WIRING
     Shows scrollable event list; click first words to expand full
     text; clicking a row positions characters on the map.
════════════════════════════════════════════════════════════════ -->
<script>
(function () {'''

SCRIPT_CLOSE_MARKER = '''})();
</script>
</body></html>'''

start_idx = html.find(SCRIPT_OPEN_MARKER)
end_idx   = html.find(SCRIPT_CLOSE_MARKER)
if start_idx == -1:
    raise RuntimeError('Could not find new JS script open marker')
if end_idx == -1:
    raise RuntimeError('Could not find new JS script close marker')

# The JS content is everything from "(function () {" to "})();"
js_body_start = html.index('(function () {', start_idx)
js_body_end   = end_idx + len('})();')
js_content = html[js_body_start:js_body_end]

# Wrap as self-contained IIFE in the JS file
with open(JS_OUT, 'w', encoding='utf-8') as f:
    f.write(js_content + '\n')
print(f'Written: {JS_OUT}  ({len(js_content.splitlines())} lines)')

# Replace the entire comment+script block in HTML with a <script src>
old_block = html[start_idx : end_idx + len(SCRIPT_CLOSE_MARKER)]
new_block = '<script src="./dy-mockup.js"></script>\n</body></html>'
html = html[:start_idx] + new_block

print(f'Script block replaced with <script src="./dy-mockup.js">')

# ── 4. Remove live console.log statements from the legacy map section ─────────
# Only remove lines that are *entirely* a console.log statement (not commented out).
# The legacy map JS runs from line ~61 to ~1947 in the original file.
# We'll just do a global pass, but exclude any line that is inside a // comment.
lines = html.split('\n')
removed = 0
new_lines = []
for ln in lines:
    stripped = ln.strip()
    # Skip lines that are purely a console.log (not commented out)
    if stripped.startswith('console.log(') and not stripped.startswith('//'):
        removed += 1
        continue
    new_lines.append(ln)
html = '\n'.join(new_lines)
print(f'Removed {removed} live console.log lines')

# Write result
with open(SRC, 'w', encoding='utf-8') as f:
    f.write(html)
print(f'Written: {SRC}  (was {original_len}, now {len(html)} bytes)')
