"""
build_text_data.py

Generates the local JSON dataset for one Faulkner text, replacing the live
Sinatra API calls used by the DY mockup.

    python build_text_data.py RE
    python build_text_data.py SF

Consolidates the three original RE-only scripts (build_re_data.py,
build_highlighted.py, gen_transitions.py) into one parameterised pipeline.

Sources
  dy_data/events.csv          one row per event (incl. kw_* keyword columns)
  dy_data/locations.csv       True X / True Y, Display Label, Type, ...
  dy_data/characters.csv      full character data
  dy_data/texts.csv           per-text metadata
  dy_data/sections.csv        section page ranges
  dy_data/editors.csv         editor credits
  all_events_sentences.csv    pre-matched event -> sentence text
  full_text/<text>.txt        plain text, used for unmatched events + highlighting
"""

import csv
import json
import os
import re
import sys
import bisect
from html import escape
from html.parser import HTMLParser
from collections import defaultdict

REPO = os.path.dirname(os.path.abspath(__file__))

# Per-text configuration. `section_re` matches a standalone paragraph that acts
# as a section heading; its text must match the .ft-sec-btn data-sec values.
TEXTS = {
    "RE": {
        "full_text":  os.path.join("full_text", "faulkner_roseforemily_1930_RE.txt"),
        "out_dir":    os.path.join("a_rose_for_emily_model", "data"),
        "prefix":     "re_",
        "section_re": r"^[IVXivx]+$",
    },
    "SF": {
        "full_text":  os.path.join("full_text", "faulkner_soundrevised_1929_SF.txt"),
        "out_dir":    os.path.join("sound_and_the_fury_model", "data"),
        "prefix":     "sf_",
        "section_re": r"^(?:January|February|March|April|May|June|July|August|"
                      r"September|October|November|December)\s+\w+,\s*\d{4}\.?$",
    },
}

EVENTS_CSV    = os.path.join(REPO, "dy_data", "events.csv")
LOCATIONS_CSV = os.path.join(REPO, "dy_data", "locations.csv")
CHARS_CSV     = os.path.join(REPO, "dy_data", "characters.csv")
TEXTS_CSV     = os.path.join(REPO, "dy_data", "texts.csv")
SECTIONS_CSV  = os.path.join(REPO, "dy_data", "sections.csv")
EDITORS_CSV   = os.path.join(REPO, "dy_data", "editors.csv")
SENTENCES_CSV = os.path.join(REPO, "all_events_sentences.csv")
FLAT_CSV      = os.path.join(REPO, "dy_database_flattened_2024_1_21_recovered.csv")

# The original dataset renders category names three different ways depending on
# the file, so each is kept explicit rather than derived.
KW_COLUMNS = {
    "kw_actions":           "Actions",
    "kw_aesthetics":        "Aesthetics",
    "kw_cultural_issues":   "Cultural Issues",
    "kw_environment":       "Environment",
    "kw_relationships":     "Relationships",
    "kw_themes_and_motifs": "Themes and Motifs",
}
# keywords.json -> by_category
KW_AGG_LABEL = {"Themes and Motifs": "Themes & Motifs"}
# keyword_index.json -> full, used as the prefix for terms with no subcategory
KW_FULL_LABEL = {"Themes and Motifs": "Themes And Motifs"}


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

class _HTMLStripper(HTMLParser):
    def __init__(self):
        super().__init__()
        self._parts = []

    def handle_data(self, data):
        self._parts.append(data)

    def get_text(self):
        return " ".join(self._parts).strip()


def strip_html(text):
    s = _HTMLStripper()
    s.feed(text or "")
    return s.get_text()


def normalise(text):
    """Lower-case, collapse whitespace, straighten quotes for matching."""
    text = strip_html(text)
    text = text.replace("\u2018", "'").replace("\u2019", "'")
    text = text.replace("\u201c", '"').replace("\u201d", '"')
    return re.sub(r"\s+", " ", text).strip().lower()


def read_csv(path, key_col, code):
    """Rows from `path` whose `key_col` equals `code`."""
    with open(path, encoding="utf-8-sig") as f:
        return [r for r in csv.DictReader(f) if (r.get(key_col) or "").strip() == code]


def write_json(out_dir, prefix, name, payload):
    path = os.path.join(out_dir, f"{prefix}{name}.json")
    with open(path, "w", encoding="utf-8") as f:
        json.dump(payload, f, indent=2, ensure_ascii=False)
    kb = os.path.getsize(path) / 1024
    print(f"  -> {os.path.basename(path)} ({kb:,.1f} KB)")


# ---------------------------------------------------------------------------
# Builders
# ---------------------------------------------------------------------------

def build_locations(code):
    records, lookup = [], {}
    for row in read_csv(LOCATIONS_CSV, "SourceTextCode", code):
        title = row["LocationTitle"].strip()
        rec = {
            "location_title":  title,
            "display_label":   row.get("Display Label", title).strip() or title,
            "source_text":     code,
            "x":               row.get("True X", "").strip(),
            "y":               row.get("True Y", "").strip(),
            "location_type":   row.get("Type", "").strip(),
            "location_key":    row.get("LocationKey", "").strip(),
            "description":     strip_html(row.get("Description", "")),
            "location_status": row.get("Status", "").strip(),
            "authority":       row.get("Authority", "").strip(),
            "other_texts":     row.get("OtherTexts", "").strip(),
            "other_structure": row.get("Other Structure", "").strip(),
            "role":            row.get("Role", "").strip(),
        }
        lookup[title] = rec
        records.append(rec)

    # locations.csv often has empty True X/Y; recover them from the flat export.
    flat = {}
    with open(FLAT_CSV, encoding="utf-8-sig") as f:
        for row in csv.DictReader(f):
            lt = row.get("LocationTitle", "").strip()
            if lt and lt not in flat:
                tx, ty = row.get("True_X", "").strip(), row.get("True_Y", "").strip()
                if tx and ty:
                    flat[lt] = (tx, ty)
    patched = 0
    for rec in records:
        if not rec["x"] or not rec["y"]:
            coords = flat.get(rec["location_title"])
            if coords:
                rec["x"], rec["y"] = coords
                patched += 1
    print(f"  {len(records)} locations ({patched} coords recovered from flat CSV).")
    return records, lookup


def build_characters(code):
    """Returns (PascalCase records, snake_case 'pg' records)."""
    records, pg = [], []
    for row in read_csv(CHARS_CSV, "SourceTextCode", code):
        nid = row.get("Nid", "").strip()
        records.append({
            "Nid":                nid,
            "CharacterName":      row.get("CharacterName", "").strip(),
            "Sort Name":          row.get("Sort Name", "").strip(),
            "AKA":                row.get("AKA", "").strip(),
            "Race":               row.get("Race", "").strip(),
            "Gender":             row.get("Gender", "").strip(),
            "Class":              row.get("Class", "").strip(),
            "Rank":               row.get("Rank", "").strip(),
            "RankValue":          0,
            "Vitality":           row.get("Vitality", "").strip(),
            "Family":             row.get("Family", "").strip(),
            "Occupation":         row.get("Occupation", "").strip(),
            "Home":               row.get("Home", "").strip(),
            "Biograpy":           strip_html(row.get("Biography", "")),
            "FirstAppearance":    row.get("FirstAppearence", "").strip(),
            "CauseOfDeath":       row.get("CauseOfDeath", "").strip(),
            "IndividualGroup":    row.get("IndividualGroup", "").strip(),
            "Disability":         row.get("Disability", "").strip(),
            "Ethnicity":          row.get("Ethnicity", "").strip(),
            "Narrator":           row.get("Narrator", "").strip(),
            "Ontological Status": row.get("Ontological Status", "").strip(),
            "OtherTexts":         row.get("OtherTexts", "").strip(),
            "source_text":        code,
        })
        pg.append({
            "id":                 nid,
            "name":               row.get("CharacterName", "").strip(),
            "sort_name":          row.get("Sort Name", "").strip(),
            "aka":                row.get("AKA", "").strip(),
            "race":               row.get("Race", "").strip(),
            "gender":             row.get("Gender", "").strip(),
            "class":              row.get("Class", "").strip(),
            "rank":               row.get("Rank", "").strip(),
            "vitality":           row.get("Vitality", "").strip(),
            "family":             row.get("Family", "").strip(),
            "occupation":         row.get("Occupation", "").strip(),
            "home":               row.get("Home", "").strip(),
            "biography":          strip_html(row.get("Biography", "")),
            "first_appear":       row.get("FirstAppearence", "").strip(),
            "cause_of_death":     row.get("CauseOfDeath", "").strip(),
            "date_of_birth":      row.get("DateOfBirth", "").strip(),
            "change_class":       int(float(row.get("ChangesClass", "") or 0)),
            "individual_group":   row.get("IndividualGroup", "").strip(),
            "disability":         row.get("Disability", "").strip(),
            "ethnicity":          row.get("Ethnicity", "").strip(),
            "narrator":           row.get("Narrator", "").strip(),
            "ontological_status": row.get("Ontological Status", "").strip(),
            "other_text":         row.get("OtherTexts", "").strip(),
            "source_text":        code,
        })
    print(f"  {len(records)} characters.")
    return records, pg


def build_events(code, loc_lookup):
    events = []
    for row in read_csv(EVENTS_CSV, "SourceTextCode", code):
        loc_name = row.get("Location", "").strip()
        loc_info = loc_lookup.get(loc_name, {})
        try:
            page_int = int(float(row.get("PageNumber", 0) or 0))
        except ValueError:
            page_int = 0
        events.append({
            "event_nid":            row["Nid"].strip(),
            "event_location":       loc_name,
            "page_number":          row.get("PageNumber", "").strip(),
            "page_number_int":      page_int,
            "page_end":             row.get("PageEventEnds", "").strip(),
            "order_within_page":    row.get("OrderWithinPage", "").strip(),
            "chronological":        row.get("Chronological Order", "").strip(),
            "first_words":          row.get("First 8-10 words of event", "").strip(),
            "event_date":           row.get("Date", "").strip(),
            "event_source_text":    code,
            "characters_present":   row.get("CharactersPresent", "").strip(),
            "characters_mentioned": row.get("CharactersMentioned", "").strip(),
            "summary":              strip_html(row.get("Summary", "")),
            "era":                  row.get("Era", "").strip(),
            "narrative_status":     row.get("NarrativeStatus", "").strip(),
            "x":                    loc_info.get("x") or row.get("x", "").strip(),
            "y":                    loc_info.get("y") or row.get("y", "").strip(),
        })
    # Narrative (reading) order, not story-time order.
    events.sort(key=lambda e: float(e.get("order_within_page") or 0))
    print(f"  {len(events)} events.")
    return events


def infer_character_locations(events, pg_records):
    """DY places characters at first_appear / home; fall back to first event location."""
    first_present, first_mentioned = {}, {}
    for ev in events:
        loc = ev.get("event_location", "").strip()
        if not loc:
            continue
        for cid in (c.strip() for c in ev.get("characters_present", "").split(",")):
            if cid:
                first_present.setdefault(cid, loc)
        for cid in (c.strip() for c in ev.get("characters_mentioned", "").split(",")):
            if cid:
                first_mentioned.setdefault(cid, loc)

    filled = 0
    for ch in pg_records:
        cid = str(ch["id"])
        inferred = first_present.get(cid) or first_mentioned.get(cid, "")
        if inferred:
            if not ch.get("first_appear"):
                ch["first_appear"] = inferred
                filled += 1
            if not ch.get("home"):
                ch["home"] = inferred
    print(f"  {filled} characters given an inferred first_appear.")
    return pg_records


def build_keywords(code):
    """event_keywords, keywords (counts), keyword_index (term -> nids)."""
    event_keywords = {}
    counts, by_category, index, full_label = {}, defaultdict(dict), defaultdict(list), {}

    for row in read_csv(EVENTS_CSV, "SourceTextCode", code):
        nid = row["Nid"].strip()
        per_event = {}
        for col, label in KW_COLUMNS.items():
            raw = (row.get(col) or "").strip()
            if not raw:
                continue
            pairs = []
            for chunk in raw.split("|"):
                chunk = chunk.strip()
                if not chunk:
                    continue
                # A bare term carries no subcategory, e.g. "Romantic".
                if ">" in chunk:
                    sub, _, term = chunk.partition(">")
                    sub, term = sub.strip(), term.strip()
                else:
                    sub, term = "", chunk
                if not term:
                    continue
                pairs.append([sub, term])
                counts[term] = counts.get(term, 0) + 1
                agg = KW_AGG_LABEL.get(label, label)
                by_category[agg][term] = by_category[agg].get(term, 0) + 1
                prefix = sub or KW_FULL_LABEL.get(label, label)
                full_label[term] = f"{prefix} > {term}"
                if nid not in index[term]:
                    index[term].append(nid)
            if pairs:
                per_event[label] = pairs
        if per_event:
            event_keywords[nid] = per_event

    print(f"  {len(counts)} distinct keywords across {len(event_keywords)} events.")
    return (
        event_keywords,
        {"all": counts, "by_category": dict(by_category)},
        {"index": dict(index), "full": full_label},
    )


def compute_anchors(events, full_text):
    """Character offset in the full text where each event begins.

    The search advances with the narrative; a global search would match repeated
    phrasing far earlier in a long novel.
    """
    # The CSV uses straight quotes where the texts use curly ones, so quotes and
    # apostrophes are matched loosely rather than literally.
    QUOTES = "\"'\u2018\u2019\u201c\u201d"
    GAP = r"[\s,;:.\-\u2014" + QUOTES + r"]*"
    APOS = r"['\u2019]"

    def word_pattern(word):
        word = word.strip(QUOTES + ",.;:!?()")
        if not word:
            return None
        return APOS.join(re.escape(p) for p in re.split(APOS, word))

    def find(first_words, start):
        fw = re.sub(r"\s+", " ", (first_words or "").strip())
        if not fw:
            return None
        words = [p for p in (word_pattern(w) for w in fw.split()) if p][:5]
        for n in (len(words), 3, 2):
            if n < 2 or n > len(words):
                continue
            m = re.compile(GAP.join(words[:n]), re.IGNORECASE).search(full_text, start)
            if m:
                return m.start()
        return None

    anchors, cursor, missed = [], 0, 0
    for ev in events:
        pos = find(ev.get("first_words", ""), cursor)
        if pos is None:
            missed += 1
        else:
            cursor = pos
        anchors.append(pos)
    # The first anchored event owns everything before it (title, epigraph).
    for i, p in enumerate(anchors):
        if p is not None:
            anchors[i] = 0
            break
    print(f"  {len(anchors) - missed}/{len(anchors)} events anchored in the full text.")
    return anchors


def event_spans(events, full_text, anchors):
    """(start, end) in the full text for each anchored event."""
    spans = {}
    for i, ev in enumerate(events):
        start = anchors[i]
        if start is None:
            continue
        end = next((p for p in anchors[i + 1:] if p is not None), len(full_text))
        spans[ev["event_nid"]] = (start, end)
    return spans


def build_sentences(events, full_text, anchors):
    """{nid: {paras: [...], cont: bool}} — the text each event covers."""
    para_starts, cur = set(), 0
    for m in re.finditer(r"\n\s*\n", full_text):
        para_starts.add(cur)
        cur = m.end()
    para_starts.add(cur)

    spans = event_spans(events, full_text, anchors)
    out, empty = {}, 0
    for ev in events:
        nid = ev["event_nid"]
        if nid not in spans:
            out[nid] = {"paras": [ev["summary"]] if ev["summary"] else [], "cont": False}
            empty += 1
            continue
        start, end = spans[nid]
        paras = [p.strip().replace("\n", " ")
                 for p in re.split(r"\n\s*\n", full_text[start:end]) if p.strip()]
        out[nid] = {"paras": paras, "cont": start not in para_starts}
    print(f"  {len(out) - empty} events with text, {empty} fell back to summary.")
    return out


def build_highlighted(events, full_text, section_re, anchors):
    """Wrap the full text in per-event spans, marking section headings."""
    ranges = []
    for i, ev in enumerate(events):
        start = anchors[i]
        if start is None:
            continue
        end = next((p for p in anchors[i + 1:] if p is not None), len(full_text))
        ranges.append((start, end, str(ev["event_nid"])))

    range_starts = [r[0] for r in ranges]
    range_nids = [r[2] for r in ranges]

    def nid_at(pos):
        idx = bisect.bisect_right(range_starts, pos) - 1
        return range_nids[max(0, idx)]

    boundaries_all = set(r[0] for r in ranges if r[0] > 0)

    para_spans, cur = [], 0
    for m in re.finditer(r"\n\n+", full_text):
        para_spans.append((cur, m.start()))
        cur = m.end()
    para_spans.append((cur, len(full_text)))

    section_pat = re.compile(section_re)
    parts, sections = [], []
    for p_start, p_end in para_spans:
        para_text = full_text[p_start:p_end].strip()
        if not para_text:
            continue
        if section_pat.match(para_text):
            sections.append(para_text)
            parts.append('<div class="ft-section-num">' + escape(para_text) + "</div>")
            continue
        bounds = sorted(b for b in boundaries_all if p_start < b < p_end)
        seg_starts = [p_start] + bounds
        seg_ends = bounds + [p_end]
        html = "<p>"
        for idx, (s, e) in enumerate(zip(seg_starts, seg_ends)):
            seg = full_text[s:e].replace("\n", " ")
            if idx == 0:
                seg = seg.lstrip()
            if idx == len(seg_starts) - 1:
                seg = seg.rstrip()
            html += ('<span class="ft-hl-span" data-nid="' + nid_at(s) + '">'
                     + escape(seg) + "</span>")
        parts.append(html + "</p>")

    print(f"  {len(ranges)} spans; {len(sections)} section headings: {sections}")
    return {"html": "".join(parts)}, sections


def build_transitions(code):
    rows = []
    for row in read_csv(EVENTS_CSV, "SourceTextCode", code):
        rows.append({
            "nid":        row["Nid"].strip(),
            "page":       float((row.get("PageNumber") or "0").strip() or 0),
            "order":      float((row.get("OrderWithinPage") or "0").strip() or 0),
            "chrono_raw": float((row.get("Chronological Order") or "0").strip() or 0),
        })
    for i, ev in enumerate(sorted(rows, key=lambda e: e["chrono_raw"])):
        ev["chrono"] = i + 1

    narrative = sorted(rows, key=lambda e: (e["page"], e["order"]))
    transitions = {}
    for i in range(1, len(narrative)):
        diff = narrative[i]["chrono"] - narrative[i - 1]["chrono"]
        if diff < 0:
            transitions[narrative[i]["nid"]] = "flashback"
        elif diff > 1:
            transitions[narrative[i]["nid"]] = "flashforward"
    backs = sum(1 for v in transitions.values() if v == "flashback")
    print(f"  {len(transitions)} transitions ({backs} flashbacks, "
          f"{len(transitions) - backs} flashforwards).")
    return transitions


def build_metadata(code):
    """texts, sections and editors payloads."""
    texts = []
    for row in read_csv(TEXTS_CSV, "Code", code):
        texts.append({
            "code":         code,
            "source_text":  code,
            "title":        row.get("Title", "").strip(),
            "page_start":   row.get("Page Start", "").strip(),
            "page_stop":    row.get("Page Stop", "").strip(),
            "collection":   row.get("Edit Copy Publisher", "").strip(),
            "year":         row.get("Edit Copy Publisher Date", "").strip(),
            "about":        row.get("About", "").strip(),
            "citation":     row.get("Citation", "").strip(),
            "first_publisher":      row.get("First Publisher", "").strip(),
            "first_publisher_date": row.get("First Publisher Date", "").strip(),
        })

    sections = []
    for row in read_csv(SECTIONS_CSV, "TextCode", code):
        sections.append({
            "text_code":     code,
            "display_title": row.get("DisplayTitle", "").strip(),
            "start":         row.get("Start", "").strip(),
            "stop":          row.get("Stop", "").strip(),
            "tooltip_title": row.get("Tooltip Title", "").strip(),
        })
    sections.sort(key=lambda s: float(s["start"] or 0))

    editors = []
    for row in read_csv(EDITORS_CSV, "TextCode", code):
        editors.append({
            "text_code":    code,
            "display_name": row.get("DisplayName", "").strip(),
            "sort_name":    row.get("SortName", "").strip(),
            "about":        row.get("About", "").strip(),
        })

    print(f"  {len(texts)} text record, {len(sections)} sections, {len(editors)} editors.")
    return texts, sections, editors


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main(code, out_override=None):
    cfg = TEXTS[code]
    out_dir = os.path.join(REPO, out_override or cfg["out_dir"])
    prefix = cfg["prefix"]
    os.makedirs(out_dir, exist_ok=True)

    print(f"\n=== Building {code} -> {out_override or cfg['out_dir']} ===")

    full_text = open(os.path.join(REPO, cfg["full_text"]), encoding="utf-8").read()
    paragraphs = [p.strip() for p in re.split(r"\n\s*\n", full_text) if p.strip()]
    print(f"Full text: {len(full_text):,} chars, {len(paragraphs):,} paragraphs.")

    print("Locations ...")
    locations, loc_lookup = build_locations(code)
    print("Characters ...")
    characters, characters_pg = build_characters(code)
    print("Events ...")
    events = build_events(code, loc_lookup)
    infer_character_locations(events, characters_pg)
    print("Keywords ...")
    event_keywords, keywords, keyword_index = build_keywords(code)
    print("Anchoring events in the full text ...")
    anchors = compute_anchors(events, full_text)
    print("Sentences ...")
    sentences = build_sentences(events, full_text, anchors)
    print("Highlighted text ...")
    highlighted, _ = build_highlighted(events, full_text, cfg["section_re"], anchors)
    print("Transitions ...")
    transitions = build_transitions(code)
    print("Metadata ...")
    texts, sections, editors = build_metadata(code)

    print("Writing ...")
    write_json(out_dir, prefix, "events",            {"results": events})
    write_json(out_dir, prefix, "locations",         {"results": locations})
    write_json(out_dir, prefix, "characters",        {"results": characters})
    write_json(out_dir, prefix, "characters_pg",     {"results": characters_pg})
    write_json(out_dir, prefix, "sentences",         sentences)
    write_json(out_dir, prefix, "keywords",          keywords)
    write_json(out_dir, prefix, "keyword_index",     keyword_index)
    write_json(out_dir, prefix, "event_keywords",    event_keywords)
    write_json(out_dir, prefix, "text_highlighted",  highlighted)
    write_json(out_dir, prefix, "event_transitions", transitions)
    write_json(out_dir, prefix, "texts",             {"results": texts})
    write_json(out_dir, prefix, "sections",          {"results": sections})
    write_json(out_dir, prefix, "editors",           {"results": editors})
    # Curated in Drupal, no CSV source; emit empty so the fetches still resolve.
    write_json(out_dir, prefix, "editors_assoc",     {"results": []})
    write_json(out_dir, prefix, "other_resources",   {"results": []})
    write_json(out_dir, prefix, "teaching",          {"results": []})
    write_json(out_dir, prefix, "empty",             {"results": []})

    print("\n--- Sanity check ---")
    with_sents = sum(1 for e in events if sentences.get(e["event_nid"]))
    print(f"Events with sentences: {with_sents} of {len(events)}")
    no_coords = [e["event_nid"] for e in events if not e["x"] or not e["y"]]
    print(f"Events missing coordinates: {len(no_coords)}")
    print("Done.\n")


if __name__ == "__main__":
    if len(sys.argv) not in (2, 3) or sys.argv[1] not in TEXTS:
        sys.exit(f"usage: python build_text_data.py [{'|'.join(TEXTS)}] [out_dir]")
    main(sys.argv[1], sys.argv[2] if len(sys.argv) == 3 else None)
