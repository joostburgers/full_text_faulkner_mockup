import json, re, bisect
from html import escape

with open(r'c:\Users\joost\source\repos\full_text_faulkner_mockup\full_text\faulkner_roseforemily_1930_RE.txt', encoding='utf-8') as f:
    full_text = f.read()

with open(r'c:\Users\joost\source\repos\full_text_faulkner_mockup\a_rose_for_emily_model\data\re_events.json') as f:
    evs = json.load(f)['results']

events = sorted(evs, key=lambda e: float(e['order_within_page']))

def find_anchor(text, first_words):
    fw = re.sub(r'\s+', ' ', first_words.strip())
    words = fw.split()[:5]
    pat = r'[,;:\-\s]*'.join(re.escape(w) for w in words)
    m = re.search(pat, text, re.IGNORECASE)
    if m:
        return m.start()
    pat3 = r'[,;:\-\s]*'.join(re.escape(w) for w in words[:3])
    m3 = re.search(pat3, text, re.IGNORECASE)
    return m3.start() if m3 else None

anchors = []
for ev in events:
    pos = find_anchor(full_text, ev.get('first_words', ''))
    anchors.append((ev['event_nid'], pos))

# Build event ranges: (actual_start, end, nid_str)
ranges = []
for i, (nid, start) in enumerate(anchors):
    actual_start = 0 if i == 0 else start
    end = anchors[i+1][1] if i+1 < len(anchors) else len(full_text)
    ranges.append((actual_start, end, str(nid)))

range_starts = [r[0] for r in ranges]
range_nids   = [r[2] for r in ranges]

def nid_at(pos):
    idx = bisect.bisect_right(range_starts, pos) - 1
    return range_nids[max(0, idx)]

# Event boundary positions (exclude 0)
boundary_set = set(r[0] for r in ranges if r[0] > 0)

# Find paragraph spans (char offsets)
roman_re = re.compile(r'^[IVXivx]+$')
para_spans = []
cur = 0
for m in re.finditer(r'\n\n+', full_text):
    para_spans.append((cur, m.start()))
    cur = m.end()
para_spans.append((cur, len(full_text)))

html_parts = []
for p_start, p_end in para_spans:
    para_text = full_text[p_start:p_end].strip()
    if not para_text:
        continue
    if roman_re.match(para_text):
        html_parts.append('<div class="ft-section-num">' + escape(para_text) + '</div>')
        continue
    # Find event boundaries inside this paragraph
    boundaries = sorted(b for b in boundary_set if p_start < b < p_end)
    seg_starts = [p_start] + boundaries
    seg_ends   = boundaries + [p_end]
    para_html = '<p>'
    for idx2, (s, e) in enumerate(zip(seg_starts, seg_ends)):
        nid = nid_at(s)
        seg_text = full_text[s:e].replace('\n', ' ')
        # Only strip leading whitespace on the first segment and trailing on the last
        if idx2 == 0:
            seg_text = seg_text.lstrip()
        if idx2 == len(seg_starts) - 1:
            seg_text = seg_text.rstrip()
        para_html += '<span class="ft-hl-span" data-nid="' + nid + '">' + escape(seg_text) + '</span>'
    para_html += '</p>'
    html_parts.append(para_html)

result = {'html': ''.join(html_parts)}
out_path = r'c:\Users\joost\source\repos\full_text_faulkner_mockup\a_rose_for_emily_model\data\re_text_highlighted.json'
with open(out_path, 'w', encoding='utf-8') as f:
    json.dump(result, f, ensure_ascii=False)

print(f'Built: {len(html_parts)} paragraphs/sections, {len(result["html"])} chars')
for p_start, p_end in para_spans[:10]:
    para_text = full_text[p_start:p_end].strip()
    bounds = [b for b in boundary_set if p_start < b < p_end]
    if bounds:
        print(f'  Para at {p_start}: {len(bounds)} boundary(ies) inside')
        print(f'    {repr(para_text[:80])}')
