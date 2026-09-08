# AGENTS.md

Context for AI assistants working on this repo. Read this before exploring — most
of it was learned the expensive way.

## What this is

A local, offline mockup of [Digital Yoknapatawpha](https://faulkner.iath.virginia.edu)
(DY), a scholarly map/timeline interface for Faulkner's fiction. It adds a
**full-text reading layer** that DY does not have: the story text with events,
narrative status, temporality and keywords marked inline.

It is a **prototype for discussion**, not production. Prefer visible progress
over architectural purity.

Two texts are modelled:

| Dir | Code | Text | Events |
|---|---|---|---|
| `a_rose_for_emily_model/` | RE | "A Rose for Emily" | 35 |
| `sound_and_the_fury_model/` | SF | *The Sound and the Fury* | 464 |

## Run it

```powershell
python -m http.server 8123
```

Then open **with the text parameter**:

```
http://localhost:8123/a_rose_for_emily_model/DIGITAL%20Yoknapatawpha.html?text=RE
http://localhost:8123/sound_and_the_fury_model/DIGITAL%20Yoknapatawpha.html?text=SF
```

**The `?text=` parameter is mandatory.** Without it the legacy code takes its
homepage branch: it never requests events, so `buildEventList()` never runs,
`initPanelTabs()` never attaches, no tab is clickable, and the legacy book-shelf
overlay appears. Hours were lost to this. `file://` also fails — the data loads
use `fetch()` and need HTTP.

## Architecture

Each model directory is a **saved copy of the live DY page** plus two custom files:

- `dy-mockup.js` (~4,300 lines, one IIFE) — all custom behaviour
- `dy-mockup.css` — all custom styling
- `DIGITAL Yoknapatawpha.html` — the scraped DY page, lightly patched
- `data/<prefix>_*.json` — generated, replaces the live Sinatra API

Rendering is **Konva 1.1.1** (see gotchas) on three layers: `backgroundLayer`,
`heatLayer`, `contentLayer`. Map image space is 2640 × 1650; the canvas is
800/1000/1200 wide (S/M/L) and the layer is scaled to suit.

Three display modes: `map` (Overview), `map-text`, `fulltext`. Held in
`dyDisplayMode`, switched by `setDisplayMode()`.

### The two models are near-identical

`dy-mockup.js` and `dy-mockup.css` are **byte-identical between the two models
except one config block**:

```js
var DY_TEXT = { code, prefix, narrativePresent, sectionRe };
```

After editing SF, propagate with `python _sync.py` (copies both files to RE and
rewrites `DY_TEXT`). **Always edit SF first, then sync.** The HTML files differ
more and must be patched individually.

## Data pipeline

`build_text_data.py` generates everything from the CSVs in `dy_data/`:

```powershell
python build_text_data.py SF          # writes to the configured out_dir
python build_text_data.py RE _scratch # write elsewhere to diff against committed data
```

Adding a text = one entry in its `TEXTS` dict (full-text path, out dir, prefix,
section-heading regex).

Superseded by it, kept only for reference: `build_re_data.py`,
`build_highlighted.py`, `gen_transitions.py`. **`build_re_data.py` is stale** —
it emits an older `re_sentences.json` schema than the app reads.

Verified: regenerating RE reproduces 9 of 10 committed files byte-for-byte.
`characters_pg` differs only in fields the mockup never reads.

### Non-obvious pipeline facts

- **Sentences are derived from full-text anchors**, not from
  `all_events_sentences.csv`. Schema is `{nid: {paras: [...], cont: bool}}`;
  `cont` marks an event starting mid-paragraph.
- **Anchor search advances through the text.** A global search matches repeated
  phrasing far too early in a novel.
- **Quotes must be matched loosely.** The CSVs use straight quotes where the
  texts use curly. This alone accounted for 57 unanchored SF events.
- Keyword columns are `kw_*` in `events.csv`, formatted `Sub > Term | Sub > Term`.
  A bare term with no `>` means an empty subcategory — do not drop it.
- The same category is rendered three different ways across the JSON files
  (`Themes and Motifs` / `Themes & Motifs` / `Themes And Motifs`). Kept explicit
  in `KW_COLUMNS` / `KW_AGG_LABEL` / `KW_FULL_LABEL`.

## Gotchas that cost real time

**Konva 1.1.1, not 9.x.** `scale` is a compound `{x, y}` attribute:
`node.setScale(1.3)` with a bare number is **silently ignored**. Use
`setScaleX()` / `setScaleY()`. Legacy code calls `setScale(1)` in several places,
which has never done anything. Scale is also relative to each node's own pixel
size — measure it, don't assume.

**`layoutPanels()` owns all panel geometry.** Position/size for the controls
panel, toolbar, fulltext panel, info panel, aggregation panel and title bar is
computed there from the map rect, driven by `DY_LAYOUT` constants. Do not add
positioning CSS for those; it will be overwritten or will fight the JS.

**CSS specificity traps.** `#ft-layout #ft-highlight-view { height: 0 !important }`
(two IDs) beats `#ft-highlight-view { height: auto !important }` (one ID).
`#ft-layout` is `position: fixed; overflow: hidden`. Do not try to out-specify
this for printing — see below.

**Printing moves the DOM.** `_moveToPrintDoc()` relocates the header, text and
appendix into a plain `#ft-print-doc` on `<body>`, prints, then restores them.
It **moves rather than clones** so element IDs survive and the injected
annotation styles still match. Fighting the layout with print CSS does not work.

**Injected annotation styles only rebuild while their layer is active.** Turning
a layer on for printing and off afterwards leaves stale rules in `#ft-ns-style` /
`#ft-temp-style`; they must be cleared explicitly.

**The HTML is a scraped page.** It carries live-site artifacts: `#shelf_instructions`
(homepage blurb, hidden with `!important` because legacy JS calls `.show()`), a
hard-coded section bar, RE-specific Drupal node links, and hundreds of inert
`?text=RE` hrefs. Assume anything odd in the HTML is an artifact, not a design.

**Legacy globals** are real and required: `current_characters`, `current_locations`,
`show_characters()`, `show_characters_home()`, `contentLayer`, `stage`. They
populate asynchronously — code that needs them must run off the
`show_characters` hook or retry.

## Data quirks

- **Most characters have no `Home`** (27 of 31 in RE). This is why the old Home
  view piled everyone on the town centre, and why the Overview default is now
  Demographics.
- SF contains an event dated **year `0`**, which stretched the year axis until
  the pre-1890 bucket absorbed it.
- Ranks are only `Major` / `Secondary` / `Minor` / `Peripheral`. There is **no
  `Mentioned` rank** — mentioned-only status must be derived by comparing
  `characters_present` against `characters_mentioned`.
- `sf_editors_assoc`, `sf_other_resources`, `sf_teaching` are **empty**: curated
  in Drupal with no CSV source. The UI shows "Data not reconciled yet".
- `editors.csv` has no role column, so all 6 SF editors appear as primary.

## Verifying changes

```powershell
node --check "sound_and_the_fury_model/dy-mockup.js"
```

Use `get_errors` for CSS. Some pre-existing CSS warnings are expected.

The user tests manually and has asked that browser automation **not** be used.
State clearly what to check and what a failure would indicate.

## Working style the user prefers

- Batch related changes into one pass; they watch token cost closely.
- Explain *why* something broke, not just what changed.
- Flag data problems found along the way — several turned out to matter more
  than the UI bug being chased.
- Don't over-verify when they will check themselves.

## Current state

Complete: panel layout, SF as a second text, print-to-PDF with options dialog
and appendices, demographic overview.

Open items: SF's Characters appendix is 178 entries (may want trimming); the
demographic grid is dense for SF; `build_re_data.py` and friends could be
deleted once `build_text_data.py` is trusted.

See `SESSION_LOG_2026_05_02.md` for an earlier session's notes.
