"""
build_re_data.py  v3
Generates four JSON files to replace the live Sinatra API calls for the
A Rose for Emily local mockup:

  data/re_events.json     -> replaces /sinatra/?text=RE
  data/re_locations.json  -> replaces /sinatra/drupal_locations?code=RE
  data/re_characters.json -> replaces /sinatra/characters?text=RE
  data/re_sentences.json  -> maps nid -> list of sentences for the full-text panel

Sources (preferred, normalized):
  dy_data/events.csv      one row per event; CharactersPresent/Mentioned already CSV
  dy_data/locations.csv   has True X/True Y, Display Label, Type, Description, etc.
  dy_data/characters.csv  full character data

Sentence sources:
  all_events_sentences.csv                       R-matched sentences (29 of 35 RE events)
  full_text/faulkner_roseforemily_1930_RE.txt    plain text fallback for 6 missing events
"""

import csv
import json
import os
import re
from html.parser import HTMLParser
from collections import defaultdict

REPO          = os.path.dirname(os.path.abspath(__file__))
EVENTS_CSV    = os.path.join(REPO, "dy_data", "events.csv")
LOCATIONS_CSV = os.path.join(REPO, "dy_data", "locations.csv")
CHARS_CSV     = os.path.join(REPO, "dy_data", "characters.csv")
SENTENCES_CSV = os.path.join(REPO, "all_events_sentences.csv")
FULL_TEXT     = os.path.join(REPO, "full_text", "faulkner_roseforemily_1930_RE.txt")
FLAT_CSV      = os.path.join(REPO, "dy_database_flattened_2024_1_21_recovered.csv")
OUT_DIR       = os.path.join(REPO, "a_rose_for_emily_model", "data")
os.makedirs(OUT_DIR, exist_ok=True)


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
    """Lower-case, collapse whitespace, strip curly quotes for matching."""
    text = strip_html(text)
    text = text.replace("\u2018", "'").replace("\u2019", "'")
    text = text.replace("\u201c", '"').replace("\u201d", '"')
    return re.sub(r"\s+", " ", text).strip().lower()


# ---------------------------------------------------------------------------
# 1. Load locations (keyed by LocationTitle for join with events)
# ---------------------------------------------------------------------------
print("Reading locations ...")
loc_lookup  = {}
loc_records = []

with open(LOCATIONS_CSV, encoding="utf-8-sig") as f:
    for row in csv.DictReader(f):
        if row.get("SourceTextCode", "").strip() != "RE":
            continue
        title = row["LocationTitle"].strip()
        rec = {
            "location_title":  title,
            "display_label":   row.get("Display Label", title).strip() or title,
            "source_text":     "RE",
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
        loc_lookup[title] = rec
        loc_records.append(rec)

print(f"  {len(loc_records)} RE locations.")

# Patch missing x/y coordinates from the flat CSV (True_X / True_Y columns).
# dy_data/locations.csv has these columns but they are empty for RE.
flat_coords = {}
with open(FLAT_CSV, encoding="utf-8-sig") as f:
    for row in csv.DictReader(f):
        lt = row.get("LocationTitle", "").strip()
        if lt and lt not in flat_coords:
            tx = row.get("True_X", "").strip()
            ty = row.get("True_Y", "").strip()
            if tx and ty:
                flat_coords[lt] = (tx, ty)
for rec in loc_records:
    if not rec["x"] or not rec["y"]:
        coords = flat_coords.get(rec["location_title"])
        if coords:
            rec["x"], rec["y"] = coords
            loc_lookup[rec["location_title"]]["x"] = coords[0]
            loc_lookup[rec["location_title"]]["y"] = coords[1]

# ---------------------------------------------------------------------------
# 2. Load characters (keyed by Nid)
# ---------------------------------------------------------------------------
print("Reading characters ...")
char_lookup  = {}
char_records = []

with open(CHARS_CSV, encoding="utf-8-sig") as f:
    for row in csv.DictReader(f):
        if row.get("SourceTextCode", "").strip() != "RE":
            continue
        nid = row.get("Nid", "").strip()
        rec = {
            "Nid":               nid,
            "CharacterName":     row.get("CharacterName", "").strip(),
            "Sort Name":         row.get("Sort Name", "").strip(),
            "AKA":               row.get("AKA", "").strip(),
            "Race":              row.get("Race", "").strip(),
            "Gender":            row.get("Gender", "").strip(),
            "Class":             row.get("Class", "").strip(),
            "Rank":              row.get("Rank", "").strip(),
            "RankValue":         0,
            "Vitality":          row.get("Vitality", "").strip(),
            "Family":            row.get("Family", "").strip(),
            "Occupation":        row.get("Occupation", "").strip(),
            "Home":              row.get("Home", "").strip(),
            "Biograpy":          strip_html(row.get("Biography", "")),
            "FirstAppearance":   row.get("FirstAppearence", "").strip(),
            "CauseOfDeath":      row.get("CauseOfDeath", "").strip(),
            "IndividualGroup":   row.get("IndividualGroup", "").strip(),
            "Disability":        row.get("Disability", "").strip(),
            "Ethnicity":         row.get("Ethnicity", "").strip(),
            "Narrator":          row.get("Narrator", "").strip(),
            "Ontological Status": row.get("Ontological Status", "").strip(),
            "OtherTexts":        row.get("OtherTexts", "").strip(),
            "source_text":       "RE",
        }
        char_lookup[nid] = rec
        char_records.append(rec)

print(f"  {len(char_records)} RE characters.")

# ---------------------------------------------------------------------------
# 3. Build events from normalized events.csv (one row per event)
# ---------------------------------------------------------------------------
print("Reading events ...")
re_events = []

with open(EVENTS_CSV, encoding="utf-8-sig") as f:
    for row in csv.DictReader(f):
        if row.get("SourceTextCode", "").strip() != "RE":
            continue

        nid      = row["Nid"].strip()
        loc_name = row.get("Location", "").strip()
        loc_info = loc_lookup.get(loc_name, {})

        x = loc_info.get("x") or row.get("x", "").strip()
        y = loc_info.get("y") or row.get("y", "").strip()

        try:
            page_int = int(float(row.get("PageNumber", 0) or 0))
        except ValueError:
            page_int = 0

        re_events.append({
            "event_nid":            nid,
            "event_location":       loc_name,
            "page_number":          row.get("PageNumber", "").strip(),
            "page_number_int":      page_int,
            "page_end":             row.get("PageEventEnds", "").strip(),
            "order_within_page":    row.get("OrderWithinPage", "").strip(),
            "chronological":        row.get("Chronological Order", "").strip(),
            "first_words":          row.get("First 8-10 words of event", "").strip(),
            "event_date":           row.get("Date", "").strip(),
            "event_source_text":    "RE",
            "characters_present":   row.get("CharactersPresent", "").strip(),
            "characters_mentioned": row.get("CharactersMentioned", "").strip(),
            "summary":              strip_html(row.get("Summary", "")),
            "era":                  row.get("Era", "").strip(),
            "narrative_status":     row.get("NarrativeStatus", "").strip(),
            "x":                    x,
            "y":                    y,
        })

# Sort by OrderWithinPage (reading/narrative order, e.g. 119.01, 119.02 ...)
# Chronological Order is story-time order, not reading order.
re_events.sort(key=lambda e: float(e.get("order_within_page") or 0))

print(f"  {len(re_events)} RE events.")

with open(os.path.join(OUT_DIR, "re_events.json"), "w", encoding="utf-8") as f:
    json.dump({"results": re_events}, f, indent=2, ensure_ascii=False)
print("  -> data/re_events.json written.")

with open(os.path.join(OUT_DIR, "re_locations.json"), "w", encoding="utf-8") as f:
    json.dump({"results": loc_records}, f, indent=2, ensure_ascii=False)
print("  -> data/re_locations.json written.")

with open(os.path.join(OUT_DIR, "re_characters.json"), "w", encoding="utf-8") as f:
    json.dump({"results": char_records}, f, indent=2, ensure_ascii=False)
print("  -> data/re_characters.json written.")

# ---------------------------------------------------------------------------
# 4. Sentences: R-matched first, full-text search for the 6 missing events
# ---------------------------------------------------------------------------
print("Reading sentences ...")
nid_sentences = defaultdict(list)

with open(SENTENCES_CSV, encoding="utf-8-sig") as f:
    for row in csv.DictReader(f):
        if row.get("code", "").strip() != "RE":
            continue
        nid  = str(row.get("nid", "")).strip()
        sent = row.get("sentences", "").strip()
        if nid and sent:
            nid_sentences[nid].append(sent)

print(f"  {len(nid_sentences)} RE nids matched from all_events_sentences.csv.")

# Load full text as paragraphs (blank-line separated)
full_text_raw = open(FULL_TEXT, encoding="utf-8").read()
paragraphs = [p.strip() for p in re.split(r"\n\s*\n", full_text_raw) if p.strip()]

def find_paragraphs_for(first_words):
    needle = normalise(first_words)
    if not needle:
        return []
    for length in (len(needle), len(needle) * 3 // 4, len(needle) // 2, 30):
        prefix = needle[:length].strip()
        if not prefix:
            continue
        for para in paragraphs:
            if prefix in normalise(para):
                return [para]
    return []

print("Searching full text for missing events ...")
missing = set(e["event_nid"] for e in re_events) - set(nid_sentences.keys())
for ev in re_events:
    nid = ev["event_nid"]
    if nid not in missing:
        continue
    hits = find_paragraphs_for(ev["first_words"])
    if hits:
        nid_sentences[nid] = hits
        print(f"  Found nid {nid}: {hits[0][:80]}...")
    else:
        nid_sentences[nid] = [ev["summary"]] if ev["summary"] else []
        print(f"  nid {nid}: no text match; using summary.")

with open(os.path.join(OUT_DIR, "re_sentences.json"), "w", encoding="utf-8") as f:
    json.dump(dict(nid_sentences), f, indent=2, ensure_ascii=False)
print("  -> data/re_sentences.json written.")

# ---------------------------------------------------------------------------
# 5. Sanity check
# ---------------------------------------------------------------------------
print("\n--- Sanity check ---")
all_nids   = set(e["event_nid"] for e in re_events)
with_sents = set(nid for nid, s in nid_sentences.items() if s)
print(f"Events with sentences: {len(with_sents)} of {len(re_events)}")
still_empty = all_nids - with_sents
if still_empty:
    print(f"Still empty: {sorted(still_empty)}")

for ev in re_events:
    sents = nid_sentences.get(ev["event_nid"], [])
    if sents:
        print(f"\nSample nid {ev['event_nid']}: {ev['first_words'][:60]}")
        print(f"  -> {sents[0][:120]}...")
        break
print("\nDone.")
