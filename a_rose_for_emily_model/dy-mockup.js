(function () {
	// ── Data lookups ─────────────────────────────────────────────
	var reSentences     = {};
	var reTextHighlighted = null;
	var reEventsMap  = {};
	var reEventsList = [];
	var charById     = {};
	var locByTitle   = {};
	var reKeywords      = {};  // { all: {term:n}, by_category: {label:{term:n}} }
	var reKeywordIndex  = {};  // { index: {label:[nids]}, full: {label:'Cat > label'} }
	var reEventKeywords = {};  // { nid: { 'Actions': [['SubCat','Term'],...], ... } }
	var reEventTransitions = {};  // { nid: 'flashback' | 'flashforward' }

	// ── State ─────────────────────────────────────────────────────
	var currentEv       = null;
	var currentLocation = null;
	var dataReady       = false;
	var eventsReady     = false;

	// ── Text configuration ────────────────────────────────────────
	// The only per-text differences; the rest of this file is shared verbatim
	// with the other text models.
	var DY_TEXT = {
		code:             'RE',
		prefix:           're_',
		narrativePresent: 1924,  // stored in Drupal upstream
		// Matches the .ft-section-num text emitted by build_text_data.py
		sectionRe:        /^[IVXivx]+\$/
	};

	// ── Load supporting data ──────────────────────────────────────
	function _dataUrl(name) { return 'data/' + DY_TEXT.prefix + name + '.json'; }

	Promise.all([
		fetch(_dataUrl('sentences')).then(function(r) { return r.json(); }),
		fetch(_dataUrl('events')).then(function(r) { return r.json(); }),
		fetch(_dataUrl('characters_pg')).then(function(r) { return r.json(); }),
		fetch(_dataUrl('locations')).then(function(r) { return r.json(); }),
		fetch(_dataUrl('keywords')).then(function(r) { return r.json(); }),
		fetch(_dataUrl('text_highlighted')).then(function(r) { return r.json(); }),
		fetch(_dataUrl('keyword_index')).then(function(r) { return r.json(); }),
		fetch(_dataUrl('event_keywords')).then(function(r) { return r.json(); }),
		fetch(_dataUrl('event_transitions')).then(function(r) { return r.json(); })
	]).then(function(results) {
		reSentences      = results[0];
		reEventsList     = results[1].results || [];
		reEventsList.forEach(function(ev) { reEventsMap[String(ev.event_nid)] = ev; });
		// Store full char object so we can test rank (Major/Secondary/etc)
		(results[2].results || []).forEach(function(ch) { charById[String(ch.id)] = ch; });
		(results[3].results || []).forEach(function(loc) { locByTitle[loc.location_title] = loc; });
		reKeywords            = results[4] || {};
		reTextHighlighted     = results[5] || null;
		reKeywordIndex        = results[6] || {};
		reEventKeywords       = results[7] || {};
		reEventTransitions    = results[8] || {};
		// Pre-compute the theoretical final ceiling: max events per year assuming
		// each event is visited exactly once. This fixes the colour scale so yellow
		// only appears at the very end of a full playthrough, not on the first frame.
		(function() {
			var finalYearCounts = {};
			reEventsList.forEach(function(ev) {
				if (!ev.event_date) return;
				var ym = ev.event_date.match(/^(\d{4})/);
				if (!ym) return;
				var yr = parseInt(ym[1]);
				finalYearCounts[yr] = (finalYearCounts[yr] || 0) + 1;
			});
			var maxFinal = 1;
			Object.keys(finalYearCounts).forEach(function(yr) {
				if (finalYearCounts[yr] > maxFinal) maxFinal = finalYearCounts[yr];
			});
			dyHeatCeiling = maxFinal;
		})();
		dataReady = true;
		buildAggCharacters();
		buildAggLocations();
		buildAggEvents();
		buildAggKeywords();
		buildAggNetworks();
		if (eventsReady) buildEventList();
	}).catch(function(err) { console.warn('DY full-text: data load error', err); });

	// ── Characters aggregation ─────────────────────────────────────────────

	// Derive the Legend PNG filename matching the map's own icon logic
	function charIconUrl(ch) {
		var gender = ch.gender || '';
		var race   = ch.race   || 'White';
		// Multi Gender Group → mixed-gender icon by race
		if (gender === 'Multi Gender Group') {
			if (race === 'Black' || race === 'Free Black') return './group_icons_MixedGender_B_icon-sm-sq.png';
			if (race === 'Indian')                         return './group_icons_MixedGender_R_icon-sm-sq.png';
			return './group_icons_MixedGender_W_icon-sm-sq.png';
		}
		// Race → letter code
		var rc;
		if      (race === 'Black' || race === 'Free Black') rc = 'B';
		else if (race === 'Indian')                         rc = 'R';
		else if (race === 'Asian')                          rc = 'A';
		else                                                rc = 'W';
		var gp = (gender === 'Female') ? 'F' : 'M';
		return './DIGITAL Yoknapatawpha_files/Legend' + gp + rc + rc + '.png';
	}

	// Build a readable "Race · Class · Gender" label from a character
	function typeLabel(ch) {
		return [ch.race || '', ch['class'] || '', ch.gender || '']
			.filter(Boolean).join(' \u00b7 ');
	}
	// Same label from the stored key (race+class+gender pipe-joined internally)
	function typeLabelFromKey(key) { return key.replace(/\|/g, ' \u00b7 '); }
	// Build a type key from a character (using | separator for storage)
	function typeKey(ch) {
		return [ch.race || '', ch['class'] || '', ch.gender || ''].filter(Boolean).join('|');
	}

	function buildAggCharacters() {
		var panel = document.getElementById('agg-characters');
		if (!panel) return;

		// Separate by rank
		var major = [], secondary = [];
		var allChars = Object.keys(charById).map(function(k) { return charById[k]; });
		allChars.forEach(function(ch) {
			if      (ch.rank === 'Major')     major.push(ch);
			else if (ch.rank === 'Secondary') secondary.push(ch);
		});
		var byName = function(a, b) { return (a.sort_name || a.name).localeCompare(b.sort_name || b.name); };
		major.sort(byName); secondary.sort(byName);

		// Count present / mentioned per character across all events
		var presentCount = {}, mentionedCount = {};
		reEventsList.forEach(function(ev) {
			if (ev.characters_present) {
				ev.characters_present.split(',').forEach(function(id) {
					id = id.trim();
					if (id) presentCount[id] = (presentCount[id] || 0) + 1;
				});
			}
			if (ev.characters_mentioned) {
				ev.characters_mentioned.split(',').forEach(function(id) {
					id = id.trim();
					if (id) mentionedCount[id] = (mentionedCount[id] || 0) + 1;
				});
			}
		});

		// Top 3 by individual presence
		var topPresent = Object.keys(presentCount)
			.filter(function(id) { return charById[id]; })
			.sort(function(a, b) { return presentCount[b] - presentCount[a]; })
			.slice(0, 3)
			.map(function(id) { return { ch: charById[id], n: presentCount[id] }; });

		// Top 3 by individual mention
		var topMentioned = Object.keys(mentionedCount)
			.filter(function(id) { return charById[id]; })
			.sort(function(a, b) { return mentionedCount[b] - mentionedCount[a]; })
			.slice(0, 3)
			.map(function(id) { return { ch: charById[id], n: mentionedCount[id] }; });

		// Weighted type totals: sum presence/mention counts for all chars of each type
		var typePresentTotals = {}, typeMentionTotals = {};
		allChars.forEach(function(ch) {
			var k = typeKey(ch);
			if (!k) return;
			var pid = String(ch.id);
			typePresentTotals[k]  = (typePresentTotals[k]  || 0) + (presentCount[pid]  || 0);
			typeMentionTotals[k]  = (typeMentionTotals[k]  || 0) + (mentionedCount[pid] || 0);
		});
		var topTypesByPresence = Object.keys(typePresentTotals)
			.filter(function(k) { return typePresentTotals[k] > 0; })
			.sort(function(a, b) { return typePresentTotals[b] - typePresentTotals[a]; })
			.slice(0, 3)
			.map(function(k) { return { label: typeLabelFromKey(k), n: typePresentTotals[k] }; });
		var topTypesByMention = Object.keys(typeMentionTotals)
			.filter(function(k) { return typeMentionTotals[k] > 0; })
			.sort(function(a, b) { return typeMentionTotals[b] - typeMentionTotals[a]; })
			.slice(0, 3)
			.map(function(k) { return { label: typeLabelFromKey(k), n: typeMentionTotals[k] }; });

		// Render helpers
		function charItem(ch) {
			return '<div class="agg-char-item">'
				+ '<img class="agg-char-icon" src="' + charIconUrl(ch) + '" alt="" title="' + (ch.race||'') + ' ' + (ch.gender||'') + '">'
				+ '<span class="agg-char-name" title="' + (ch.name || '') + '">' + (ch.name || '') + '</span>'
				+ '</div>';
		}
		function charItemCount(ch, count) {
			return '<div class="agg-char-item">'
				+ '<img class="agg-char-icon" src="' + charIconUrl(ch) + '" alt="" title="' + (ch.race||'') + ' ' + (ch.gender||'') + '">'
				+ '<span class="agg-char-name" title="' + (ch.name || '') + '">' + (ch.name || '') + '</span>'
				+ '<span class="agg-char-count">' + count + '&times;</span>'
				+ '</div>';
		}

		// Col 1: Major
		var c1 = '<div class="agg-col"><div class="agg-col-head">Major</div>';
		major.forEach(function(ch) { c1 += charItem(ch); });
		c1 += '</div>';

		// Col 2: Secondary
		var c2 = '<div class="agg-col"><div class="agg-col-head">Secondary</div>';
		secondary.forEach(function(ch) { c2 += charItem(ch); });
		c2 += '</div>';

		// Col 3: Most Frequent Present
		var c3 = '<div class="agg-col"><div class="agg-col-head">Most Present</div>';
		topPresent.forEach(function(item) { c3 += charItemCount(item.ch, item.n); });
		c3 += '</div>';

		// Col 4: Most Mentioned
		var c4 = '<div class="agg-col"><div class="agg-col-head">Most Mentioned</div>';
		topMentioned.forEach(function(item) { c4 += charItemCount(item.ch, item.n); });
		c4 += '</div>';

		// Col 5: Most Present by Type (weighted by event count)
		var c5 = '<div class="agg-col"><div class="agg-col-head">Most Present by Type</div>';
		topTypesByPresence.forEach(function(item) {
			c5 += '<div class="agg-type-item">' + item.label
				+ ' <span class="agg-type-count">' + item.n + '&times;</span></div>';
		});
		c5 += '</div>';

		// Col 6: Most Mentioned by Type (weighted by event count)
		var c6 = '<div class="agg-col"><div class="agg-col-head">Most Mentioned by Type</div>';
		topTypesByMention.forEach(function(item) {
			c6 += '<div class="agg-type-item">' + item.label
				+ ' <span class="agg-type-count">' + item.n + '&times;</span></div>';
		});
		c6 += '</div>';

		panel.innerHTML = c1 + c2 + c3 + c4 + c5 + c6;
	}

	// ── Locations aggregation ─────────────────────────────────────────────

	function locIconUrl(locType) {
		var map = {
			'Cemetery':            'LegendCemetery.png',
			'House':               'LegendHouse.png',
			'Mansion':             'LegendMansion.png',
			'Office/store':        'LegendOffice_Store.png',
			'Public building':     'LegendPublicBuilding.png',
			'Cabin':               'LegendCabin.png',
			'Church':              'LegendChurch.png',
			'Farm':                'LegendFarm.png',
			'Other structure':     'LegendOtherStructure.png',
			'Statue':              'LegendStatue.png',
			'OutOfYoknapatawpha':  'OutOfYok.png'
		};
		var file = map[locType] || 'LegendEvent.png';
		return './DIGITAL Yoknapatawpha_files/' + file;
	}

	function buildAggLocations() {
		var panel = document.getElementById('agg-locations');
		if (!panel) return;

		// Count events per location title (events that occur there)
		var eventCountByTitle = {};
		reEventsList.forEach(function(ev) {
			var t = (ev.event_location || '').trim();
			if (t) eventCountByTitle[t] = (eventCountByTitle[t] || 0) + 1;
		});

		// Top 3 locations by event count
		var topByEvents = Object.keys(eventCountByTitle)
			.sort(function(a, b) { return eventCountByTitle[b] - eventCountByTitle[a]; })
			.slice(0, 3)
			.map(function(t) { return { title: t, n: eventCountByTitle[t], loc: locByTitle[t] || {} }; });

		// Locations only mentioned (not site of any event)
		var mentionedLocs = Object.keys(locByTitle)
			.map(function(t) { return locByTitle[t]; })
			.filter(function(l) { return l.role === 'Only Mentioned in Text'; })
			.sort(function(a, b) { return (a.location_title || '').localeCompare(b.location_title || ''); })
			.slice(0, 3);

		// Top 3 location types by total event count
		var typeEventCounts = {};
		reEventsList.forEach(function(ev) {
			var t = (ev.event_location || '').trim();
			var loc = locByTitle[t];
			if (loc && loc.location_type) {
				var lt = loc.location_type;
				typeEventCounts[lt] = (typeEventCounts[lt] || 0) + 1;
			}
		});
		var topTypes = Object.keys(typeEventCounts)
			.sort(function(a, b) { return typeEventCounts[b] - typeEventCounts[a]; })
			.slice(0, 3)
			.map(function(lt) { return { type: lt, n: typeEventCounts[lt] }; });

		function locItem(title, loc, count) {
			var lt = (loc && loc.location_type) || '';
			var html = '<div class="agg-char-item">'
				+ '<img class="agg-char-icon" src="' + locIconUrl(lt) + '" alt="" title="' + lt + '">'
				+ '<span class="agg-char-name" title="' + title + '">' + title + '</span>';
			if (count !== undefined) {
				html += '<span class="agg-char-count">' + count + '&times;</span>';
			}
			html += '</div>';
			return html;
		}

		var c1 = '<div class="agg-col"><div class="agg-col-head">Most Events</div>';
		topByEvents.forEach(function(item) { c1 += locItem(item.title, item.loc, item.n); });
		c1 += '</div>';

		var c2 = '<div class="agg-col"><div class="agg-col-head">Only Mentioned</div>';
		if (mentionedLocs.length) {
			mentionedLocs.forEach(function(loc) { c2 += locItem(loc.location_title, loc, undefined); });
		} else {
			c2 += '<div class="agg-type-item" style="color:#bbb">None</div>';
		}
		c2 += '</div>';

		var c3 = '<div class="agg-col"><div class="agg-col-head">By Type</div>';
		topTypes.forEach(function(item) {
			c3 += '<div class="agg-char-item">'
				+ '<img class="agg-char-icon" src="' + locIconUrl(item.type) + '" alt="" title="' + item.type + '">'
				+ '<span class="agg-char-name">' + item.type + '</span>'
				+ '<span class="agg-char-count">' + item.n + '&times;</span>'
				+ '</div>';
		});
		c3 += '</div>';

		panel.innerHTML = c1 + c2 + c3;
	}

	// ── Events aggregation ───────────────────────────────────────────────

	// Faulkner chart palette (from faulkner-chart-styles.js)
	var DY_COLORWAY = ['#1E3A66','#E5721A','#C81B1B','#64A664','#2F635D','#5DA8C4','#863B69','#3A7828','#C4BA0D'];
	var DY_FONT     = { family: "Georgia, 'Times New Roman', Times, serif", size: 11, color: '#363636' };

	function buildAggEvents() {
		var panel = document.getElementById('agg-events');
		if (!panel) return;

		// Extract start year from "YYYY-MM-DD to YYYY-MM-DD" format
		function evtYear(ev) {
			var m = (ev.event_date || '').match(/^(\d{4})/);
			return m ? parseInt(m[1]) : null;
		}

		// Sort by narrative page order
		var ordered = reEventsList.slice().sort(function(a, b) {
			return parseFloat(a.order_within_page || 0) - parseFloat(b.order_within_page || 0);
		});

		// Year stats
		var years = reEventsList.map(evtYear).filter(Boolean);
		var minYear = Math.min.apply(null, years);
		var maxYear = Math.max.apply(null, years);

		// Most frequent year
		var yearCounts = {};
		years.forEach(function(y) { yearCounts[y] = (yearCounts[y] || 0) + 1; });
		var topYear = Object.keys(yearCounts).sort(function(a, b) {
			return yearCounts[b] - yearCounts[a];
		})[0];

		// Most frequent era
		var eraCounts = {};
		reEventsList.forEach(function(ev) {
			var e = (ev.era || '').trim();
			if (e) eraCounts[e] = (eraCounts[e] || 0) + 1;
		});
		var topEra = Object.keys(eraCounts).sort(function(a, b) {
			return eraCounts[b] - eraCounts[a];
		})[0];

		// Time jumps: compare start year of consecutive narrative events
		var fwd = 0, bwd = 0, lin = 0;
		for (var i = 1; i < ordered.length; i++) {
			var prev = evtYear(ordered[i - 1]);
			var curr = evtYear(ordered[i]);
			if (prev === null || curr === null) continue;
			if      (curr > prev) fwd++;
			else if (curr < prev) bwd++;
			else                  lin++;
		}
		var totalMoves = fwd + bwd + lin;

		// Narrative status counts
		var nsCounts = {};
		reEventsList.forEach(function(ev) {
			var ns = (ev.narrative_status || 'Unknown').trim();
			nsCounts[ns] = (nsCounts[ns] || 0) + 1;
		});
		var nsSlices = Object.keys(nsCounts).map(function(ns) {
			return { label: ns, value: nsCounts[ns] };
		}).sort(function(a, b) { return b.value - a.value; });
		var nsTotal = reEventsList.length;

		// ── Col 1: Timespan ──
		var c1 = '<div class="agg-col"><div class="agg-col-head">Timespan</div>'
			+ '<div class="agg-type-item"><span style="color:#888;font-size:10px">EARLIEST &nbsp;</span>' + minYear + '</div>'
			+ '<div class="agg-type-item"><span style="color:#888;font-size:10px">LATEST &nbsp;&nbsp;&nbsp;</span>' + maxYear + '</div>'
			+ '<div class="agg-type-item" style="margin-top:4px"><span style="color:#888;font-size:10px">SPAN &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;</span>' + (maxYear - minYear) + ' years</div>'
			+ '</div>';

		// ── Col 2: Frequency ──
		var c2 = '<div class="agg-col"><div class="agg-col-head">Most Frequent</div>'
			+ '<div class="agg-type-item"><span style="color:#888;font-size:10px">YEAR &nbsp;</span>'
			+ topYear + ' <span class="agg-type-count">' + yearCounts[topYear] + '&times;</span></div>';
		if (topEra) {
			c2 += '<div class="agg-type-item" style="margin-top:4px"><span style="color:#888;font-size:10px">ERA</span></div>'
				+ '<div class="agg-type-item" style="padding-left:2px">' + topEra
				+ ' <span class="agg-type-count">' + eraCounts[topEra] + '&times;</span></div>';
		}
		c2 += '</div>';

		// ── Col 3: Temporal Movement ──
		var barHtml = '<div style="display:flex;height:7px;border-radius:3px;overflow:hidden;margin:6px 0 8px;max-width:120px">';
		if (fwd) barHtml += '<div style="flex:' + fwd + ';background:#4a6fa5" title="Forward: ' + fwd + '"></div>';
		if (lin) barHtml += '<div style="flex:' + lin + ';background:#ccc" title="Linear: ' + lin + '"></div>';
		if (bwd) barHtml += '<div style="flex:' + bwd + ';background:#c0604a" title="Backward: ' + bwd + '"></div>';
		barHtml += '</div>';
		var c3 = '<div class="agg-col"><div class="agg-col-head">Temporal Movement</div>'
			+ barHtml
			+ '<div class="agg-type-item"><span style="display:inline-block;width:8px;height:8px;background:#4a6fa5;margin-right:5px;vertical-align:middle"></span>Forward &nbsp;<span class="agg-type-count">' + fwd + '</span></div>'
			+ '<div class="agg-type-item"><span style="display:inline-block;width:8px;height:8px;background:#ccc;margin-right:5px;vertical-align:middle"></span>Linear &nbsp;<span class="agg-type-count">' + lin + '</span></div>'
			+ '<div class="agg-type-item"><span style="display:inline-block;width:8px;height:8px;background:#c0604a;margin-right:5px;vertical-align:middle"></span>Backward <span class="agg-type-count">' + bwd + '</span></div>'
			+ '</div>';

		// ── Col 4: Narrative Status pie (Plotly) ──
		var c4 = '<div class="agg-col"><div class="agg-col-head">Narrative Status</div>'
			+ '<div id="agg-events-pie" style="width:100%;height:100px"></div>';
		nsSlices.forEach(function(sl, idx) {
			var color = DY_COLORWAY[idx % DY_COLORWAY.length];
			var pct = Math.round(sl.value / nsTotal * 100);
			c4 += '<div class="agg-type-item">'
				+ '<span style="display:inline-block;width:8px;height:8px;background:' + color + ';margin-right:5px;vertical-align:middle"></span>'
				+ sl.label + ' <span class="agg-type-count">' + sl.value + ' (' + pct + '%)</span></div>';
		});
		c4 += '</div>';

		panel.innerHTML = c1 + c2 + c3 + c4;

		// Store pie data for deferred render (chart needs visible container)
		panel._pieData = nsSlices;
	}

	// ── Keywords aggregation ─────────────────────────────────────────────

	function buildAggKeywords() {
		var panel = document.getElementById('agg-keywords');
		if (!panel) return;

		var all = reKeywords.all || {};
		var byCat = reKeywords.by_category || {};

		// ── 7 column grid: top-3 overall + top-3 per category ──
		function topN(obj, n) {
			return Object.keys(obj)
				.sort(function(a, b) { return obj[b] - obj[a]; })
				.slice(0, n)
				.map(function(t) { return { term: t, n: obj[t] }; });
		}
		function colHtml(heading, items) {
			var h = '<div class="agg-col"><div class="agg-col-head">' + heading + '</div>';
			items.forEach(function(item) {
				h += '<div class="agg-type-item"><span class="agg-type-label">' + item.term
					+ '</span><span class="agg-type-count">' + item.n + '&times;</span></div>';
			});
			return h + '</div>';
		}

		var catOrder = ['Actions','Aesthetics','Cultural Issues','Environment','Relationships','Themes and Motifs'];
		var colsHtml = '<div class="agg-kw-cols">';
		colsHtml += colHtml('Top Terms', topN(all, 3));
		catOrder.forEach(function(cat) {
			var catData = byCat[cat] || {};
			colsHtml += colHtml(cat, topN(catData, 3));
		});
		colsHtml += '</div>';

		panel.innerHTML = colsHtml;
	}

	// ── Networks aggregation ──────────────────────────────────────────────
	function buildAggNetworks() {
		var panel = document.getElementById('agg-networks');
		if (!panel) return;

		// Helper: parse characters_present CSV → array of char objects
		function presentChars(ev) {
			if (!ev.characters_present) return [];
			return ev.characters_present.split(',').map(function(s) { return charById[s.trim()]; }).filter(Boolean);
		}

		// ── Binary presence counts: race / gender / class ─────────────
		var raceCounts = {}, genderCounts = {}, classCounts = {};
		reEventsList.forEach(function(ev) {
			var chars = presentChars(ev);
			if (!chars.length) return;
			var seenRace = {}, seenGender = {}, seenClass = {};
			chars.forEach(function(ch) {
				if (ch.race)            seenRace[ch.race] = true;
				if (ch.gender)          seenGender[ch.gender] = true;
				if (ch['class'])        seenClass[ch['class']] = true;
			});
			Object.keys(seenRace).forEach(function(r)   { raceCounts[r]   = (raceCounts[r]   || 0) + 1; });
			Object.keys(seenGender).forEach(function(g) { genderCounts[g] = (genderCounts[g] || 0) + 1; });
			Object.keys(seenClass).forEach(function(c)  { classCounts[c]  = (classCounts[c]  || 0) + 1; });
		});

		// Sort by count desc
		function sortedSlices(counts) {
			return Object.keys(counts)
				.map(function(k) { return { label: k, value: counts[k] }; })
				.sort(function(a, b) { return b.value - a.value; });
		}
		var raceSlices   = sortedSlices(raceCounts);
		var genderSlices = sortedSlices(genderCounts);
		var classSlices  = sortedSlices(classCounts);

		// Helper: build one column with a Plotly pie + legend rows
		function pieColHtml(heading, divId, slices) {
			var total = slices.reduce(function(s, x) { return s + x.value; }, 0);
			var h = '<div class="agg-col"><div class="agg-col-head">' + heading + '</div>'
				+ '<div id="' + divId + '" style="width:100%;height:80px"></div>';
			slices.forEach(function(sl, idx) {
				var color = DY_COLORWAY[idx % DY_COLORWAY.length];
				var pct   = Math.round(sl.value / total * 100);
				h += '<div class="agg-type-item">'
					+ '<span style="display:inline-block;width:7px;height:7px;background:' + color + ';margin-right:4px;flex-shrink:0;vertical-align:middle"></span>'
					+ '<span class="agg-type-label">' + sl.label + '</span>'
					+ '<span class="agg-type-count">' + pct + '%</span></div>';
			});
			return h + '</div>';
		}

		// ── Co-occurrence counts ───────────────────────────────────────
		// Pair key: alphabetically sorted names, joined by '\n'
		var pairCounts     = {};  // 'Name A\nName B' → count
		var typePairCounts = {};  // 'TypeA\nTypeB'  → count (full Race·Class·Gender key)

		reEventsList.forEach(function(ev) {
			var chars = presentChars(ev);
			if (chars.length < 2) return;
			for (var i = 0; i < chars.length; i++) {
				for (var j = i + 1; j < chars.length; j++) {
					var a = chars[i], b = chars[j];

					// Individual pair — store as tab-separated sorted names
					var names = [a.name, b.name].sort();
					var pkey  = names[0] + '\t' + names[1];
					pairCounts[pkey] = (pairCounts[pkey] || 0) + 1;

					// Type pair using full Race·Class·Gender key
					var ta = typeKey(a), tb = typeKey(b);
					var tnames = [ta, tb].sort();
					var tkey   = tnames[0] + '\t' + tnames[1];
					typePairCounts[tkey] = (typePairCounts[tkey] || 0) + 1;
				}
			}
		});

		function top3(obj) {
			return Object.keys(obj)
				.sort(function(a, b) { return obj[b] - obj[a]; })
				.slice(0, 3)
				.map(function(k) { return { key: k, value: obj[k] }; });
		}

		// Rarest pairs: type pairs with count === 1, sorted alphabetically, top 3
		var rarestPairs = Object.keys(typePairCounts)
			.filter(function(k) { return typePairCounts[k] === 1; })
			.sort()
			.slice(0, 3)
			.map(function(k) { return { key: k, value: 1 }; });

		// Column builder for stacked-name pairs
		function pairColHtml(heading, items, formatKey, formatVal) {
			var h = '<div class="agg-col"><div class="agg-col-head">' + heading + '</div>';
			items.forEach(function(item) {
				var parts  = item.key.split('\t');
				var nameA  = formatKey ? formatKey(parts[0]) : parts[0];
				var nameB  = formatKey ? formatKey(parts[1]) : parts[1];
				var valStr = formatVal ? formatVal(item.value) : item.value + '&times;';
				h += '<div style="display:flex;align-items:center;gap:4px;padding:3px 0;border-bottom:1px solid #e8e5e0;">'
					+ '<div style="flex:1;min-width:0;">'
					+ '<div class="agg-type-label" style="line-height:1.4;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">' + nameA + '</div>'
					+ '<div class="agg-type-label" style="line-height:1.4;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">' + nameB + '</div>'
					+ '</div>'
					+ '<span class="agg-type-count" style="flex-shrink:0;">' + valStr + '</span>'
					+ '</div>';
			});
			return h + '</div>';
		}

		panel.innerHTML =
			pieColHtml('Race Presence', 'net-race-pie', raceSlices) +
			pieColHtml('Gender Presence', 'net-gender-pie', genderSlices) +
			pieColHtml('Class Presence', 'net-class-pie', classSlices) +
			pairColHtml('Top Pairs', top3(pairCounts), null, null) +
			pairColHtml('Top Type Pairs', top3(typePairCounts), typeLabelFromKey, null) +
			pairColHtml('Rarest Pairs', rarestPairs, typeLabelFromKey, function() { return '1&times;'; });

		// Store pie data for deferred render
		panel._netPies = [
			{ id: 'net-race-pie',   slices: raceSlices },
			{ id: 'net-gender-pie', slices: genderSlices },
			{ id: 'net-class-pie',  slices: classSlices }
		];
	}

	// ── Helpers ───────────────────────────────────────────────────
	function esc(str) {
		return String(str || '')
			.replace(/&/g, '&amp;').replace(/</g, '&lt;')
			.replace(/>/g, '&gt;').replace(/"/g, '&quot;');
	}
	function splitSentences(text) {
		var parts = text.match(/[^.!?]+[.!?]+(\s|$)|[^.!?]+$/g);
		return parts ? parts.map(function(s) { return s.trim(); }).filter(Boolean) : [text];
	}
	function idsToNames(csvIds) {
		if (!csvIds) return [];
		return csvIds.split(',').map(function(s) { return s.trim(); }).filter(Boolean)
			.map(function(id) { return charById[id] ? charById[id].name : null; }).filter(Boolean);
	}
	function idsToChars(csvIds) {
		if (!csvIds) return [];
		return csvIds.split(',').map(function(s) { return s.trim(); }).filter(Boolean)
			.map(function(id) { return charById[id] || null; }).filter(Boolean);
	}

	// ── Build scrollable event list ───────────────────────────────
	function buildEventList() {
		var eventsView = document.getElementById('ft-events-view');
		var panel = eventsView || document.getElementById('fulltext-panel');
		if (!panel || !reEventsList.length) return;
		var html = '<div class="ft-list">';
		reEventsList.forEach(function(ev) {
			var nid   = esc(String(ev.event_nid));
			var _rs    = reSentences[String(ev.event_nid)] || {};
			var sents  = _rs.paras || [];
			html += '<div class="ft-item" data-nid="' + nid + '">';
			html += '<div class="ft-item-bar">';
			html += '<span class="ft-item-page">p.' + esc(String(ev.page_number)) + '</span>';
			html += '<span class="ft-item-loc">' + esc(ev.event_location) + '</span>';
			html += '<span class="ft-item-fw">' + esc(ev.first_words || ev.summary || '') + '</span>';
			html += '</div>';
			html += '<div class="ft-item-body">';
			if (sents.length) {
				sents.forEach(function(block) {
					html += '<p class="ft-sentence">' + esc(block) + '</p>';
				});
			} else if (ev.summary) {
				html += '<p class="ft-summary">' + esc(ev.summary) + '</p>';
			}

			html += '</div>';
			html += '</div>';
		});
		html += '</div>';
		panel.innerHTML = html;
		// Activate first item
		var first = reEventsList[0];
		activateItem(String(first.event_nid), true);
		updateInfoPanel(first, first.event_location);
		currentEv = first; currentLocation = first.event_location;
		buildToolbar();
		updateToolbarState(first);
		initPanelTabs();
		initInfoCollapse();
		initFpCollapse();
		initAggPanelCollapse();
	}

	// ── Activate an event item ────────────────────────────────────
	function activateItem(nid, open, fromScroll) {
		// Events list view
		var evView = document.getElementById('ft-events-view');
		var panel = evView || document.getElementById('fulltext-panel');
		if (panel) {
			panel.querySelectorAll('.ft-item.active').forEach(function(el) { el.classList.remove('active'); });
			var item = panel.querySelector('.ft-item[data-nid="' + nid + '"]');
			if (item) {
				item.classList.add('active');
				if (open && !item.classList.contains('open')) {
					panel.querySelectorAll('.ft-item.open').forEach(function(el) { el.classList.remove('open'); });
					item.classList.add('open');
				}
				item.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
			}
		}
		// Highlighted text view — past full opacity, active highlighted, future dimmed (not in fulltext mode)
		var hlCont = document.getElementById('ft-highlight-view');
		if (hlCont && hlCont.children.length) {
			var _passedHl = false;
			var _ftModeHl = (dyDisplayMode === 'fulltext');
			var _noDim    = (dyDisplayMode !== 'map');
			hlCont.querySelectorAll('.ft-hl-span[data-nid]').forEach(function(s) {
				if (s.dataset.nid === String(nid)) {
					_passedHl = true;
					if (!_ftModeHl) s.classList.add('ft-hl-active');
					s.classList.remove('ft-hl-future');
				} else if (!_passedHl) {
					s.classList.remove('ft-hl-active', 'ft-hl-future');
				} else {
					s.classList.remove('ft-hl-active');
					if (!_noDim) s.classList.add('ft-hl-future');
					else s.classList.remove('ft-hl-future');
				}
			});
			var activeSpan = hlCont.querySelector('.ft-hl-span.ft-hl-active');
			if (activeSpan) scrollToEl(hlCont, activeSpan);
		}
	}

	// ── Info panel ───────────────────────────────────────────────
	function updateInfoPanel(ev, location) {
		var locData = locByTitle[location] || {};
		var locIcon = locData.location_type
			? '<img src="' + locIconUrl(locData.location_type) + '" alt="" style="height:13px;width:auto;vertical-align:middle;margin-right:5px;">'
			: '';
		var locHtml = '<strong style="display:flex;align-items:center;">' + locIcon + esc(location);
		if (locData.location_type === 'OutOfYoknapatawpha') {
			locHtml += '<span class="loc-out-of-yok-badge">Outside Yoknapatawpha</span>';
		}
		locHtml += '</strong>';
		if (locData.description) locHtml += '<p>' + esc(locData.description) + '</p>';
		if (locData.location_type && locData.location_type !== 'OutOfYoknapatawpha') {
			locHtml += '<p><em>' + esc(locData.location_type.replace(/([A-Z])/g, ' $1').trim()) + '</em></p>';
		}
		var locEl = document.getElementById('it-location');
		if (locEl) locEl.innerHTML = locHtml;

		var present   = idsToChars(ev.characters_present);
		var mentioned = idsToChars(ev.characters_mentioned);
		var mentOnly  = mentioned.filter(function(c) { return !present.some(function(p) { return p.id === c.id; }); });
		var charHtml  = '';
		function charLi(c) {
			var icon = '<img class="agg-char-icon" src="' + charIconUrl(c) + '" alt="" style="height:13px;width:auto;vertical-align:middle;margin-right:4px;">';
			return '<li style="display:flex;align-items:center;gap:0;">' + icon + esc(c.name) + '</li>';
		}
		if (present.length) {
			charHtml += '<div class="info-char-group"><strong>Present</strong><ul>';
			present.forEach(function(c) { charHtml += charLi(c); });
			charHtml += '</ul></div>';
		}
		if (mentOnly.length) {
			charHtml += '<div class="info-char-group info-mentioned"><strong>Mentioned</strong><ul>';
			mentOnly.forEach(function(c) { charHtml += charLi(c); });
			charHtml += '</ul></div>';
		}
		var charEl = document.getElementById('it-character');
		if (charEl) charEl.innerHTML = charHtml || '<p class="info-empty">No characters recorded</p>';

		var evHtml = '';
		if (ev.first_words)      evHtml += '<p><em>' + esc(ev.first_words) + '</em></p>';
		if (ev.summary)          evHtml += '<p>' + esc(ev.summary) + '</p>';
		if (ev.event_date)       evHtml += '<p><strong>Date:</strong> ' + esc(ev.event_date) + '</p>';
		if (ev.narrative_status) evHtml += '<p><strong>Narrative status:</strong> ' + esc(ev.narrative_status) + '</p>';
		var evEl = document.getElementById('it-event');
		if (evEl) evEl.innerHTML = evHtml || '<p class="info-empty">No event data available</p>';

		// Keywords tab
		var kwEl = document.getElementById('it-keywords');
		if (kwEl) {
			var nid = String(ev.event_nid);
			var kwData = reEventKeywords[nid];
			var colOrder = ['Actions','Aesthetics','Cultural Issues','Environment','Relationships','Themes and Motifs'];
			var kwHtml = '';
			if (kwData) {
				function _kwCount(term) {
					var idx = reKeywordIndex && reKeywordIndex.index && reKeywordIndex.index[term];
					return idx ? ' <span class="ft-kw-count">(' + idx.length + ')</span>' : '';
				}
				colOrder.forEach(function(col) {
					if (!kwData[col] || !kwData[col].length) return;
					var sortedPairs = kwData[col].slice().sort(function(a, b) {
						return (a[1] || '').localeCompare(b[1] || '');
					});
					kwHtml += '<div class="ft-kw-group">';
					kwHtml += '<div class="ft-kw-col-label">' + esc(col) + '</div>';
					kwHtml += '<div class="ft-kw-terms">';
					sortedPairs.forEach(function(pair) {
						var t = pair[1];
						kwHtml += '<span class="ft-kw-term" data-term="' + esc(t) + '">' + esc(t) + _kwCount(t) + '</span>';
					});
					kwHtml += '</div></div>';
				});
			}
			kwEl.innerHTML = kwHtml || '<p class="info-empty">No keywords recorded</p>';
		}
		var ip = document.getElementById('info-panel');
		if (ip && dyDisplayMode !== 'map' && dyDisplayMode !== 'fulltext') ip.style.display = 'block';
	}

	// ── Konva overlay nodes (labels + callout lines) ─────────────
	var dyKonvaOverlays = [];
	function clearKonvaOverlays() {
		dyKonvaOverlays.forEach(function(n) { n.destroy(); });
		dyKonvaOverlays = [];
	}

	// ── Map character assembly ────────────────────────────────────
	function updateMapCharacters(ev, location) {
		if (typeof current_characters === 'undefined' || typeof contentLayer === 'undefined') return;
		clearKonvaOverlays();

		// Determine the rank filter.
		// In map-text mode: use rank toggle buttons. In overview: use radio selection.
		var isPlaying = (dyPlayTimer !== null);

		// Build set of active ranks from checkboxes (map-text mode)
		var activeRanks = null;
		if (dyDisplayMode === 'map-text') {
			activeRanks = {};
			var rankMap = { 'dy-rank-major': 'Major', 'dy-rank-secondary': 'Secondary',
				'dy-rank-minor': 'Minor', 'dy-rank-peripheral': 'Peripheral', 'dy-rank-mentioned': 'Mentioned' };
			Object.keys(rankMap).forEach(function(id) {
				var el = document.getElementById(id);
				if (el && el.checked) activeRanks[rankMap[id]] = true;
			});
		}

		var charRadio = (function() {
			var radios = ['characters-all','characters-major','characters-major-regular','characters-home','characters-none'];
			for (var i = 0; i < radios.length; i++) {
				var el = document.getElementById(radios[i]);
				if (el && el.checked) return radios[i];
			}
			return 'characters-all';
		})();
		// "Home" during animation collapses to "All"
		var effectiveRadio = (isPlaying && charRadio === 'characters-home') ? 'characters-all' : charRadio;

		function rankAllowed(rank) {
			if (activeRanks !== null) {
				// "Mentioned" button controls characters that are mentioned-only (handled separately by mentOnly array)
				// All other buttons map directly to rank strings
				return !!(activeRanks[rank] || (!rank && activeRanks['Minor']));
			}
			if (effectiveRadio === 'characters-none')         return false;
			if (effectiveRadio === 'characters-all')          return true;
			if (effectiveRadio === 'characters-home')         return true;
			if (effectiveRadio === 'characters-major')        return rank === 'Major';
			if (effectiveRadio === 'characters-major-regular') return rank === 'Major' || rank === 'Secondary';
			return true;
		}

		// Hide all characters
		$.each(current_characters, function(name, ch) {
			if (ch && ch.image) { ch.image.hide(); ch.image.setOpacity(1); }
		});

		// Dim all locations; active one at full opacity
		if (typeof current_locations !== 'undefined') {
			$.each(current_locations, function(title, img) {
				if (img && typeof img.setOpacity === 'function') {
					img.setOpacity(title === location ? 1 : 0.35);
					if (typeof img.show === 'function') img.show();
				}
			});
		}

		var locObj = (typeof current_locations !== 'undefined') ? current_locations[location] : null;
		if (!locObj || typeof locObj === 'string') { contentLayer.draw(); return; }
		var locX = locObj.getX(), locY = locObj.getY();

		var present   = idsToNames(ev.characters_present);
		var mentioned = idsToNames(ev.characters_mentioned);
		var mentOnly  = mentioned.filter(function(n) { return present.indexOf(n) < 0; });
		var sz = 60, gap = 6;
		var charLblEl = document.getElementById('dy-labels-toggle') || document.getElementById('dy-labels-toggle-ov');
		var showCharLabels = charLblEl ? charLblEl.checked : true;
		var locLblEl = document.getElementById('dy-loc-labels-toggle');
		var showLocLabel = locLblEl ? locLblEl.checked : showCharLabels;

		// Look up rank by character name
		function rankOf(name) {
			var found = '';
			Object.keys(charById).some(function(id) {
				if (charById[id] && charById[id].name === name) { found = charById[id].rank; return true; }
			});
			return found;
		}

		// Add a tooltip-style label (rounded rect + bold text) on the Konva contentLayer
		// Canvas is rendered at 0.305 scale, so font sizes need to be ~3.3× screen size.
		function addLabel(text, x, y, opts) {
			var PAD = 14;
			var FS  = 52;  // ~16px on screen at 0.305 canvas scale
			// Measure text first
			var tmp = new Konva.Text({
				text: text,
				fontSize: FS,
				fontFamily: 'Calibri, Tahoma, sans-serif',
				fontStyle: 'bold',
				padding: PAD
			});
			var tw = tmp.width(), th = tmp.height();
			tmp.destroy();
			var bx = x - tw / 2;
			var bg = new Konva.Rect({
				x: bx, y: y, width: tw, height: th,
				fill: opts.bgFill || '#ddd',
				stroke: opts.boxStroke || '#555',
				strokeWidth: 3,
				cornerRadius: 16,
				shadowColor: 'black',
				shadowBlur: 18,
				shadowOpacity: 0.3
			});
			var lbl = new Konva.Text({
				x: bx, y: y, text: text,
				width: tw,
				fontSize: FS,
				fontFamily: 'Calibri, Tahoma, sans-serif',
				fontStyle: 'bold',
				fill: opts.fill || '#000',
				padding: PAD,
				align: 'center'
			});
			contentLayer.add(bg);
			contentLayer.add(lbl);
			bg.moveToTop(); lbl.moveToTop();
			dyKonvaOverlays.push(bg);
			dyKonvaOverlays.push(lbl);
		}

		// Add a dashed callout hairline from (cx, cy) to location marker
		function addCallout(cx, cy) {
			var line = new Konva.Line({
				points: [cx, cy, locX, locY],
				stroke: 'rgba(255,255,255,0.5)',
				strokeWidth: 1,
				dash: [4, 3]
			});
			contentLayer.add(line);
			dyKonvaOverlays.push(line);
		}

		// Label height in canvas units: font 52 + top/bottom padding 14 each = 80
		var LABEL_H = 52 + 14 * 2;
		var LABEL_GAP = 12;   // gap between stacked labels
		var LABEL_STEP = LABEL_H + LABEL_GAP;

		var presentCy = locY - 145;
		var mentCy    = locY - 80;

		// Collect labellable names for each group first, then render as a vertical stack
		var presentNames = [], mentNames = [];

		present.forEach(function(name, i) {
			var ch = current_characters[name]; if (!ch || !ch.image) return;
			if (!rankAllowed(rankOf(name))) return;
			var cx = locX - (present.length * (sz + gap) - gap) / 2 + i * (sz + gap);
			ch.image.setX(cx); ch.image.setY(presentCy);
			ch.image.setScale(1); ch.image.setOpacity(1); ch.image.moveToTop(); ch.image.show();
			if (showCharLabels) {
				addCallout(cx + sz / 2, presentCy + sz);
				var rank = rankOf(name);
				if (rank === 'Major' || rank === 'Secondary') presentNames.push(name);
			}
		});
		mentOnly.forEach(function(name, i) {
			var ch = current_characters[name]; if (!ch || !ch.image) return;
			// In map-text mode, the Mentioned toggle controls whether mentioned-only chars appear
			if (activeRanks !== null && !activeRanks['Mentioned']) return;
			if (activeRanks === null && !rankAllowed(rankOf(name))) return;
			var cx = locX - (mentOnly.length * (sz + gap) - gap) / 2 + i * (sz + gap);
			ch.image.setX(cx); ch.image.setY(mentCy);
			ch.image.setScale(1); ch.image.setOpacity(0.5); ch.image.moveToTop(); ch.image.show();
			if (showCharLabels) {
				addCallout(cx + sz / 2, mentCy + sz);
				var rank = rankOf(name);
				if (rank === 'Major') mentNames.push(name);
			}
		});

		// Render present-group label stack — placed to the LEFT of the character group,
		// with a hairline from each label's right edge to the character.
		if (showCharLabels && presentNames.length) {
			// Left edge of character group
			var pGroupLeft = locX - (present.length * (sz + gap) - gap) / 2;
			var labelRightX = pGroupLeft - 60;  // 60 canvas units gap from characters
			var stackTop = presentCy + sz / 2 - (presentNames.length * LABEL_STEP) / 2;
			presentNames.forEach(function(name, i) {
				var ly = stackTop + i * LABEL_STEP;
				// Estimate label half-width for right-edge calculation
				var hw = name.length * 15 + 28;
				var lx = labelRightX - hw;  // centre x so right edge = labelRightX
				// Hairline from label right-centre to centre of the character sprite
				var charIdx = i < present.length ? i : 0;
				var charCx = locX - (present.length * (sz + gap) - gap) / 2 + charIdx * (sz + gap) + sz / 2;
				var hairline = new Konva.Line({
					points: [labelRightX, ly + LABEL_H / 2, charCx, presentCy + sz / 2],
					stroke: 'rgba(80,80,80,0.5)', strokeWidth: 1.5, dash: [6, 4]
				});
				contentLayer.add(hairline); dyKonvaOverlays.push(hairline);
				addLabel(name, lx, ly, { fill: '#000', bgFill: '#ddd', boxStroke: '#555' });
			});
		}

		// Render ment-group label stack to the RIGHT of the character group
		if (showCharLabels && mentNames.length) {
			var mGroupRight = locX + (mentOnly.length * (sz + gap) - gap) / 2 + sz;
			var mLabelLeftX = mGroupRight + 60;
			var mStackTop = mentCy + sz / 2 - (mentNames.length * LABEL_STEP) / 2;
			mentNames.forEach(function(name, i) {
				var ly = mStackTop + i * LABEL_STEP;
				var charIdx = i < mentOnly.length ? i : 0;
				var charCx = locX - (mentOnly.length * (sz + gap) - gap) / 2 + charIdx * (sz + gap) + sz / 2;
				var hairline = new Konva.Line({
					points: [mLabelLeftX, ly + LABEL_H / 2, charCx, mentCy + sz / 2],
					stroke: 'rgba(80,80,80,0.5)', strokeWidth: 1.5, dash: [6, 4]
				});
				contentLayer.add(hairline); dyKonvaOverlays.push(hairline);
				addLabel(name, mLabelLeftX, ly, { fill: '#444', bgFill: '#ccc', boxStroke: '#888' });
			});
		}

		// Active location label — adaptive placement near the marker.
		// Tries SE first, then other directions, always staying within the visible
		// screen area and clear of the 192px-wide controls panel on the left.
		if (showLocLabel) {
			var locData = locByTitle[location];
			var locLabel = (locData && locData.location_title) || location;
			if (locLabel) {
				// Point callout to centre of the location icon
				var locCX = locX + (locObj.width  ? locObj.width()  / 2 : 30);
				var locCY = locY + (locObj.height ? locObj.height() / 2 : 30);

				// Measure label dimensions (mirrors addLabel internals)
				var _PAD = 14, _FS = 52;
				var _tmp = new Konva.Text({ text: locLabel, fontSize: _FS,
					fontFamily: 'Calibri, Tahoma, sans-serif', fontStyle: 'bold', padding: _PAD });
				var _lw = _tmp.width(), _lh = _tmp.height();
				_tmp.destroy();
				var _hw = _lw / 2;

				// Convert safe screen bounds into canvas coords using current layer transform
				var _sc = contentLayer.scaleX() || 0.305;
				var _ox = contentLayer.x()      || 0;
				var _oy = contentLayer.y()      || 0;
				var _xMin = (192 - _ox) / _sc + _hw;   // clear of controls panel
				var _xMax = (800 - _ox) / _sc - _hw;   // clear of right screen edge
				var _yMin = (0   - _oy) / _sc;          // clear of top
				var _yMax = (500 - _oy) / _sc - _lh;   // clear of bottom

				// Candidates ordered by preference: SE first, then radiate outward
				var _D = 380;
				var _cands = [
					[ _D,       _D      ],
					[ _D * 1.4, _D * 0.6],
					[ _D * 0.6, _D * 1.4],
					[ _D,       _D * 1.8],
					[ _D * 1.8, _D      ],
					[-_D,       _D      ],   // SW fallback
					[ _D,      -_D      ],   // NE fallback
					[-_D,      -_D      ],   // NW fallback
				];
				var _aX = null, _aY = null;
				for (var _ci = 0; _ci < _cands.length; _ci++) {
					var _cx = locX + _cands[_ci][0];
					var _cy = locY + _cands[_ci][1];
					if (_cx >= _xMin && _cx <= _xMax && _cy >= _yMin && _cy <= _yMax) {
						_aX = _cx; _aY = _cy; break;
					}
				}
				// Hard fallback: nudge SE and clamp to safe zone
				if (_aX === null) {
					_aX = Math.max(_xMin, Math.min(_xMax, locX + _D));
					_aY = Math.max(_yMin, Math.min(_yMax, locY + _D));
				}

				var calloutLine = new Konva.Line({
					points: [_aX, _aY + _lh / 2, locCX, locCY],
					stroke: '#c8a000', strokeWidth: 3, dash: [12, 8]
				});
				contentLayer.add(calloutLine);
				calloutLine.moveToTop();
				dyKonvaOverlays.push(calloutLine);
				addLabel(locLabel, _aX, _aY,
					{ fill: '#5a3a00', bgFill: '#ffe066', boxStroke: '#c8a000' });
			}
		}

		contentLayer.draw();
	}

	// ── Own play/nav helpers (bypass broken DY dialog calls) ──────
	var dyEvListChron = null;
	var dyPlayTimer   = null;
	var dyVisitedNids = {};   // legacy; kept for compat
	var dyHeatCounts     = {};   // nid → visit count for temporal heatmap
	var dyHeatCeiling    = 1;    // running max — only ever grows, never shrinks
	var dyLocHeatCounts  = {};   // location title → visit count for spatial heatmap

	// ── Spatial heatmap ───────────────────────────────────────────
	// Draws translucent radial-gradient blobs on heatLayer, one per visited
	// location. Intensity scales with visit count relative to the ceiling.
	// The layer uses the same transform as contentLayer so coordinates match.
	function drawSpatialHeatmap() {
		heatLayer.destroyChildren();
		var tog = document.getElementById('dy-spatial-heatmap-toggle');
		if (!tog || !tog.checked) { heatLayer.draw(); return; }

		// Sync transform with contentLayer so pixel coords line up
		heatLayer.x(contentLayer.x());
		heatLayer.y(contentLayer.y());
		heatLayer.scaleX(contentLayer.scaleX());
		heatLayer.scaleY(contentLayer.scaleY());

		var RADIUS = 48;   // canvas units — slightly larger than the 20px location icon
		Object.keys(dyLocHeatCounts).forEach(function(title) {
			var locObj = (typeof current_locations !== 'undefined') && current_locations[title];
			if (!locObj || typeof locObj.getX !== 'function') return;
			var cx = locObj.getX() + (locObj.width  ? locObj.width()  / 2 : 10);
			var cy = locObj.getY() + (locObj.height ? locObj.height() / 2 : 10);
			// t goes 0 → 1 over first 9 hits
			var t = Math.min((dyLocHeatCounts[title] - 1) / 9, 1);

			// Single gradient: hot plasma colour at centre → dark purple at r=0.9 → transparent at r=1
			var STEPS = 8;
			var gradStops = [];
			for (var si = 0; si <= STEPS; si++) {
				var r = (si / STEPS) * 0.9;
				var tAtR = t * (1 - r / 0.9);
				gradStops.push(r, 'rgba(' + _heatRgb(tAtR) + ',0.80)');
			}
			gradStops.push(1, 'rgba(0,0,0,0)');

			var blob = new Konva.Circle({
				x: cx, y: cy,
				radius: RADIUS,
				fillRadialGradientStartPoint: { x: 0, y: 0 },
				fillRadialGradientStartRadius: 0,
				fillRadialGradientEndPoint: { x: 0, y: 0 },
				fillRadialGradientEndRadius: RADIUS,
				fillRadialGradientColorStops: gradStops,
				listening: false
			});
			heatLayer.add(blob);
		});
		heatLayer.draw();
	}
	function _heatRgb(t) {
		// Plasma stops: dark violet → purple → magenta → orange → yellow
		var stops = [
			[35, 7, 90], [95, 24, 127], [152, 45, 128], [211, 67, 110], [248, 118, 92], [254, 187, 129], [252, 232, 50]
		];
		var n = stops.length - 1;
		var i = Math.min(Math.floor(t * n), n - 1);
		var f = t * n - i;
		var a = stops[i], b = stops[i + 1];
		var r = Math.round(a[0] + f * (b[0] - a[0]));
		var g = Math.round(a[1] + f * (b[1] - a[1]));
		var bv= Math.round(a[2] + f * (b[2] - a[2]));
		return r + ',' + g + ',' + bv;
	}
	var dyYearMin = 1850, dyYearMax = 1924; // set by buildDateTicks

	// ── Year axis ─────────────────────────────────────────────────
	// Texts like The Sound and the Fury have a handful of very early events that
	// would otherwise stretch the axis and crowd everything into the right edge.
	// When that early region is sparse it collapses into one short segment,
	// marked with a break glyph; otherwise the axis stays strictly linear.
	var DY_YEAR = {
		cutoff:       1890,
		segmentShare: 0.125, // width of the collapsed segment, as a share of one interval
		maxPreShare:  0.10,  // collapse only if fewer than this share of events precede the cutoff
		targetLabels: 8,
		niceSteps:    [5, 10, 20, 25, 50]
	};
	var _yrAxis = { start: 1890, end: 1930, step: 10, preFrac: 0, preLo: 1890, hasPre: false };

	function buildYearAxis(years) {
		var preYears = years.filter(function(y) { return y < DY_YEAR.cutoff; });
		var hasPre = preYears.length > 0 &&
		             years.length > 0 &&
		             (preYears.length / years.length) < DY_YEAR.maxPreShare;

		var dataLo = hasPre ? DY_YEAR.cutoff : dyYearMin;
		var raw = Math.max(1, dyYearMax - dataLo) / (DY_YEAR.targetLabels - 1);
		var step = DY_YEAR.niceSteps.reduce(function(best, s) {
			return Math.abs(s - raw) < Math.abs(best - raw) ? s : best;
		}, DY_YEAR.niceSteps[0]);

		var lo = Math.floor(dataLo / step) * step;
		var hi = Math.ceil((dyYearMax + 1) / step) * step;
		if (hi <= lo) hi = lo + step;
		var intervals = (hi - lo) / step;
		_yrAxis = {
			start:   lo,
			end:     hi,
			step:    step,
			hasPre:  hasPre,
			preLo:   preYears.length ? Math.min.apply(null, preYears) : lo,
			preFrac: hasPre ? DY_YEAR.segmentShare / (DY_YEAR.segmentShare + intervals) : 0
		};
	}

	// Year → 0..1 position along the axis.
	function yearFrac(yr) {
		var a = _yrAxis;
		if (a.hasPre && yr < DY_YEAR.cutoff) {
			var span = (DY_YEAR.cutoff - a.preLo) || 1;
			var t = (yr - a.preLo) / span;
			return Math.min(Math.max(t, 0), 1) * a.preFrac;
		}
		var u = (yr - a.start) / (a.end - a.start);
		return a.preFrac + Math.min(Math.max(u, 0), 1) * (1 - a.preFrac);
	}

	function fracToYear(f) {
		var a = _yrAxis;
		if (a.hasPre && f <= a.preFrac) {
			var t = a.preFrac ? f / a.preFrac : 0;
			return a.preLo + t * (DY_YEAR.cutoff - a.preLo);
		}
		var u = (f - a.preFrac) / (1 - a.preFrac);
		return a.start + u * (a.end - a.start);
	}
	var _sliderEvPositions = []; // float positions parallel to getDyList(); rebuilt by buildSliderTicks
	var dyActiveSection = null; // { yearMin, yearMax } or null when no section selected

	// Plasma colormap (6 stops: dark-purple → purple → magenta → orange → yellow)
	function plasmaColor(t) {
		var s = [
			[95,24,127],[152,45,128],[211,67,110],[248,118,92],[254,187,129],[252,253,191]
		];
		var n = s.length - 1;
		var i = Math.min(Math.floor(t * n), n - 1);
		var f = t * n - i;
		var a = s[i], b = s[i+1];
		return [
			Math.round(a[0]+f*(b[0]-a[0])),
			Math.round(a[1]+f*(b[1]-a[1])),
			Math.round(a[2]+f*(b[2]-a[2]))
		];
	}

	function dyDrawHeatmap(activeEv) {
		var canvas = document.getElementById('dy-heat-canvas');
		if (!canvas) return;
		var W = canvas.offsetWidth || 760;
		var H = canvas.height || 28;
		if (canvas.width !== W) canvas.width = W;
		var ctx = canvas.getContext('2d');

		// Grey background so plasma glow reads without being too dark
		ctx.clearRect(0, 0, W, H);
		ctx.fillStyle = '#d0d0d0';
		ctx.fillRect(0, 0, W, H);

		function xFor(yr) { return yearFrac(yr) * W; }

		// ── Aggregate dyHeatCounts (keyed by nid) into yearCounts ──
		// All events at the same calendar year pool their heat together.
		var yearCounts = {};
		Object.keys(dyHeatCounts).forEach(function(nid) {
			var ev = reEventsMap[nid];
			if (!ev || !ev.event_date) return;
			var ym = ev.event_date.match(/^(\d{4})/); if (!ym) return;
			var yr = parseInt(ym[1]);
			yearCounts[yr] = (yearCounts[yr] || 0) + dyHeatCounts[nid];
		});

		// Normalize against the pre-computed final ceiling so the colour scale is
		// fixed from the start. Yellow is only reached when the hottest year has
		// accumulated all its events — i.e., at the very end of a full playthrough.
		var ceiling = dyHeatCeiling; // set once at data load, never changes here

		// sqrt expansion keeps early visits visible on the cool end of the scale
		function countToT(count) {
			return Math.sqrt(Math.min(count, ceiling) / ceiling);
		}

		// Sort cool-first so hot blobs render on top
		var entries = Object.keys(yearCounts).map(function(yr) {
			return { yr: parseInt(yr), count: yearCounts[yr] };
		}).sort(function(a, b) { return a.count - b.count; });

		var blobR = H / 2; // blobs fill full bar height

		entries.forEach(function(e) {
			var x  = xFor(e.yr);
			var t  = countToT(e.count);
			var c  = plasmaColor(t);
			// Dim blobs that fall outside the active section's year range
			var inSection = !dyActiveSection ||
				(e.yr >= dyActiveSection.yearMin && e.yr <= dyActiveSection.yearMax);
			var alpha = inSection ? 0.80 : 0.80 * 0.18;

			// Single gradient: hot plasma colour at centre → dark purple at r=0.9 → transparent at r=1
			var STEPS = 8;
			var gx = ctx.createRadialGradient(x, H/2, 0, x, H/2, blobR);
			for (var si = 0; si <= STEPS; si++) {
				var r = (si / STEPS) * 0.9;
				var tAtR = t * (1 - r / 0.9);
				var col = plasmaColor(tAtR);
				gx.addColorStop(r, 'rgba('+col[0]+','+col[1]+','+col[2]+','+alpha+')');
			}
			gx.addColorStop(1, 'rgba(0,0,0,0)');
			ctx.fillStyle = gx;
			ctx.fillRect(x - blobR, 0, blobR * 2, H);
		});

		// White-hot specular for the highest-count year (always yellow ceiling)
		entries.filter(function(e) { return e.count >= ceiling; })
			.forEach(function(e) {
				var x = xFor(e.yr);
				var sw = Math.max(W * 0.008, 4);
				var sg = ctx.createLinearGradient(x - sw, 0, x + sw, 0);
				sg.addColorStop(0,    'rgba(255,255,230,0)');
				sg.addColorStop(0.5,  'rgba(255,255,230,0.9)');
				sg.addColorStop(1,    'rgba(255,255,230,0)');
				ctx.fillStyle = sg;
				ctx.fillRect(x - sw, 0, sw * 2, H);
			});

		// Section bracket hairlines: two vertical markers at the year bounds
		if (dyActiveSection) {
			[dyActiveSection.yearMin, dyActiveSection.yearMax].forEach(function(yr) {
				var bx = xFor(yr);
				ctx.strokeStyle = 'rgba(80,80,80,0.75)';
				ctx.lineWidth = 1;
				ctx.setLineDash([3, 3]);
				ctx.beginPath();
				ctx.moveTo(bx, 0); ctx.lineTo(bx, H);
				ctx.stroke();
				ctx.setLineDash([]);
			});
		}

		// ── Tick marks ──────────────────────────────────────────────
		// Semi-transparent overlay at bottom edge so ticks are legible
		var TICK_AREA = 7;
		ctx.fillStyle = 'rgba(255,255,255,0.38)';
		ctx.fillRect(0, H - TICK_AREA, W, TICK_AREA);
		// Minor ticks at half the label step
		var _ax = _yrAxis;
		var _minor = Math.max(1, _ax.step / 2);
		ctx.strokeStyle = 'rgba(80,80,80,0.65)';
		ctx.lineWidth = 1;
		ctx.setLineDash([]);
		for (var tyr = _ax.start; tyr <= _ax.end; tyr += _minor) {
			var tx = xFor(tyr);
			ctx.beginPath(); ctx.moveTo(tx, H - 3); ctx.lineTo(tx, H); ctx.stroke();
		}
		// Major ticks every 10 years (taller, darker)
		ctx.strokeStyle = 'rgba(40,40,40,0.80)';
		ctx.lineWidth = 1.5;
		for (var tyr2 = _ax.start; tyr2 <= _ax.end; tyr2 += _ax.step) {
			var tx2 = xFor(tyr2);
			ctx.beginPath(); ctx.moveTo(tx2, H - TICK_AREA); ctx.lineTo(tx2, H); ctx.stroke();
		}
		// Break glyph where the compressed early segment meets the linear axis
		if (_ax.hasPre) {
			var bxp = _ax.preFrac * W;
			ctx.strokeStyle = 'rgba(40,40,40,0.85)';
			ctx.lineWidth = 1.5;
			ctx.beginPath();
			ctx.moveTo(bxp - 4, H); ctx.lineTo(bxp,     H - TICK_AREA - 2);
			ctx.moveTo(bxp,     H); ctx.lineTo(bxp + 4, H - TICK_AREA - 2);
			ctx.stroke();
		}

		// Current-event tick: dark line on grey bg
		var aev = activeEv || currentEv;
		if (aev && aev.event_date) {
			var ym = aev.event_date.match(/^(\d{4})/);
			if (ym) {
				var ax = xFor(parseInt(ym[1]));
				ctx.strokeStyle = 'rgba(0,0,0,0.85)';
				ctx.lineWidth = 2;
				ctx.beginPath();
				ctx.moveTo(ax, 1); ctx.lineTo(ax, H - 1);
				ctx.stroke();
			}
		}
	}
	function getDyList() {
		var mode = (document.querySelector('input[name="dy-mode"]:checked') || {}).value;
		var base;
		if (mode === 'chron') {
			if (!dyEvListChron) {
				dyEvListChron = reEventsList.slice().sort(function(a, b) {
					var ya = a.event_date ? parseInt((a.event_date.match(/^(\d{4})/) || [0,0])[1]) : 9999;
					var yb = b.event_date ? parseInt((b.event_date.match(/^(\d{4})/) || [0,0])[1]) : 9999;
					return ya - yb || parseFloat(a.order_within_page||0) - parseFloat(b.order_within_page||0);
				});
			}
			base = dyEvListChron;
		} else {
			base = reEventsList;
		}
		// When a section is active, limit playback to that section's events
		if (dyActiveSection) {
			var ps = dyActiveSection.pageStart, pe = dyActiveSection.pageStop;
			return base.filter(function(e) {
				return parseInt(e.page_number) >= ps && parseInt(e.page_number) < pe;
			});
		}
		return base;
	}
	function dyCurrentIdx() {
		if (!currentEv) return 0;
		var list = getDyList();
		return list.findIndex(function(e) { return String(e.event_nid) === String(currentEv.event_nid); });
	}
	function dyDeactivate() {
		var evView = document.getElementById('ft-events-view') || document.getElementById('fulltext-panel');
		if (evView) evView.querySelectorAll('.ft-item.active, .ft-item.open').forEach(function(el) { el.classList.remove('active', 'open'); });
		var hlCont = document.getElementById('ft-highlight-view');
		if (hlCont) hlCont.querySelectorAll('.ft-hl-span.ft-hl-active, .ft-hl-span.ft-hl-locked').forEach(function(s) { s.classList.remove('ft-hl-active', 'ft-hl-locked'); });
		currentEv = null; currentLocation = '';
		_annotatedNid = null;
	}
	function dyGoto(ev, fromScroll) {
		if (!ev) return;
		var nid = String(ev.event_nid);
		dyHeatCounts[nid] = (dyHeatCounts[nid] || 0) + 1; // heat up temporal heatmap
		dyVisitedNids[nid] = true;
		// Accumulate spatial heat at the event's location
		var loc = ev.event_location || '';
		if (loc) {
			dyLocHeatCounts[loc] = (dyLocHeatCounts[loc] || 0) + 1;
		}
		currentEv = ev; currentLocation = ev.event_location;
		activateItem(nid, true, fromScroll);
		updateInfoPanel(ev, ev.event_location);
		updateMapCharacters(ev, ev.event_location);
		updateToolbarState(ev);
		drawSpatialHeatmap();
		// In fulltext mode, navigation clears the annotation panel (annotation is click-only)
		if (dyDisplayMode === 'fulltext' && !fromScroll) clearReadingAnnotation();
	}
	function dyStop() {
		if (dyPlayTimer) { clearTimeout(dyPlayTimer); dyPlayTimer = null; }
	}
	function dyPlayStep() {
		var list = getDyList(), idx = dyCurrentIdx();
		if (idx < list.length - 1) {
			dyGoto(list[idx + 1]);
			var sv = parseInt((document.getElementById('dy-speed-range') || {}).value) || 3;
			dyPlayTimer = setTimeout(dyPlayStep, 2400 - sv * 400); // 1→2s 3→1.2s 5→0.4s
		} else {
			dyPlayTimer = null;
		}
	}

	// ── Toolbar: build, date ticks, state update ─────────────────
	var toolbarBuilt = false;
	function buildToolbar() {
		if (toolbarBuilt) return;
		toolbarBuilt = true;

		// Section tab buttons from existing #sections elements
		var secDiv = document.getElementById('dy-tb-sections');
		if (secDiv) {
			document.querySelectorAll('#sections .section_item').forEach(function(s) {
				var btn = document.createElement('button');
				btn.className = 'dy-sec-btn';
				btn.textContent = s.textContent.trim() + '\u00a0';
				var label = s.getAttribute('title') || s.textContent.trim();
				btn.title = 'Section ' + label;
				btn.dataset.start = s.dataset.start;
				btn.dataset.stop  = s.dataset.stop;
				btn.addEventListener('click', function() {
					dyStop();
					var start = parseInt(this.dataset.start), stop = parseInt(this.dataset.stop);
					// Compute the calendar year range for events in this section
					var secEvs = reEventsList.filter(function(e) {
						return parseInt(e.page_number) >= start && parseInt(e.page_number) < stop;
					});
					var secYears = secEvs.map(function(e) {
						var m = e.event_date ? e.event_date.match(/^(\d{4})/) : null;
						return m ? parseInt(m[1]) : null;
					}).filter(Boolean);
					// Toggle: clicking the already-active section clears the highlight
					var alreadyActive = btn.classList.contains('dy-sec-active');
					if (alreadyActive) {
						dyActiveSection = null;
					} else if (secYears.length) {
						dyActiveSection = {
							pageStart: start,
							pageStop:  stop,
							yearMin: Math.min.apply(null, secYears),
							yearMax: Math.max.apply(null, secYears)
						};
					}
					var ev = secEvs[0];
					if (ev) dyGoto(ev);
					else dyDrawHeatmap(currentEv); // redraw even if no event to go to
				});
				secDiv.appendChild(btn);
			});
			// Collapse toggle for toolbar — appended at the end of the sections row
			(function() {
				var colBtn = document.createElement('button');
				colBtn.className = 'dy-panel-btn';
				colBtn.id = 'dy-tb-collapse-btn';
				colBtn.title = 'Collapse toolbar';
				colBtn.innerHTML = '&#8863;';
				secDiv.appendChild(colBtn);
				var tb = document.getElementById('dy-toolbar');
				var _collapsed = false, _savedH = 0, _sectH = 0;
				_panelResets.toolbar = function() {
					if (!_collapsed) return;
					_collapsed = false;
					tb.style.height = '';
					colBtn.innerHTML = '&#8863;';
				};
				colBtn.addEventListener('click', function() {
					_collapsed = !_collapsed;
					if (_collapsed) {
						_sectH  = secDiv.offsetHeight;
						_savedH = tb.offsetHeight;
						tb.style.height = _savedH + 'px';
						tb.offsetHeight;
						tb.style.height = _sectH + 'px';
						colBtn.innerHTML = '&#8862;';
					} else {
						tb.style.height = _savedH + 'px';
						colBtn.innerHTML = '&#8863;';
						setTimeout(function() { if (!_collapsed) tb.style.height = ''; }, 300);
					}
				});
			})();
		}

		// Build event tick marks on the date bar
		buildDateTicks(); // also sets dyYearMin / dyYearMax

		// Slider: range and ticks are set by buildSliderTicks(); handler maps position → nearest event
		var slider = document.getElementById('dy-event-slider');
		if (slider) {
			slider.addEventListener('input', function() {
				dyStop();
				var pos  = parseFloat(this.value);
				var list = getDyList();
				var best = 0, bestDist = Infinity;
				_sliderEvPositions.forEach(function(p, i) {
					var d = Math.abs(p - pos);
					if (d < bestDist) { bestDist = d; best = i; }
				});
				if (list[best]) dyGoto(list[best]);
			});
		}

		// Build page tick marks; rebuild whenever Story/Chron mode switches
		buildSliderTicks();
		document.querySelectorAll('input[name="dy-mode"]').forEach(function(r) {
			r.addEventListener('change', function() {
				if (!r.checked) return;
				buildSliderTicks();
				if (typeof clarity === 'function') {
					clarity('event', 'mode_switch');           // marks the moment in recordings
					clarity('set', 'navigation_mode', r.value); // tags session: 'page' or 'chron'
				}
			});
		});

		// Transport buttons — use our own loop; DY's native play throws dialog errors
		document.getElementById('dy-prev-btn').addEventListener('click', function() {
			dyStop();
			var list = getDyList(), idx = dyCurrentIdx();
			if (idx > 0) dyGoto(list[idx - 1]);
		});
		document.getElementById('dy-play-btn').addEventListener('click', function() {
			dyStop(); dyPlayStep();
		});
		document.getElementById('dy-stop-btn').addEventListener('click', function() {
			dyStop();
		});
		document.getElementById('dy-next-btn').addEventListener('click', function() {
			dyStop();
			var list = getDyList(), idx = dyCurrentIdx();
			if (idx < list.length - 1) dyGoto(list[idx + 1]);
		});
		document.getElementById('dy-reset-btn').addEventListener('click', function() {
			dyStop();
			dyEvListChron = null;
			dyVisitedNids = {};
			dyHeatCounts     = {};   // clear temporal heatmap
			// dyHeatCeiling is pre-computed from data and must not be reset here —
			// resetting it to 1 causes every blob to render at full intensity on the
			// second playthrough (count=1, ceiling=1 → t=1.0).
			dyLocHeatCounts  = {};   // clear spatial heatmap
			dyActiveSection  = null;
			dyDrawHeatmap(null);     // redraw blank bar
			drawSpatialHeatmap();    // clear spatial blobs
			// Rebuild tick positions (section filter cleared) and reset thumb
			buildSliderTicks();
			var slider = document.getElementById('dy-event-slider');
			if (slider) { slider.value = 0; slider.dispatchEvent(new Event('input')); }
		});

		// Speed range → DY's hidden jQuery UI speed sliders
		var speedRange = document.getElementById('dy-speed-range');
		if (speedRange) {
			speedRange.addEventListener('input', function() {
				// Map 1-5 → 0-100 for jQuery UI sliders (higher = faster)
				var val = (parseInt(this.value) - 1) / 4 * 100;
				if ($ && $('#e_speed').length) $('#e_speed').slider('value', val);
				if ($ && $('#speed').length)   $('#speed').slider('value', val);
				if ($ && $('#c_speed').length)  $('#c_speed').slider('value', val);
			});
		}

		if (dyDisplayMode !== 'map') {
			document.getElementById('dy-toolbar').style.display = 'block';
		} else {
			document.getElementById('dy-agg-panel').style.display = 'block';
		}

		// ── Aggregation panel tab wiring ────────────────────────────
		var _aggTabs = document.getElementById('dy-agg-tabs');
		if (_aggTabs && !_aggTabs._wired) {
			_aggTabs._wired = true;
			_aggTabs.addEventListener('click', function(e) {
				var btn = e.target.closest('.dy-agg-tab');
				if (!btn) return;
				var tabId = btn.getAttribute('data-agg');
				_aggTabs.querySelectorAll('.dy-agg-tab').forEach(function(b) { b.classList.remove('active'); });
				btn.classList.add('active');
				document.querySelectorAll('.dy-agg-view').forEach(function(v) { v.classList.remove('active'); });
				var target = document.getElementById(tabId);
				if (target) target.classList.add('active');
				// Render deferred Plotly pie once Events tab is visible
				if (tabId === 'agg-events' && window.Plotly) {
					var evPanel = document.getElementById('agg-events');
					var slices = evPanel && evPanel._pieData;
					if (slices) {
						Plotly.react('agg-events-pie', [{
							type: 'pie',
							values: slices.map(function(s) { return s.value; }),
							labels: slices.map(function(s) { return s.label; }),
							marker: { colors: DY_COLORWAY.slice(0, slices.length) },
							textinfo: 'none',
							hovertemplate: '%{label}: %{value} (%{percent})<extra></extra>'
						}], {
							showlegend: false,
							margin: { l: 5, r: 5, t: 5, b: 5, pad: 0 },
							paper_bgcolor: 'rgba(0,0,0,0)',
							plot_bgcolor: 'rgba(0,0,0,0)',
							font: DY_FONT
						}, {
							displaylogo: false,
							staticPlot: false,
							responsive: true,
							modeBarButtonsToRemove: ['zoom2d','pan2d','select2d','lasso2d','autoscale2d','zoomIn2d','zoomOut2d','resetScale2d']
						});
					}
				}
				// Render deferred Plotly pies once Networks tab is visible
				if (tabId === 'agg-networks' && window.Plotly) {
					var netPanel = document.getElementById('agg-networks');
					var pies = netPanel && netPanel._netPies;
					if (pies) {
						pies.forEach(function(p) {
							Plotly.react(p.id, [{
								type: 'pie',
								values: p.slices.map(function(s) { return s.value; }),
								labels: p.slices.map(function(s) { return s.label; }),
								marker: { colors: DY_COLORWAY.slice(0, p.slices.length) },
								textinfo: 'none',
								hovertemplate: '%{label}: %{value} (%{percent})<extra></extra>'
							}], {
								showlegend: false,
								margin: { l: 5, r: 5, t: 5, b: 5, pad: 0 },
								paper_bgcolor: 'rgba(0,0,0,0)',
								plot_bgcolor: 'rgba(0,0,0,0)',
								font: DY_FONT
							}, {
								displaylogo: false,
								staticPlot: false,
								responsive: true,
								modeBarButtonsToRemove: ['zoom2d','pan2d','select2d','lasso2d','autoscale2d','zoomIn2d','zoomOut2d','resetScale2d']
							});
						});
					}
				}
			});
		}

		// Labels toggles
		var labelsToggle = document.getElementById('dy-labels-toggle');
		if (labelsToggle) {
			labelsToggle.addEventListener('change', function() {
				if (currentEv) updateMapCharacters(currentEv, currentLocation);
			});
		}
		var locLabelsToggle = document.getElementById('dy-loc-labels-toggle');
		if (locLabelsToggle) {
			locLabelsToggle.addEventListener('change', function() {
				if (currentEv) updateMapCharacters(currentEv, currentLocation);
			});
		}
		// Rank checkboxes
		['dy-rank-major','dy-rank-secondary','dy-rank-minor','dy-rank-peripheral','dy-rank-mentioned'].forEach(function(id) {
			var el = document.getElementById(id);
			if (el) el.addEventListener('change', function() {
				if (currentEv) updateMapCharacters(currentEv, currentLocation);
			});
		});
		// Spatial heatmap toggle
		var spatialHeatToggle = document.getElementById('dy-spatial-heatmap-toggle');
		if (spatialHeatToggle) {
			spatialHeatToggle.addEventListener('change', function() {
				drawSpatialHeatmap();
			});
		}
	}

	function buildSliderTicks() {
		var ticksDiv = document.getElementById('dy-slider-ticks');
		var slider   = document.getElementById('dy-event-slider');
		if (!ticksDiv || !slider) return;
		ticksDiv.innerHTML = '';
		_sliderEvPositions = [];
		var list = getDyList();
		var N = list.length;
		if (N < 2) {
			slider.min = 0; slider.max = 1; slider.step = 1; slider.value = 0;
			return;
		}
		var mode = (document.querySelector('input[name="dy-mode"]:checked') || {}).value;

		// Collect unique pages and per-page event counts from the current list
		var seenPages = [], pageOrder = {}, pageTotals = {}, subCounts = {};
		list.forEach(function(ev) {
			var pg = String(ev.page_number);
			if (!(pg in pageOrder)) { pageOrder[pg] = seenPages.length; seenPages.push(pg); }
			pageTotals[pg] = (pageTotals[pg] || 0) + 1;
		});

		// ── Story mode ─────────────────────────────────────────────
		// Pages are in story order (already sequential). Thumb creeps
		// steadily left-to-right; date marker hops back and forth.
		//
		// ── Chron mode ─────────────────────────────────────────────
		// Re-sort pages numerically so tick marks are evenly spaced by
		// page number regardless of the year-driven list order.
		// Each event's position maps to its page slot, so the thumb
		// snaps to whichever page the current chronological event
		// lives on — jumping back and forth — while the date marker
		// on the heatmap advances steadily through years.
		if (mode === 'chron') {
			seenPages.sort(function(a, b) { return parseInt(a) - parseInt(b); });
			seenPages.forEach(function(pg, i) { pageOrder[pg] = i; });
		}

		var P = seenPages.length;

		// Float position: pageIndex + subIndex/pageTotal
		// In story mode this produces a smooth creep within each page.
		// In chron mode the pageIndex jumps non-sequentially, causing
		// the thumb to hop; sub-positions provide fine movement when
		// consecutive chron events share the same page.
		_sliderEvPositions = list.map(function(ev) {
			var pg  = String(ev.page_number);
			var pi  = pageOrder[pg];
			var sub = subCounts[pg] || 0;
			subCounts[pg] = sub + 1;
			return pi + sub / pageTotals[pg];
		});

		// Slider range: 0 to P-1, fine step so sub-page positions register
		slider.min   = 0;
		slider.max   = P - 1;
		slider.step  = 0.001;
		slider.value = 0;

		// Tick marks: thin them to roughly TARGET_TICKS so long texts don't crowd.
		var TARGET_TICKS = 11;
		var pageNums = seenPages.map(function(p) { return parseInt(p, 10) || 0; });
		var pgSpan = Math.max.apply(null, pageNums) - Math.min.apply(null, pageNums);
		var raw = Math.max(1, pgSpan / (TARGET_TICKS - 1));
		var NICE = [1, 2, 5, 10, 15, 20, 25, 30, 40, 50, 75, 100];
		var pgStep = NICE.reduce(function(best, s) {
			return Math.abs(s - raw) < Math.abs(best - raw) ? s : best;
		}, NICE[0]);

		var lastLabelled = null;
		seenPages.forEach(function(pg, pi) {
			var num = parseInt(pg, 10) || 0;
			var isLast = pi === P - 1;
			if (lastLabelled !== null && !isLast && (num - lastLabelled) < pgStep) return;
			if (isLast && lastLabelled !== null && (num - lastLabelled) < pgStep / 2) return;
			lastLabelled = num;

			var pct = P > 1 ? (pi / (P - 1) * 100).toFixed(2) : '0.00';
			var tick = document.createElement('div');
			tick.className = 'dy-pg-tick';
			tick.style.left = pct + '%';
			var line = document.createElement('div');
			line.className = 'dy-pg-tick-line';
			var label = document.createElement('div');
			label.className = 'dy-pg-tick-label';
			label.textContent = pg;
			tick.appendChild(line);
			tick.appendChild(label);
			ticksDiv.appendChild(tick);
		});
	}

	function buildDateTicks() {
		// Extract start years from event dates
		var years = [];
		reEventsList.forEach(function(ev) {
			if (ev.event_date) {
				var m = ev.event_date.match(/^(\d{4})/);
				if (m) years.push(parseInt(m[1]));
			}
		});
		dyYearMin = years.length ? Math.min.apply(null, years) : 1850;
		dyYearMax = years.length ? Math.max.apply(null, years) : 1924;
		buildYearAxis(years);

		// Size canvas now that we know the container width
		var canvas = document.getElementById('dy-heat-canvas');
		if (canvas) {
			canvas.width = canvas.parentElement.clientWidth || 760;
			// Click canvas to navigate to nearest event at that year
			canvas.addEventListener('click', function(e) {
				var rect = canvas.getBoundingClientRect();
				var pct  = (e.clientX - rect.left) / rect.width;
				var clickYear = fracToYear(pct);
				var best = reEventsList[0], bestDist = Infinity;
				reEventsList.forEach(function(ev) {
					if (!ev.event_date) return;
					var ym = ev.event_date.match(/^(\d{4})/); if (!ym) return;
					var d = Math.abs(parseInt(ym[1]) - clickYear);
					if (d < bestDist) { bestDist = d; best = ev; }
				});
				dyStop(); if (best) dyGoto(best);
			});
			dyDrawHeatmap(null); // draw the initial empty bar
		}

		// Year labels below canvas, at the axis step
		var labelsDiv = document.getElementById('dy-year-labels');
		if (labelsDiv) {
			labelsDiv.innerHTML = '';
			var ax = _yrAxis;
			if (ax.hasPre) {
				var pre = document.createElement('span');
				pre.className = 'dy-yr-lbl dy-yr-lbl-pre';
				pre.textContent = '\u2039' + DY_YEAR.cutoff;
				pre.title = 'All events before ' + DY_YEAR.cutoff + ' (compressed)';
				pre.style.left = '0%';
				labelsDiv.appendChild(pre);

				var brk = document.createElement('span');
				brk.className = 'dy-yr-break';
				brk.textContent = '\u2215\u2215';
				brk.title = 'Axis break \u2014 the span to the left is not to scale';
				brk.style.left = (ax.preFrac * 100).toFixed(2) + '%';
				labelsDiv.appendChild(brk);
			}
			// When collapsed, the '‹cutoff' label already marks the boundary year.
			var firstLabel = ax.hasPre ? ax.start + ax.step : ax.start;
			for (var yr = firstLabel; yr <= dyYearMax; yr += ax.step) {
				var sp = document.createElement('span');
				sp.className = 'dy-yr-lbl';
				sp.textContent = yr;
				sp.style.left = (yearFrac(yr) * 100).toFixed(2) + '%';
				labelsDiv.appendChild(sp);
			}
		}
	}

	function updateToolbarState(ev) {
		if (!ev) return;
		// Year + page display
		var yearEl = document.getElementById('dy-year-display');
		if (yearEl) {
			var m = ev.event_date ? ev.event_date.match(/^(\d{4})/) : null;
			var yr = m ? m[1] : '\u2014';
			var pg = ev.page_number ? '\u00a0p.' + ev.page_number : '';
			yearEl.textContent = yr + pg;
		}
		// Slider: set thumb to this event's page-proportional position
		var slider = document.getElementById('dy-event-slider');
		if (slider) {
			var list = getDyList();
			var idx  = list.findIndex(function(e) { return String(e.event_nid) === String(ev.event_nid); });
			if (idx >= 0 && idx < _sliderEvPositions.length) {
				slider.value = _sliderEvPositions[idx];
			}
		}
		// Redraw heatmap canvas (ev already added to dyHeatCounts in dyGoto)
		dyDrawHeatmap(ev);
		// Active section tab
		document.querySelectorAll('.dy-sec-btn').forEach(function(btn) {
			var start = parseInt(btn.dataset.start), stop = parseInt(btn.dataset.stop);
			var pg = parseInt(ev.page_number);
			btn.classList.toggle('dy-sec-active', pg >= start && pg < stop);
		});
	}

	// ── Event delegation ─────────────────────────────────────────
	document.addEventListener('click', function(e) {
		if (!e.target || !e.target.closest) return;

		// Info-panel tab
		var tabBtn = e.target.closest('.info-tab');
		if (tabBtn) {
			var tabId = tabBtn.getAttribute('data-tab');
			if (!tabId) return;
			document.querySelectorAll('#info-panel .info-tab').forEach(function(b) { b.classList.remove('active'); });
			document.querySelectorAll('#info-panel .info-tab-content').forEach(function(c) { c.classList.remove('active'); });
			tabBtn.classList.add('active');
			var tc = document.getElementById(tabId);
			if (tc) tc.classList.add('active');
			return;
		}

		// Event row click: expand/collapse
		var bar = e.target.closest('.ft-item-bar');
		if (bar) {
			var item = bar.closest('.ft-item');
			if (!item) return;
			var nid = item.getAttribute('data-nid');
			var ev  = reEventsMap[nid] || {};
			if (currentEv && String(currentEv.event_nid) === nid) { dyDeactivate(); return; }
			currentEv = ev; currentLocation = ev.event_location || '';
			var wasOpen = item.classList.contains('open');
			document.querySelectorAll('.ft-item.open').forEach(function(el) { el.classList.remove('open'); });
			if (!wasOpen) item.classList.add('open');
			activateItem(nid, false);
			updateInfoPanel(ev, ev.event_location || '');
			// Show characters at this event's location
			updateMapCharacters(ev, ev.event_location || '');
			updateToolbarState(ev);
		}
	});

	// ── show_event_side_dialog override (slider/button navigation) ─
	window.show_event_side_dialog = function(events) {
		var nid      = String(events[5]);
		var location = events[0];
		if (currentEv && String(currentEv.event_nid) === nid) { dyDeactivate(); return; }
		var ev = reEventsMap[nid] || { first_words: events[3], event_location: location };
		currentEv = ev; currentLocation = location;
		activateItem(nid, true);
		updateInfoPanel(ev, location);
		// Show characters at this event's location
		updateMapCharacters(ev, location);
		updateToolbarState(ev);
	};

	// ── Display mode ──────────────────────────────────────────────
	var dyDisplayMode = 'map';
	var _suppressScroll = false;

	// ── Panel layout ──────────────────────────────────────────────
	// All overlay panel geometry is derived from the map rect here so that
	// CSS never competes with JS for position/size.
	var DY_LAYOUT = {
		CONTENT_W:    1300,  // #content_2 width
		EDGE_GAP:       10,  // right column -> viewport right edge
		COL_GAP:        10,  // map right edge -> right column
		GUTTER:         10,  // map bottom -> toolbar / info / aggregation panel
		TITLE_INSET:    60,  // title bar sits this far above map bottom
		MIN_PANEL_W:   360   // below this the right-column panels go vertical
	};
	var _mapSizes = [
		{ w: 800,  h: 500 },
		{ w: 1000, h: 625 },
		{ w: 1200, h: 750 }
	];
	var _mapSizeIdx = 0;

	function layoutPanels() {
		var ftPanel   = document.getElementById('fulltext-panel');
		var infoPanel = document.getElementById('info-panel');

		// Fulltext mode reparents these panels into a flex wrapper; leave geometry
		// alone, but drop the narrow-column classes so they can't leak into it.
		if (dyDisplayMode === 'fulltext') {
			if (ftPanel)   ftPanel.classList.remove('fp-v-minimized');
			if (infoPanel) infoPanel.classList.remove('ip-v-minimized');
			return;
		}
		var container = document.getElementById('container');
		if (!container) return;

		var L         = DY_LAYOUT;
		var sz        = _mapSizes[_mapSizeIdx];
		var mapTop    = container.offsetTop;
		var mapBottom = mapTop + sz.h;

		// Right column runs from the map's right edge to the content edge.
		var colLeft  = sz.w + L.COL_GAP;
		var colW     = Math.max((L.CONTENT_W - L.EDGE_GAP) - colLeft, 0);
		var belowMap = mapBottom + L.GUTTER;
		var narrow   = colW < L.MIN_PANEL_W;

		// Legacy theme pins #container to 500px; keep the box in sync with the stage.
		container.style.height = sz.h + 'px';

		var infoShown = infoPanel && getComputedStyle(infoPanel).display !== 'none';

		// Fulltext panel always spans the full height of the map.
		if (ftPanel) {
			ftPanel.style.left   = colLeft + 'px';
			ftPanel.style.top    = mapTop + 'px';
			ftPanel.style.width  = colW + 'px';
			ftPanel.style.height = sz.h + 'px';
			ftPanel.classList.toggle('fp-v-minimized', narrow);
		}

		var ctrlPanel = document.getElementById('dy-controls-panel');
		if (ctrlPanel) {
			ctrlPanel.style.top    = mapTop + 'px';
			ctrlPanel.style.height = sz.h + 'px';
			var dialog = ctrlPanel.querySelector('#layer_dialog');
			if (dialog) dialog.style.height = sz.h + 'px';
		}

		// Toolbar sits directly under the map and matches its width.
		var toolbar     = document.getElementById('dy-toolbar');
		var toolbarH    = 0;
		var toolbarShown = toolbar && getComputedStyle(toolbar).display !== 'none';
		if (toolbar) {
			toolbar.style.left  = '0px';
			toolbar.style.top   = belowMap + 'px';
			toolbar.style.width = sz.w + 'px';
			if (toolbarShown) toolbarH = toolbar.offsetHeight;
		}

		// Info panel shares the toolbar's baseline and height, filling the right column.
		if (infoPanel && infoShown) {
			infoPanel.style.left  = colLeft + 'px';
			infoPanel.style.top   = belowMap + 'px';
			infoPanel.style.width = colW + 'px';
			if (toolbarH) infoPanel.style.height = toolbarH + 'px';
			infoPanel.classList.toggle('ip-v-minimized', narrow);
			// Inline display wins over the stylesheet, so set the flex mode here.
			infoPanel.style.display = narrow ? 'flex' : 'block';
		}

		var aggPanel = document.getElementById('dy-agg-panel');
		var aggShown = aggPanel && getComputedStyle(aggPanel).display !== 'none';
		if (aggPanel) {
			aggPanel.style.left  = '0px';
			aggPanel.style.top   = belowMap + 'px';
			aggPanel.style.width = (L.CONTENT_W - L.EDGE_GAP) + 'px';
			aggPanel.classList.toggle('dy-agg-minimized', _mapSizeIdx === 2);
		}

		var titleBar = document.getElementById('dy-title-bar');
		if (titleBar) titleBar.style.top = (mapBottom - L.TITLE_INSET) + 'px';

		// Absolute children can't stretch #content_2, so grow it to fit the lowest panel.
		var c2 = document.getElementById('content_2');
		if (c2) {
			var lowest = mapBottom;
			if (toolbarShown)          lowest = Math.max(lowest, belowMap + toolbarH);
			if (infoShown)             lowest = Math.max(lowest, belowMap + infoPanel.offsetHeight);
			if (aggShown)              lowest = Math.max(lowest, belowMap + aggPanel.offsetHeight);
			c2.style.minHeight = Math.max(lowest + 20, 960) + 'px';
		}
	}

	// Scroll el into view within its own scrollable container, never the outer page.
	function scrollToEl(container, el) {
		var top = el.getBoundingClientRect().top - container.getBoundingClientRect().top + container.scrollTop;
		container.scrollTo({ top: top, behavior: 'smooth' });
	}

	function _activatePanelTab(tabName) {
		document.querySelectorAll('.ft-panel-tab').forEach(function(b) { b.classList.remove('active'); });
		var btn = document.querySelector('.ft-panel-tab[data-tab="' + tabName + '"]');
		if (btn) btn.classList.add('active');
		var evtsView    = document.getElementById('ft-events-view');
		var hlView      = document.getElementById('ft-highlight-view');
		var aboutView   = document.getElementById('ft-about-view');
		var editorsView = document.getElementById('ft-about-editors-view');
		var resView     = document.getElementById('ft-other-resources');
		var toolbar = document.getElementById('ft-text-toolbar');
		if (toolbar) {
			toolbar.classList.toggle('active', tabName === 'events' || tabName === 'text-hl');
			toolbar.dataset.mode = tabName;
			// Clear search when switching between tabs to avoid stale marks
			var inp = document.getElementById('ft-search-input');
			if (inp && inp.value) { inp.value = ''; inp.dispatchEvent(new Event('input')); }
		}
		if (evtsView)    evtsView.style.display    = (tabName === 'events')         ? ''      : 'none';
		if (hlView)      hlView.style.display      = (tabName === 'text-hl')        ? 'block' : 'none';
		if (aboutView)   aboutView.style.display   = (tabName === 'about-text')     ? 'block' : 'none';
		if (editorsView) editorsView.style.display = (tabName === 'about-editors')  ? 'block' : 'none';
		if (resView)     resView.style.display     = (tabName === 'resources')      ? 'block' : 'none';
		// Disable event-boundaries toggle in Events tab; enable it in text views
		var showEvLabel = document.querySelector('.ft-show-events-label');
		var showEvCheck = document.getElementById('ft-show-events-check');
		var isTextTab = (tabName === 'text-hl');
		if (showEvCheck) showEvCheck.disabled = !isTextTab;
		if (showEvLabel) showEvLabel.classList.toggle('ft-show-events-disabled', !isTextTab);
		if (tabName === 'text-hl') {
			buildHighlightView();
			initTextToolbar();
			setTimeout(function() {
				var active = hlView && hlView.querySelector('.ft-hl-span.ft-hl-active');
				if (active) scrollToEl(hlView, active);
			}, 50);
		}
	}
	window.dyActivatePanelTab = _activatePanelTab;

	// ── Text toolbar: search + section navigation ─────────────────
	var _textToolbarInited = false;
	var _doKwSearch = null;  // set by initTextToolbar; callable from annotation panel
	function initTextToolbar() {
		if (_textToolbarInited) return;
		_textToolbarInited = true;
		var toolbar   = document.getElementById('ft-text-toolbar');
		var evCont    = document.getElementById('ft-events-view');
		var hlCont    = document.getElementById('ft-highlight-view');
		var input     = document.getElementById('ft-search-input');
		var prevBtn   = document.getElementById('ft-search-prev');
		var nextBtn   = document.getElementById('ft-search-next');
		var countEl   = document.getElementById('ft-search-count');
		if (!input) return;

		var _hits = [], _hitIdx = -1;

		function activeContainer() {
			var mode = toolbar && toolbar.dataset.mode;
			if (mode === 'events')  return evCont;
			return hlCont;
		}

		function hitSelector() {
			var mode = toolbar && toolbar.dataset.mode;
			if (mode === 'events')  return '.ft-item-bar';
			return 'p';
		}

		function clearMarks() {
			[evCont, hlCont].forEach(function(c) {
				if (!c) return;
				c.querySelectorAll('mark.ft-search-hit').forEach(function(m) {
					var parent = m.parentNode;
					while (m.firstChild) parent.insertBefore(m.firstChild, m);
					parent.removeChild(m);
					parent.normalize();
				});
			});
			_hits = []; _hitIdx = -1;
			countEl.textContent = '';
		}

		function markInEl(el, re) {
			var walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, null, false);
			var nodes = [];
			while (walker.nextNode()) nodes.push(walker.currentNode);
			nodes.forEach(function(node) {
				var text = node.nodeValue;
				var parts = text.split(re);
				if (parts.length <= 1) return;
				var frag = document.createDocumentFragment();
				parts.forEach(function(part, i) {
					if (i % 2 === 0) {
						frag.appendChild(document.createTextNode(part));
					} else {
						var mark = document.createElement('mark');
						mark.className = 'ft-search-hit';
						mark.textContent = part;
						frag.appendChild(mark);
					}
				});
				node.parentNode.replaceChild(frag, node);
			});
		}

		function doSearch(term) {
			clearMarks();
			if (!term) return;
			var cont = activeContainer();
			if (!cont) return;
			var re = new RegExp('(' + term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ')', 'gi');
			cont.querySelectorAll(hitSelector()).forEach(function(el) { markInEl(el, re); });
			_hits = Array.from(cont.querySelectorAll('mark.ft-search-hit'));
			if (_hits.length) { _hitIdx = 0; updateHit(); }
			else countEl.textContent = '0';
		}

		function updateHit() {
			_hits.forEach(function(m, i) { m.classList.toggle('current', i === _hitIdx); });
			if (_hits[_hitIdx]) {
				_hits[_hitIdx].scrollIntoView({ block: 'nearest', behavior: 'smooth' });
				countEl.textContent = (_hitIdx + 1) + '/' + _hits.length;
			}
		}

		input.addEventListener('input', function() {
			var mode = modeSelect ? modeSelect.value : 'text';
			if (mode === 'keyword') {
				doKwSearch(input.value.trim());
			} else {
				doSearch(input.value.trim());
			}
		});
		input.addEventListener('keydown', function(e) {
			if (e.key === 'Enter') {
				var mode = modeSelect ? modeSelect.value : 'text';
				if (mode === 'keyword') {
					if (!_kwSpans.length) return;
					_kwIdx = e.shiftKey ? (_kwIdx - 1 + _kwSpans.length) % _kwSpans.length
					                    : (_kwIdx + 1) % _kwSpans.length;
					updateKwHit();
				} else {
					if (!_hits.length) return;
					_hitIdx = e.shiftKey ? (_hitIdx - 1 + _hits.length) % _hits.length
					                     : (_hitIdx + 1) % _hits.length;
					updateHit();
				}
			}
		});
		prevBtn.addEventListener('click', function() {
			var mode = modeSelect ? modeSelect.value : 'text';
			if (mode === 'keyword') {
				if (!_kwSpans.length) return;
				_kwIdx = (_kwIdx - 1 + _kwSpans.length) % _kwSpans.length; updateKwHit();
			} else {
				if (!_hits.length) return;
				_hitIdx = (_hitIdx - 1 + _hits.length) % _hits.length; updateHit();
			}
		});
		nextBtn.addEventListener('click', function() {
			var mode = modeSelect ? modeSelect.value : 'text';
			if (mode === 'keyword') {
				if (!_kwSpans.length) return;
				_kwIdx = (_kwIdx + 1) % _kwSpans.length; updateKwHit();
			} else {
				if (!_hits.length) return;
				_hitIdx = (_hitIdx + 1) % _hits.length; updateHit();
			}
		});

		// ── Keyword search ───────────────────────────────────────────────────
		var modeSelect = document.getElementById('ft-search-mode');
		var kwDatalist  = document.getElementById('ft-kw-datalist');
		var _kwSpans = [], _kwIdx = -1;

		// Populate datalist once from keyword index
		if (reKeywordIndex && reKeywordIndex.index && kwDatalist) {
			Object.keys(reKeywordIndex.index).sort().forEach(function(kw) {
				var opt = document.createElement('option');
				opt.value = kw;
				kwDatalist.appendChild(opt);
			});
		}

		function clearKwHighlight() {
			var hl = document.getElementById('ft-highlight-view');
			if (hl) {
				hl.querySelectorAll('.ft-kw-match, .ft-kw-current').forEach(function(s) {
					s.classList.remove('ft-kw-match', 'ft-kw-current');
				});
			}
			_kwSpans = []; _kwIdx = -1;
			countEl.textContent = '';
		}

		function updateKwHit() {
			_kwSpans.forEach(function(s, i) { s.classList.toggle('ft-kw-current', i === _kwIdx); });
			if (_kwSpans[_kwIdx]) {
				_kwSpans[_kwIdx].scrollIntoView({ block: 'nearest', behavior: 'smooth' });
			}
		}

		function doKwSearch(term) {
			clearKwHighlight();
			clearMarks();
			if (!term || !reKeywordIndex || !reKeywordIndex.index) { countEl.textContent = ''; return; }
			var termLower = term.toLowerCase();
			var matchedNids = {};
			Object.keys(reKeywordIndex.index).forEach(function(kw) {
				if (kw.toLowerCase().indexOf(termLower) !== -1) {
					reKeywordIndex.index[kw].forEach(function(nid) { matchedNids[String(nid)] = true; });
				}
			});
			var hl = document.getElementById('ft-highlight-view');
			if (!hl) return;
			hl.querySelectorAll('.ft-hl-span[data-nid]').forEach(function(span) {
				if (matchedNids[String(span.dataset.nid)]) {
					span.classList.add('ft-kw-match');
					_kwSpans.push(span);
				}
			});
			var nidCount = Object.keys(matchedNids).length;
			if (_kwSpans.length) {
				_kwIdx = 0;
				_kwSpans[0].classList.add('ft-kw-current');
				_kwSpans[0].scrollIntoView({ block: 'nearest', behavior: 'smooth' });
				countEl.textContent = nidCount + (nidCount === 1 ? ' event' : ' events');
			} else {
				countEl.textContent = '0 events';
			}
		}
		// Expose to annotation panel keyword clicks
		_doKwSearch = doKwSearch;

		// Mode switch wiring
		if (modeSelect) {
			modeSelect.addEventListener('change', function() {
				input.value = '';
				clearMarks();
				clearKwHighlight();
				countEl.textContent = '';
				if (modeSelect.value === 'keyword') {
					input.placeholder = 'Search keywords\u2026';
					input.setAttribute('list', 'ft-kw-datalist');
				} else {
					input.placeholder = 'Search text\u2026';
					input.removeAttribute('list');
				}
			});
		}

		// Section navigation
		// (scrollToEl is defined at module scope above)

		// Build section heading → NID map from reSentences
		var _sectionNids = {};
		Object.keys(reSentences).forEach(function(nid) {
			var _paras = (reSentences[nid].paras || []);
			_paras.forEach(function(p) {
				var t = p.trim();
				if (DY_TEXT.sectionRe.test(t) && !_sectionNids[t]) { _sectionNids[t] = nid; }
			});
		});

		document.querySelectorAll('.ft-sec-btn').forEach(function(btn) {
			btn.addEventListener('click', function() {
				var sec = btn.dataset.sec;
				// In section-by-section mode, filter to this section instead of scrolling
				if (_ftReadMode === 'section') {
					_applyFtSectionFilter(sec);
					return;
				}
				if (toolbar && toolbar.dataset.mode === 'events') {
					// Scroll events view to the first item of this section
					var nid = _sectionNids[sec];
					if (nid && evCont) {
						var item = evCont.querySelector('.ft-item[data-nid="' + nid + '"]');
						if (item) scrollToEl(evCont, item);
					}
				} else if (toolbar && toolbar.dataset.mode === 'text-hl') {
					// Scroll highlight view to its section-num header
					if (!hlCont) return;
					var hlHeaders = hlCont.querySelectorAll('.ft-section-num');
					for (var j = 0; j < hlHeaders.length; j++) {
						if (hlHeaders[j].textContent.trim() === sec) {
							scrollToEl(hlCont, hlHeaders[j]);
							return;
						}
					}
				} else {
					// Scroll text view to the section-num header
					if (!textCont) return;
					var headers = textCont.querySelectorAll('.ft-section-num');
					for (var i = 0; i < headers.length; i++) {
						if (headers[i].textContent.trim() === sec) {
							scrollToEl(textCont, headers[i]);
							return;
						}
					}
				}
			});
		});

		// Font-size increase / decrease
		var _ftFontSizes = [11, 12, 13, 14, 16, 18, 20];
		var _ftFontIdx   = 2; // default: 13px
		var _ftFontTargets = [
			'#ft-highlight-view', '#ft-events-view'
		];
		function applyFtFontSize() {
			var sz = _ftFontSizes[_ftFontIdx] + 'px';
			_ftFontTargets.forEach(function(sel) {
				var el = document.querySelector(sel);
				if (el) el.style.fontSize = sz;
			});
			var dec = document.getElementById('ft-font-decrease');
			var inc = document.getElementById('ft-font-increase');
			if (dec) dec.disabled = (_ftFontIdx === 0);
			if (inc) inc.disabled = (_ftFontIdx === _ftFontSizes.length - 1);
		}
		var decBtn = document.getElementById('ft-font-decrease');
		var incBtn = document.getElementById('ft-font-increase');
		if (decBtn) decBtn.addEventListener('click', function() {
			if (_ftFontIdx > 0) { _ftFontIdx--; applyFtFontSize(); }
		});
		if (incBtn) incBtn.addEventListener('click', function() {
			if (_ftFontIdx < _ftFontSizes.length - 1) { _ftFontIdx++; applyFtFontSize(); }
		});

		// Show-events checkbox toggle
		var showEvCheck = document.getElementById('ft-show-events-check');
		if (showEvCheck) showEvCheck.addEventListener('change', function() {
			var hl = document.getElementById('ft-highlight-view');
			if (hl) hl.classList.toggle('ft-show-pipes', showEvCheck.checked);
		});
	}

	// Stored parents for restoring panels when leaving fulltext mode
	var _ftLayoutCtrlParent = null;
	var _ftLayoutFpParent   = null;
	var _ftLayoutApParent   = null;
	// Tracks which event nid is currently shown in the annotation panel (null = hidden)
	var _annotatedNid = null;

	// Panel collapse reset registry — each init function registers a reset callback here
	var _panelResets = {};
	function _resetAllPanels() {
		Object.keys(_panelResets).forEach(function(k) { _panelResets[k](); });
		layoutPanels();
	}

	// _posAnnotPanel kept as no-op guard (no longer called, safe to remove later)
	function _posAnnotPanel() {}

	function setDisplayMode(mode) {
		var prevMode = dyDisplayMode;
		_resetAllPanels();
		dyDisplayMode = mode;
		// Sync global nav active state
		document.querySelectorAll('#dy-global-nav .dy-nav-btn').forEach(function(b) {
			b.classList.toggle('active', b.dataset.mode === mode);
		});
		// Sync legacy radio buttons
		var legacyRadio = document.querySelector('input[name="dy-display"][value="' + mode + '"]');
		if (legacyRadio) legacyRadio.checked = true;
		// Track display-mode switches (skip the silent initial call on page load)
		if (prevMode !== mode && typeof clarity === 'function') {
			clarity('upgrade', 'display_mode_switch');   // force full recording of this session
			clarity('event', 'display_mode_switch');
			clarity('set', 'display_mode', mode); // 'map' | 'map-text' | 'fulltext'
		}
		var ftPanel    = document.getElementById('fulltext-panel');
		var infoPanel  = document.getElementById('info-panel');
		var container  = document.getElementById('container');
		var toolbar      = document.getElementById('dy-toolbar');
		var ftReading    = document.getElementById('ft-reading');
		var playbar      = document.getElementById('playback_controls');
		var ctrlPanel    = document.getElementById('dy-controls-panel');

		// In Map Only mode restore native character controls; in map-text use rank buttons; in fulltext disable all
		var charRadios = document.querySelectorAll('#layer_dialog input[name="characters"]');
		if (mode === 'map') {
			charRadios.forEach(function(r) { r.disabled = false; });
			window._dyShowCharsOverride = false;
		} else if (mode === 'map-text') {
			charRadios.forEach(function(r) { r.disabled = true; });
			window._dyShowCharsOverride = true;
			// Reset rank checkboxes: check all
			['dy-rank-major','dy-rank-secondary','dy-rank-minor','dy-rank-peripheral','dy-rank-mentioned'].forEach(function(id) {
				var el = document.getElementById(id); if (el) el.checked = true;
			});
		} else {
			charRadios.forEach(function(r) { r.disabled = true; });
			window._dyShowCharsOverride = true;
		}

		if (mode === 'map') {
			// Clear any active event state before restoring overview
			dyDeactivate();
			// Overview: map + About/Resources panel visible; toolbar always hidden
			if (ftPanel)    { ftPanel.style.display = 'flex'; ftPanel.classList.add('dy-map-mode'); }
			if (ctrlPanel)  { ctrlPanel.classList.add('dy-map-mode'); ctrlPanel.classList.remove('dy-map-text-mode'); }
			if (infoPanel) infoPanel.style.display  = 'none';
			if (container) container.style.display  = '';
			if (toolbar)   toolbar.style.display    = 'none';
			if (playbar)   playbar.style.display     = 'none';
			if (ftReading) ftReading.style.display  = 'none';
			var aggPanel = document.getElementById('dy-agg-panel');
			if (aggPanel)  aggPanel.style.display   = 'block';
			document.body.classList.remove('dy-mode-fulltext');
			if (ctrlPanel) { ctrlPanel.style.top = ''; ctrlPanel.style.left = ''; ctrlPanel.style.height = ''; }
			var mapCtrl = document.getElementById('dy-map-layer-ctrl');
			var ftCtrl  = document.getElementById('dy-ft-layer-ctrl');
			var annotPnl = document.getElementById('ft-annot-panel');
			// Restore panels from #ft-layout back to their original parents
			var ftLayout = document.getElementById('ft-layout');
			if (ftLayout) {
				if (ctrlPanel && _ftLayoutCtrlParent) _ftLayoutCtrlParent.appendChild(ctrlPanel);
				if (ftPanel   && _ftLayoutFpParent)   _ftLayoutFpParent.appendChild(ftPanel);
				if (annotPnl  && _ftLayoutApParent)   _ftLayoutApParent.appendChild(annotPnl);
				ftLayout.remove();
				_ftLayoutCtrlParent = _ftLayoutFpParent = _ftLayoutApParent = null;
			}
			if (annotPnl) annotPnl.style.display = 'none';
			if (mapCtrl) mapCtrl.style.display = '';
			if (ftCtrl)  ftCtrl.style.display  = 'none';
			_activatePanelTab('about-text');
			// Redraw map in overview state
			if (typeof clearKonvaOverlays === 'function') { clearKonvaOverlays(); }
			// Restore all location markers to full opacity
			if (typeof current_locations !== 'undefined' && window.$) {
				$.each(current_locations, function(title, img) {
					if (img && typeof img.setOpacity === 'function') img.setOpacity(1);
				});
			}
			if (typeof show_characters === 'function') { show_characters(); }
			if (window.contentLayer && typeof contentLayer.draw === 'function') { contentLayer.draw(); }
		} else if (mode === 'map-text') {
			if (ftPanel)    { ftPanel.style.display = 'flex'; ftPanel.classList.remove('dy-map-mode'); }
			if (ctrlPanel)  { ctrlPanel.classList.remove('dy-map-mode'); ctrlPanel.classList.add('dy-map-text-mode'); }
			if (container) container.style.display  = '';
			if (toolbar)   toolbar.style.display    = 'block'; // always visible in map+text
			if (playbar)   playbar.style.display     = 'block';
			if (ftReading) ftReading.style.display  = 'none';
			var aggPanel = document.getElementById('dy-agg-panel');
			if (aggPanel)  aggPanel.style.display   = 'none';
			document.body.classList.remove('dy-mode-fulltext');
			if (ctrlPanel) { ctrlPanel.style.top = ''; ctrlPanel.style.left = ''; ctrlPanel.style.height = ''; }
			var mapCtrl = document.getElementById('dy-map-layer-ctrl');
			var ftCtrl  = document.getElementById('dy-ft-layer-ctrl');
			var annotPnl2 = document.getElementById('ft-annot-panel');
			// Restore panels from #ft-layout back to their original parents
			var ftLayout2 = document.getElementById('ft-layout');
			if (ftLayout2) {
				if (ctrlPanel && _ftLayoutCtrlParent) _ftLayoutCtrlParent.appendChild(ctrlPanel);
				if (ftPanel   && _ftLayoutFpParent)   _ftLayoutFpParent.appendChild(ftPanel);
				if (annotPnl2 && _ftLayoutApParent)   _ftLayoutApParent.appendChild(annotPnl2);
				ftLayout2.remove();
				_ftLayoutCtrlParent = _ftLayoutFpParent = _ftLayoutApParent = null;
			}
			if (annotPnl2) annotPnl2.style.display = 'none';
			if (mapCtrl) mapCtrl.style.display = '';
			if (ftCtrl)  ftCtrl.style.display  = 'none';
			_activatePanelTab('events');
			// Show info panel and first-event map frame immediately
			var showEv = currentEv || (reEventsList && reEventsList[0]);
			if (showEv) {
				currentEv = showEv;
				currentLocation = showEv.event_location || '';
				updateInfoPanel(showEv, currentLocation);
				updateMapCharacters(showEv, currentLocation);
				updateToolbarState(showEv);
			}
		} else if (mode === 'fulltext') {
			if (ftPanel)   { ftPanel.style.display = 'flex'; ftPanel.classList.remove('dy-map-mode'); }
			if (ctrlPanel) { ctrlPanel.classList.remove('dy-map-mode'); ctrlPanel.classList.remove('dy-map-text-mode'); }
			if (infoPanel) infoPanel.style.display  = 'none';
			if (container) container.style.display  = 'none';
			if (toolbar)   toolbar.style.display    = 'none';
			if (playbar)   playbar.style.display     = 'none';
			var aggPanel = document.getElementById('dy-agg-panel');
			if (aggPanel)  aggPanel.style.display   = 'none';
			document.body.classList.add('dy-mode-fulltext');
			var mapCtrl  = document.getElementById('dy-map-layer-ctrl');
			var ftCtrl   = document.getElementById('dy-ft-layer-ctrl');
			var annotPnl = document.getElementById('ft-annot-panel');
			if (mapCtrl)   mapCtrl.style.display  = 'none';
			if (ftCtrl)    ftCtrl.style.display   = '';
			if (ftReading) ftReading.style.display = 'none';
			if (annotPnl)  annotPnl.style.display  = 'block';
			// ── Build the flex wrapper and move the three panels into it ──
			var ftLayout = document.createElement('div');
			ftLayout.id = 'ft-layout';
			document.body.appendChild(ftLayout);
			// Store original parents (order doesn't matter; restoration uses parent.appendChild)
			_ftLayoutCtrlParent = ctrlPanel ? ctrlPanel.parentNode : null;
			_ftLayoutFpParent   = ftPanel   ? ftPanel.parentNode   : null;
			_ftLayoutApParent   = annotPnl  ? annotPnl.parentNode  : null;
			if (ctrlPanel) ftLayout.appendChild(ctrlPanel);
			if (ftPanel)   ftLayout.appendChild(ftPanel);
			if (annotPnl)  ftLayout.appendChild(annotPnl);
			_activatePanelTab('text-hl');
			initReadingControls();
			// Annotation panel starts hidden — only shown on explicit event click
			clearReadingAnnotation();
		}

		layoutPanels();
	}

	// ── Character filter change handler (works in both map and map-text modes) ──
	function onCharFilterChange() {
		if (dyDisplayMode === 'map-text') {
			if (currentEv) updateMapCharacters(currentEv, currentLocation || currentEv.event_location || '');
		} else {
			show_characters();
			contentLayer.draw();
		}
	}

	// ── Panel tabs (Events | Text | About) ───────────────────────
	function initPanelTabs() {
		var tabs = document.querySelectorAll('.ft-panel-tab');
		if (!tabs.length) return;
		tabs.forEach(function(btn) {
			btn.addEventListener('click', function() {
				_activatePanelTab(btn.dataset.tab);
			});
		});
	}

	function initInfoCollapse() {
		var ip  = document.getElementById('info-panel');
		var fp  = document.getElementById('fulltext-panel');
		var btn = ip && ip.querySelector('.info-collapse-btn');
		if (!btn || !fp) return;
		var _slid = false, _savedIpH = 0, _savedFpH = 0, _bodyH = 0;
		_panelResets.info = function() {
			if (!_slid) return;
			_slid = false;
			ip.style.transform = '';
			ip.style.height    = '';
			fp.style.height    = '';
			btn.innerHTML = '&#8863;';
		};
		btn.addEventListener('click', function() {
			_slid = !_slid;
			if (_slid) {
				var tabsBar = ip.querySelector('.info-tabs');
				_savedIpH = ip.offsetHeight;
				_savedFpH = fp.offsetHeight;
				var tabsH = tabsBar.offsetHeight;
				_bodyH = _savedIpH - tabsH;
				ip.style.height = _savedIpH + 'px';
				fp.style.height = _savedFpH + 'px';
				ip.offsetHeight;
				ip.style.transform = 'translateY(' + _bodyH + 'px)';
				ip.style.height    = tabsH + 'px';
				fp.style.height    = (_savedFpH + _bodyH) + 'px';
				btn.innerHTML = '&#8862;'; // ⊞ maximize
			} else {
				ip.style.transform = '';
				ip.style.height    = _savedIpH + 'px';
				fp.style.height    = _savedFpH + 'px';
				btn.innerHTML = '&#8863;'; // ⊟ minimize
				setTimeout(function() {
					if (!_slid) { ip.style.transform = ''; layoutPanels(); }
				}, 300);
			}
		});
	}

	// ── Fulltext panel collapse ↔ info panel stacked expansion ──────
	function initFpCollapse() {
		var fp  = document.getElementById('fulltext-panel');
		var ip  = document.getElementById('info-panel');
		var btn = document.getElementById('ft-panel-collapse-btn');
		if (!btn || !fp || !ip) return;
		var _collapsed = false, _savedFpH = 0, _savedIpH = 0, _savedIpTop = 0, _fpHeaderH = 0;
		var _collapseMode = ''; // 'vertical' (map) or 'stack' (map-text)
		_panelResets.fp = function() {
			if (!_collapsed) return;
			_collapsed = false;
			if (_collapseMode === 'vertical') {
				fp.classList.remove('fp-v-minimized');
				fp.style.width = '';
			} else {
				ip.classList.remove('ip-stacked');
				ip.style.overflow = '';
				fp.style.height   = '';
				ip.style.top      = '';
				ip.style.height   = '';
			}
			btn.innerHTML = '&#8863;';
		};
		btn.addEventListener('click', function() {
			_collapsed = !_collapsed;
			if (dyDisplayMode === 'map') {
				// ── Overview: collapse panel width to a vertical label strip ──
				_collapseMode = 'vertical';
				if (_collapsed) {
					var savedW = fp.offsetWidth;
					fp.style.width = savedW + 'px';
					fp.offsetWidth; // force reflow
					fp.classList.add('fp-v-minimized');
					fp.style.width = '26px';
					btn.innerHTML = '&#8862;'; // ⊞ maximize
				} else {
					fp.classList.remove('fp-v-minimized');
					fp.style.width = '460px';
					btn.innerHTML = '&#8863;'; // ⊟ minimize
					setTimeout(function() { if (!_collapsed) layoutPanels(); }, 300);
				}
			} else {
				// ── Map+Text: collapse fp to header height, expand ip stacked ──
				_collapseMode = 'stack';
				if (_collapsed) {
					var header = document.getElementById('ft-panel-header');
					_fpHeaderH  = header ? header.offsetHeight : 30;
					_savedFpH   = fp.offsetHeight;
					_savedIpH   = ip.offsetHeight;
					_savedIpTop = ip.offsetTop;
					// Pin sizes for transition
					fp.style.height = _savedFpH + 'px';
					ip.style.height = _savedIpH + 'px';
					ip.style.top    = _savedIpTop + 'px';
					fp.offsetHeight; // force reflow
					// Collapse fp to header height
					fp.style.height = _fpHeaderH + 'px';
					// Expand ip: move up to fill freed space
					var gap = _savedIpTop - (24 + _savedFpH);
					var newTop = 24 + _fpHeaderH + gap;
					var newH   = _savedIpTop + _savedIpH - newTop;
					ip.style.top    = newTop + 'px';
					ip.style.height = newH + 'px';
					// Add stacked class after animation
					setTimeout(function() { if (_collapsed) { ip.classList.add('ip-stacked'); ip.style.overflow = 'auto'; } }, 300);
					btn.innerHTML = '&#8862;'; // ⊞ maximize
				} else {
					ip.classList.remove('ip-stacked');
					ip.style.overflow = '';
					ip.offsetHeight; // reflow before transition
					fp.style.height = _savedFpH + 'px';
					ip.style.top    = _savedIpTop + 'px';
					ip.style.height = _savedIpH + 'px';
					btn.innerHTML = '&#8863;'; // ⊟ minimize
					setTimeout(function() {
						if (!_collapsed) layoutPanels();
					}, 300);
				}
			}
		});
	}

	// ── Aggregation panel collapse ────────────────────────────────
	function initAggPanelCollapse() {
		var agg = document.getElementById('dy-agg-panel');
		var btn = document.getElementById('dy-agg-collapse-btn');
		if (!btn || !agg) return;
		var tabs = document.getElementById('dy-agg-tabs');
		var _collapsed = false, _savedH = 0, _tabsH = 0;
		_panelResets.agg = function() {
			if (!_collapsed) return;
			_collapsed = false;
			agg.style.height = '';
			btn.innerHTML = '&#8863;';
		};
		btn.addEventListener('click', function() {
			_collapsed = !_collapsed;
			if (_collapsed) {
				_tabsH  = tabs ? tabs.offsetHeight : 28;
				_savedH = agg.offsetHeight;
				agg.style.height = _savedH + 'px';
				agg.offsetHeight;
				agg.style.height = _tabsH + 'px';
				btn.innerHTML = '&#8862;';
			} else {
				agg.style.height = _savedH + 'px';
				btn.innerHTML = '&#8863;';
				setTimeout(function() { if (!_collapsed) agg.style.height = ''; }, 300);
			}
		});
	}

	// ── Highlighted text view ─────────────────────────────────────
	var _highlightBuilt = false;
	function buildHighlightView() {
		if (_highlightBuilt) return;
		_highlightBuilt = true;
		var hlCont = document.getElementById('ft-highlight-view');
		if (!hlCont || !reTextHighlighted) return;
		hlCont.innerHTML = reTextHighlighted.html || '';

		// Inject pipe markers at event boundaries (before each span where nid changes)
		var allSpans = hlCont.querySelectorAll('.ft-hl-span[data-nid]');
		var prevNid = null;
		allSpans.forEach(function(span) {
			var nid = span.dataset.nid;
			// Stamp narrative status and temporality for markup modes
			var nsEv = reEventsMap[nid];
			if (nsEv && nsEv.narrative_status) span.dataset.ns = nsEv.narrative_status.trim();
			if (nsEv && nsEv.event_date) {
				var evYear = parseInt(nsEv.event_date.split('-')[0], 10);
				if (!isNaN(evYear)) {
					var np = DY_TEXT.narrativePresent;
					span.dataset.temporality = evYear < np ? 'past' : evYear > np ? 'future' : 'present';
				}
			}
			if (prevNid && nid !== prevNid) {
				var pipe = document.createElement('span');
				pipe.className = 'ft-event-pipe';
				pipe.textContent = ' | ';
				var transition = reEventTransitions[nid];
				if (transition === 'flashforward') {
					var fwIcon = document.createElement('span');
					fwIcon.className = 'ft-temporal-marker ft-flashforward';
					fwIcon.title = 'Flash forward';
					fwIcon.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="11" height="11" fill="currentColor" viewBox="0 0 16 16"><path d="M7.596 7.304a.802.802 0 0 1 0 1.392l-6.363 3.692C.713 12.69 0 12.345 0 11.692V4.308c0-.653.713-.998 1.233-.696z"/><path d="M15.596 7.304a.802.802 0 0 1 0 1.392l-6.363 3.692C8.713 12.69 8 12.345 8 11.692V4.308c0-.653.713-.998 1.233-.696z"/></svg>';
					pipe.appendChild(fwIcon);
				} else if (transition === 'flashback') {
					var fbIcon = document.createElement('span');
					fbIcon.className = 'ft-temporal-marker ft-flashback';
					fbIcon.title = 'Flashback';
					fbIcon.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="11" height="11" fill="currentColor" viewBox="0 0 16 16"><path d="M8.404 7.304a.802.802 0 0 0 0 1.392l6.363 3.692c.52.302 1.233-.043 1.233-.696V4.308c0-.653-.713-.998-1.233-.696z"/><path d="M.404 7.304a.802.802 0 0 0 0 1.392l6.363 3.692c.52.302 1.233-.043 1.233-.696V4.308c0-.653-.713-.998-1.233-.696z"/></svg>';
					pipe.appendChild(fbIcon);
				} else {
					var linIcon = document.createElement('span');
					linIcon.className = 'ft-temporal-marker ft-linear';
					linIcon.title = 'Linear';
					linIcon.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="11" height="11" fill="currentColor" viewBox="0 0 16 16"><path fill-rule="evenodd" d="M1 11.5a.5.5 0 0 0 .5.5h11.793l-3.147 3.146a.5.5 0 0 0 .708.708l4-4a.5.5 0 0 0 0-.708l-4-4a.5.5 0 0 0-.708.708L13.293 11H1.5a.5.5 0 0 0-.5.5zm14-7a.5.5 0 0 1-.5.5H2.707l3.147 3.146a.5.5 0 1 1-.708.708l-4-4a.5.5 0 0 1 0-.708l4-4a.5.5 0 1 1 .708.708L2.707 4H14.5a.5.5 0 0 1 .5.5z"/></svg>';
					pipe.appendChild(linIcon);
				}
				span.parentNode.insertBefore(pipe, span);
			}
			prevNid = nid;
		});

		// Click any span → navigate to that event + toggle annotation
		hlCont.querySelectorAll('.ft-hl-span[data-nid]').forEach(function(span) {
			span.addEventListener('click', function() {
				var ev = reEventsMap[span.dataset.nid];
				if (!ev) return;
				var nid = String(ev.event_nid);
				if (currentEv && String(currentEv.event_nid) === nid) {
					if (dyDisplayMode !== 'fulltext') { dyDeactivate(); return; }
					if (_annotatedNid === nid) { clearReadingAnnotation(); } else { showReadingAnnotation(ev, span); }
				} else {
					dyGoto(ev);
					if (dyDisplayMode === 'fulltext') showReadingAnnotation(ev, span);
				}
			});
		});
		_wrapHlSections();
	}
	var _readingControlsInited = false;

	// ── Reading mode state ────────────────────────────────────────
	var _ftReadMode   = 'scroll';  // 'scroll' | 'section' | 'page'
	var _ftActiveSec  = 'I';
	var _ftSections   = ['I','II','III','IV','V'];


	// Wrap highlight-view content in per-section divs (run once after build)
	function _wrapHlSections() {
		var hlCont = document.getElementById('ft-highlight-view');
		if (!hlCont || hlCont.dataset.secWrapped) return;
		hlCont.dataset.secWrapped = '1';
		var nodes = Array.from(hlCont.childNodes);
		var wrapper = null;
		nodes.forEach(function(node) {
			if (node.nodeType === 1 && node.classList && node.classList.contains('ft-section-num')) {
				wrapper = document.createElement('div');
				wrapper.className = 'ft-hl-section';
				wrapper.dataset.section = node.textContent.trim();
				hlCont.appendChild(wrapper);
			}
			if (wrapper) wrapper.appendChild(node);
			// Nodes before first section header stay at root — that's fine (there are none here)
		});
	}

	function _setFtReadMode(mode) {
		_ftReadMode = mode;
		document.querySelectorAll('.ft-read-mode-btn').forEach(function(btn) {
			btn.classList.toggle('active', btn.dataset.rmode === mode);
		});
		var prevBtn  = document.getElementById('ft-sec-prev');
		var nextBtn  = document.getElementById('ft-sec-next');
		var posLabel = document.getElementById('ft-read-pos-label');
		var hlCont   = document.getElementById('ft-highlight-view');

		if (mode === 'scroll') {
			if (hlCont)   hlCont.classList.remove('ft-page-mode');
			// Restore all hidden sections
			if (hlCont)   hlCont.querySelectorAll('.ft-hl-section.ft-sec-hide').forEach(function(b) { b.classList.remove('ft-sec-hide'); });
			document.querySelectorAll('.ft-sec-btn.ft-sec-active').forEach(function(b) { b.classList.remove('ft-sec-active'); });
			if (prevBtn)  prevBtn.style.display  = 'none';
			if (nextBtn)  nextBtn.style.display  = 'none';
			if (posLabel) posLabel.style.display = 'none';
		} else if (mode === 'section') {
			if (hlCont)   hlCont.classList.remove('ft-page-mode');
			if (prevBtn)  prevBtn.style.display  = 'inline-block';
			if (nextBtn)  nextBtn.style.display  = 'inline-block';
			if (posLabel) posLabel.style.display = 'inline-block';
			_applyFtSectionFilter(_ftActiveSec);
		} else if (mode === 'page') {
			// Show all sections first
			if (hlCont)   hlCont.querySelectorAll('.ft-hl-section.ft-sec-hide').forEach(function(b) { b.classList.remove('ft-sec-hide'); });
			document.querySelectorAll('.ft-sec-btn.ft-sec-active').forEach(function(b) { b.classList.remove('ft-sec-active'); });
			if (hlCont)   hlCont.classList.add('ft-page-mode');
			if (prevBtn)  prevBtn.style.display  = 'inline-block';
			if (nextBtn)  nextBtn.style.display  = 'inline-block';
			if (posLabel) posLabel.style.display = 'inline-block';
			_updatePageLabel();
		}
	}

	function _applyFtSectionFilter(sec) {
		_ftActiveSec = sec;
		var hlCont   = document.getElementById('ft-highlight-view');

		if (hlCont) {
			_wrapHlSections();
			hlCont.querySelectorAll('.ft-hl-section').forEach(function(wrap) {
				wrap.classList.toggle('ft-sec-hide', wrap.dataset.section !== sec);
			});
			hlCont.scrollTop = 0;
		}
		document.querySelectorAll('.ft-sec-btn').forEach(function(btn) {
			btn.classList.toggle('ft-sec-active', btn.dataset.sec === sec);
		});
		var posLabel = document.getElementById('ft-read-pos-label');
		if (posLabel) posLabel.textContent = 'Section ' + sec + '\u2009/\u2009' + _ftSections.length;
	}

	function _getActiveFtView() {
		return document.getElementById('ft-highlight-view');
	}

	function _updatePageLabel() {
		var posLabel = document.getElementById('ft-read-pos-label');
		if (!posLabel) return;
		var el = _getActiveFtView();
		if (!el) return;
		var maxScroll = el.scrollHeight - el.clientHeight;
		var pct = maxScroll > 0 ? Math.round(el.scrollTop / maxScroll * 100) : 0;
		posLabel.textContent = pct + '%';
	}

	function _ftPageNav(dir) {
		var el = _getActiveFtView();
		if (!el) return;
		// Advance by clientHeight minus a 40px gutter so partial lines
		// at the bottom always carry over to the top of the next screen.
		var step = Math.max(el.clientHeight - 40, 40);
		el.scrollTop += dir * step;
		setTimeout(_updatePageLabel, 50);
	}

	function _ftSectionNav(dir) {
		var idx = _ftSections.indexOf(_ftActiveSec);
		var newIdx = idx + dir;
		if (newIdx >= 0 && newIdx < _ftSections.length) {
			_applyFtSectionFilter(_ftSections[newIdx]);
		}
	}

	function initReadingControls() {
		if (_readingControlsInited) return;
		_readingControlsInited = true;

		// Annotation checkboxes → show/hide sections in #ft-annot-body
		document.querySelectorAll('input[data-annot]').forEach(function(cb) {
			cb.addEventListener('change', function() {
				var body = document.getElementById('ft-annot-body');
				var panel = document.getElementById('ft-annot-panel');
				var container = body || panel;
				if (!container) return;
				var sec = container.querySelector('[data-annot="' + cb.dataset.annot + '"]');
				if (sec) sec.style.display = cb.checked ? '' : 'none';
			});
		});

		// Style radios removed — always 'full' detail; set data-style on highlight view once
		(function() {
			var hlv = document.getElementById('ft-highlight-view');
			if (hlv) hlv.dataset.style = 'full';
		}());

		// Markup controls — Narrative radio + flashforward/flashback checkboxes
		(function() {
			var hl = document.getElementById('ft-highlight-view');
			var narrativeOpts = document.getElementById('ft-markup-narrative-opts');
			var narrativeRadio = document.getElementById('ft-markup-narrative');
			var ffCheck  = document.getElementById('ft-markup-flashforward');
			var fbCheck  = document.getElementById('ft-markup-flashback');
			var linCheck = document.getElementById('ft-markup-linear');

			function applyMarkup() {
				if (!hl) return;
				var narrativeOn = narrativeRadio && narrativeRadio.checked;
				hl.classList.toggle('ft-show-flashforward', narrativeOn && ffCheck  && ffCheck.checked);
				hl.classList.toggle('ft-show-flashback',    narrativeOn && fbCheck  && fbCheck.checked);
				hl.classList.toggle('ft-show-linear',       narrativeOn && linCheck && linCheck.checked);
			}

			if (narrativeRadio) {
				narrativeRadio.addEventListener('change', function() {
					if (narrativeOpts) narrativeOpts.style.display = narrativeRadio.checked ? '' : 'none';
					if (!narrativeRadio.checked) {
						hl.classList.remove('ft-show-flashforward','ft-show-flashback','ft-show-linear');
					} else {
						applyMarkup();
					}
				});
			}
			if (ffCheck)  ffCheck.addEventListener('change',  applyMarkup);
			if (fbCheck)  fbCheck.addEventListener('change',  applyMarkup);
			if (linCheck) linCheck.addEventListener('change', applyMarkup);
		}());

		// Markup controls — Narrative Status
		(function() {
			var hl           = document.getElementById('ft-highlight-view');
			var nsOpts       = document.getElementById('ft-markup-ns-opts');
			var nsRadio      = document.getElementById('ft-markup-ns');
			var narrativeOpts  = document.getElementById('ft-markup-narrative-opts');
			var narrativeRadio = document.getElementById('ft-markup-narrative');

			// Canonical DY narrative status order (matches pie colorway)
			var NS_LIST = ['Narrated','Told','Remembered','Hypothesized','Narrated+Consciousness'];

			// Which statuses are present in this text?
			var presentNs = {};
			reEventsList.forEach(function(ev) {
				var ns = (ev.narrative_status || '').trim();
				if (ns) presentNs[ns] = true;
			});

			// Build item list
			if (nsOpts) {
				var html = '';
				NS_LIST.forEach(function(ns, i) {
					var color = DY_COLORWAY[i % DY_COLORWAY.length];
					var avail = !!presentNs[ns];
					var cbId  = 'ft-ns-cb-' + ns.replace(/[^a-zA-Z0-9]/g, '_');
					html += '<label class="ft-ns-item ' + (avail ? 'ft-ns-avail' : 'ft-ns-unavail') + '"'
						+ ' data-ns="' + ns + '" data-color="' + color + '">'
						+ '<input type="checkbox" id="' + cbId + '"' + (avail ? '' : ' disabled') + '>'
						+ '<span class="ft-ns-swatch" style="background:' + color + '"></span>'
						+ ' ' + ns + '</label>';
				});
				nsOpts.innerHTML = html;

				function _rebuildNsStyle() {
					var styleEl = document.getElementById('ft-ns-style');
					if (!styleEl) {
						styleEl = document.createElement('style');
						styleEl.id = 'ft-ns-style';
						document.head.appendChild(styleEl);
					}
					var ftStyle = 'full'; // styling radios removed
					var rules = [];
					nsOpts.querySelectorAll('.ft-ns-avail input:checked').forEach(function(cb) {
						var item = cb.closest('.ft-ns-item');
						var color = item.dataset.color;
						var sel = '#ft-highlight-view.ft-ns-mode .ft-hl-span[data-ns="' + item.dataset.ns + '"]';
						if (ftStyle === 'minimal') {
							rules.push(sel + ' { border-bottom: 1px solid ' + color + 'b3; -webkit-box-decoration-break: clone; box-decoration-break: clone; }');
						} else if (ftStyle === 'full') {
							rules.push(sel + ' { color: ' + color + ' !important; border-bottom: 1px solid ' + color + '; -webkit-box-decoration-break: clone; box-decoration-break: clone; }');
						} else {
							rules.push(sel + ' { color: ' + color + ' !important; }');
						}
					});
					if (hl) hl.classList.toggle('ft-ns-mode', rules.length > 0);
					styleEl.textContent = rules.join('\n');
				}

				nsOpts.addEventListener('change', function(e) {
					if (e.target.type === 'checkbox') _rebuildNsStyle();
				});
				document.addEventListener('ft-style-change', function() {
					if (nsOpts.querySelectorAll('.ft-ns-avail input:checked').length > 0) _rebuildNsStyle();
				});
			}

			function _clearNs() {
				if (nsOpts) nsOpts.querySelectorAll('input[type="checkbox"]').forEach(function(cb) { cb.checked = false; });
				if (hl) hl.classList.remove('ft-ns-mode');
				var styleEl = document.getElementById('ft-ns-style');
				if (styleEl) styleEl.textContent = '';
			}

			// NS checkbox → show/hide ns opts; clear when unchecked
			if (nsRadio) {
				nsRadio.addEventListener('change', function() {
					if (nsOpts) nsOpts.style.display = nsRadio.checked ? '' : 'none';
					if (!nsRadio.checked) _clearNs();
				});
			}
		}()); // end Narrative Status IIFE

		// Markup controls — Temporality
		(function() {
			var NARRATIVE_PRESENT = DY_TEXT.narrativePresent;
			var hl       = document.getElementById('ft-highlight-view');
			var tempCb   = document.getElementById('ft-markup-temporality');
			var tempOpts = document.getElementById('ft-markup-temporality-opts');

			var TEMP_LIST = [
				{ key: 'past',    label: 'Past',    color: '#9d4040' },
				{ key: 'present', label: 'Present', color: '#c8bfa8' },
				{ key: 'future',  label: 'Future',  color: '#34584d' }
			];

			if (tempOpts) {
				var html = '';
				TEMP_LIST.forEach(function(t) {
					var cbId = 'ft-temp-cb-' + t.key;
					html += '<label class="ft-ns-item ft-ns-avail" data-temporality="' + t.key + '" data-color="' + t.color + '">'
						+ '<input type="checkbox" id="' + cbId + '">'
						+ '<span class="ft-ns-swatch" style="background:' + t.color + '"></span>'
						+ ' ' + t.label + ' (<span style="font-size:0.82em;opacity:0.7">' + (t.key === 'past' ? 'before ' : t.key === 'future' ? 'after ' : '') + NARRATIVE_PRESENT + '</span>)</label>';
				});
				tempOpts.innerHTML = html;

				function _rebuildTempStyle() {
					var styleEl = document.getElementById('ft-temp-style');
					if (!styleEl) {
						styleEl = document.createElement('style');
						styleEl.id = 'ft-temp-style';
						document.head.appendChild(styleEl);
					}
					var ftStyle = 'full'; // styling radios removed
					var checked = tempOpts.querySelectorAll('input:checked');
					var rules = [];
					checked.forEach(function(cb) {
						var item  = cb.closest('.ft-ns-item');
						var tkey  = item.dataset.temporality;
						var color = item.dataset.color;
						var sel   = '#ft-highlight-view.ft-temp-mode .ft-hl-span[data-temporality="' + tkey + '"]';
						if (ftStyle === 'minimal') {
							rules.push(
								sel + ' {'
								+ ' padding-left: 6px;'
								+ ' border-left: 2px solid ' + color + '66;'
								+ ' -webkit-box-decoration-break: clone;'
								+ ' box-decoration-break: clone;'
								+ '}'
							);
						} else {
							var sw  = ftStyle === 'full' ? '2.5' : '1.5';
							var svg = encodeURIComponent(
								'<svg xmlns="http://www.w3.org/2000/svg" width="6" height="10">'
								+ '<path d="M3 0 Q6 2.5 3 5 Q0 7.5 3 10" stroke="' + color + '" fill="none" stroke-width="' + sw + '"/>'
								+ '</svg>'
							);
							rules.push(
								sel + ' {'
								+ ' padding-left: 8px;'
								+ ' background-image: url("data:image/svg+xml,' + svg + '");'
								+ ' background-repeat: repeat-y;'
								+ ' background-size: 6px 10px;'
								+ ' background-position: left top;'
								+ ' -webkit-box-decoration-break: clone;'
								+ ' box-decoration-break: clone;'
								+ '}'
							);
						}
					});
					if (hl) hl.classList.toggle('ft-temp-mode', checked.length > 0);
					styleEl.textContent = rules.join('\n');
				}

				tempOpts.addEventListener('change', function(e) {
					if (e.target.type === 'checkbox') _rebuildTempStyle();
				});
				document.addEventListener('ft-style-change', function() {
					if (tempOpts.querySelectorAll('input:checked').length > 0) _rebuildTempStyle();
				});
			}

			function _clearTemp() {
				if (tempOpts) tempOpts.querySelectorAll('input[type="checkbox"]').forEach(function(cb) { cb.checked = false; });
				if (hl) hl.classList.remove('ft-temp-mode');
				var styleEl = document.getElementById('ft-temp-style');
				if (styleEl) styleEl.textContent = '';
			}

			if (tempCb) {
				tempCb.addEventListener('change', function() {
					if (tempOpts) tempOpts.style.display = tempCb.checked ? '' : 'none';
					if (!tempCb.checked) _clearTemp();
				});
			}
		}()); // end Temporality IIFE

		// Tab nav — only Text (highlight) remains
		document.querySelectorAll('.ft-reading-tab').forEach(function(tab) {
			tab.addEventListener('click', function() {
				document.querySelectorAll('.ft-reading-tab').forEach(function(t) { t.classList.remove('active'); });
				tab.classList.add('active');
				_activatePanelTab('text-hl');
				if (_ftReadMode !== 'scroll') _setFtReadMode(_ftReadMode);
			});
		});

		// Inject controls-panel header + ghost stub (shared class pattern)
		(function() {
			var ctrl   = document.getElementById('dy-controls-panel');
			var layout = document.getElementById('ft-layout');
			if (!ctrl || !layout || document.getElementById('ft-ctrl-header')) return;

			// Header bar
			var hdr = document.createElement('div');
			hdr.id = 'ft-ctrl-header';
			hdr.className = 'ft-panel-header';
			hdr.innerHTML = '<span class="ft-panel-header-label">Settings</span>'
				+ '<button id="ft-ctrl-toggle-btn" class="ft-panel-collapse-btn" title="Hide settings panel">&#8249;</button>';
			ctrl.insertBefore(hdr, ctrl.firstChild);

			// Ghost stub — inserted right after the controls panel
			var ghost = document.createElement('div');
			ghost.id = 'ft-ctrl-ghost';
			ghost.className = 'ft-panel-ghost';
			ghost.innerHTML = '<button id="ft-ctrl-ghost-expand" class="ft-panel-ghost-expand" title="Show settings panel">&#8250;</button>'
				+ '<span class="ft-panel-ghost-label">Settings</span>';
			layout.insertBefore(ghost, ctrl.nextSibling);

			function _toggleCtrl() {
				var collapsed = layout.classList.toggle('ft-ctrl-collapsed');
				var btn = document.getElementById('ft-ctrl-toggle-btn');
				if (btn) { btn.innerHTML = collapsed ? '&#8250;' : '&#8249;'; btn.title = collapsed ? 'Show settings panel' : 'Hide settings panel'; }
			}
			document.getElementById('ft-ctrl-toggle-btn').addEventListener('click', _toggleCtrl);
			document.getElementById('ft-ctrl-ghost-expand').addEventListener('click', _toggleCtrl);
		}());

		// Inject annotation-panel ghost stub (header built by initAnnotPanelHeader)
		(function() {
			var layout = document.getElementById('ft-layout');
			var annotPnl = document.getElementById('ft-annot-panel');
			if (!layout || !annotPnl || document.getElementById('ft-annot-ghost')) return;

			var ghost = document.createElement('div');
			ghost.id = 'ft-annot-ghost';
			ghost.className = 'ft-panel-ghost';
			ghost.innerHTML = '<button id="ft-annot-ghost-expand" class="ft-panel-ghost-expand" title="Show annotation panel">&#8249;</button>'
				+ '<span class="ft-panel-ghost-label">Annotations</span>';
			layout.insertBefore(ghost, annotPnl);

			document.getElementById('ft-annot-ghost-expand').addEventListener('click', _toggleAnnotPanel);
		}());

		// Reading mode toggle buttons
		document.querySelectorAll('.ft-read-mode-btn').forEach(function(btn) {
			btn.addEventListener('click', function() { _setFtReadMode(btn.dataset.rmode); });
		});

		// Prev / next (section or page)
		var prevBtn = document.getElementById('ft-sec-prev');
		var nextBtn = document.getElementById('ft-sec-next');
		if (prevBtn) prevBtn.addEventListener('click', function() {
			if (_ftReadMode === 'section') _ftSectionNav(-1);
			else if (_ftReadMode === 'page') _ftPageNav(-1);
		});
		if (nextBtn) nextBtn.addEventListener('click', function() {
			if (_ftReadMode === 'section') _ftSectionNav(1);
			else if (_ftReadMode === 'page') _ftPageNav(1);
		});

		// Exit button → return to map-text mode
		var exitBtn = document.getElementById('ft-exit-btn');
		if (exitBtn) {
			exitBtn.addEventListener('click', function() {
				var reading = document.getElementById('ft-reading');
				if (reading) { reading.classList.remove('active'); }
				// Uncheck the fulltext radio and switch to map-text
				var radios = document.querySelectorAll('input[name="dy-display"]');
				radios.forEach(function(r) { if (r.value === 'map-text') r.checked = true; });
				setDisplayMode('map-text');
			});
		}
	}

	function _ftStyle() {
		return 'full'; // styling radios removed; always use full detail level
	}

	function _clearKwActivePills() {
		document.querySelectorAll('.ft-kw-term.ft-kw-active').forEach(function(p) { p.classList.remove('ft-kw-active'); });
		if (_doKwSearch) _doKwSearch('');
	}

	// ── Horizontal detail popup ──────────────────────────────────
	var _hPopup     = null;
	var _hPopupRow  = null; // the row that triggered the popup

	function _closeHPopup() {
		if (_hPopup && _hPopup.parentNode) _hPopup.parentNode.removeChild(_hPopup);
		_hPopup = null;
		if (_hPopupRow) { _hPopupRow.classList.remove('expanded'); _hPopupRow = null; }
	}

	function _showHDetailPopup(row) {
		_closeHPopup();
		var detail = row.querySelector('.fa-detail');
		if (!detail) return;
		var rect = row.getBoundingClientRect();
		var popup = document.createElement('div');
		popup.className = 'fa-h-popup';
		popup.innerHTML = detail.innerHTML;
		document.body.appendChild(popup);
		// Position: top-aligned with row, to the RIGHT of the annotation panel
		var left = rect.right + 10;
		var popupH = popup.offsetHeight || 200;
		var top  = Math.min(rect.top, window.innerHeight - popupH - 8);
		// Clamp to viewport right edge
		var popupW = popup.offsetWidth || 280;
		if (left + popupW > window.innerWidth - 4) left = window.innerWidth - popupW - 4;
		popup.style.left = Math.max(4, left) + 'px';
		popup.style.top  = Math.max(4, top) + 'px';
		_hPopup    = popup;
		_hPopupRow = row;
		row.classList.add('expanded');
		// Close on outside click (deferred so this click doesn't immediately close)
		setTimeout(function() {
			function outsideClose(e) {
				if (!_hPopup) { document.removeEventListener('click', outsideClose); return; }
				if (!_hPopup.contains(e.target) && !row.contains(e.target)) {
					_closeHPopup();
					document.removeEventListener('click', outsideClose);
				}
			}
			document.addEventListener('click', outsideClose);
		}, 0);
	}

	// ── Annotation layout (Horizontal / Vertical) ────────────────
	var _annotLayout = 'horizontal'; // 'horizontal' | 'vertical'
	var _vertPopup   = null;         // currently open inline popup element

	function _closeVertPopup() {
		if (_vertPopup) {
			if (_vertPopup.parentNode) _vertPopup.parentNode.removeChild(_vertPopup);
			_vertPopup = null;
		}
	}

	// Build (once) the persistent toggle header at the top of #ft-annot-panel.
	// Creates #ft-annot-layout-toggle and #ft-annot-body inside the panel.
	function initAnnotPanelHeader() {
		var panel = document.getElementById('ft-annot-panel');
		if (!panel || panel.querySelector('#ft-annot-layout-toggle')) return;

		var hdr = document.createElement('div');
		hdr.id = 'ft-annot-layout-toggle';
		hdr.className = 'ft-panel-header';
		hdr.innerHTML =
			'<span class="ft-annot-layout-label ft-panel-header-label">Annotations</span>' +
			'<span class="ft-annot-layout-label" style="color:#bbb;font-weight:400;text-transform:none;letter-spacing:0;margin:0 2px">|</span>' +
			'<span class="ft-annot-layout-label" style="color:#bbb;font-weight:400;text-transform:none;letter-spacing:0;font-size:9px">Layout</span>' +
			'<button class="ft-annot-layout-btn' + (_annotLayout === 'horizontal' ? ' active' : '') + '" data-layout="horizontal" title="Show annotations in the right sidebar panel">' +
			'<svg xmlns="http://www.w3.org/2000/svg" width="11" height="11" fill="currentColor" viewBox="0 0 16 16"><path d="M0 3a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H2a2 2 0 0 1-2-2zm5-1v12h9a1 1 0 0 0 1-1V3a1 1 0 0 0-1-1zM4 2H2a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h2z"/></svg>' +
			' H</button>' +
			'<button class="ft-annot-layout-btn' + (_annotLayout === 'vertical' ? ' active' : '') + '" data-layout="vertical" title="Expand annotations inline below the clicked text">' +
			'<svg xmlns="http://www.w3.org/2000/svg" width="11" height="11" fill="currentColor" viewBox="0 0 16 16"><path fill-rule="evenodd" d="M8 1a.5.5 0 0 1 .5.5v11.793l3.146-3.147a.5.5 0 0 1 .708.708l-4 4a.5.5 0 0 1-.708 0l-4-4a.5.5 0 0 1 .708-.708L7.5 13.293V1.5A.5.5 0 0 1 8 1"/></svg>' +
			' V</button>' +
			'<button id="ft-annot-collapse-btn" class="ft-panel-collapse-btn" title="Hide annotation panel">&#8250;</button>';

		var body = document.createElement('div');
		body.id = 'ft-annot-body';
		if (_annotLayout === 'horizontal') body.classList.add('fa-layout-h');

		panel.innerHTML = '';
		panel.appendChild(hdr);
		panel.appendChild(body);

		// Wire layout toggle buttons
		hdr.querySelectorAll('.ft-annot-layout-btn').forEach(function(btn) {
			btn.addEventListener('click', function() {
				_annotLayout = btn.dataset.layout;
				hdr.querySelectorAll('.ft-annot-layout-btn').forEach(function(b) {
					b.classList.toggle('active', b.dataset.layout === _annotLayout);
				});
				var b2 = document.getElementById('ft-annot-body');
				if (b2) b2.classList.toggle('fa-layout-h', _annotLayout === 'horizontal');
				if (_annotLayout !== 'vertical') _closeVertPopup();
				if (_annotLayout !== 'horizontal') _closeHPopup();
			});
		});

		// Wire collapse button (wired once; ghost may not exist yet — use layout toggle)
		var collapseBtn = document.getElementById('ft-annot-collapse-btn');
		if (collapseBtn) {
			collapseBtn.addEventListener('click', _toggleAnnotPanel);
		}
	}

	function _toggleAnnotPanel() {
		var layout = document.getElementById('ft-layout');
		if (!layout) return;
		var collapsed = layout.classList.toggle('ft-annot-collapsed');
		var btn = document.getElementById('ft-annot-collapse-btn');
		if (btn) {
			btn.innerHTML = collapsed ? '&#8249;' : '&#8250;';
			btn.title = collapsed ? 'Show annotation panel' : 'Hide annotation panel';
		}
		// Ghost expand button keeps icon facing ›
		var ghostBtn = document.getElementById('ft-annot-ghost-expand');
		if (ghostBtn) ghostBtn.innerHTML = collapsed ? '&#8249;' : '&#8249;';
	}

	function clearReadingAnnotation() {
		_closeVertPopup();
		_closeHPopup();
		initAnnotPanelHeader();
		var body  = document.getElementById('ft-annot-body');
		var panel = document.getElementById('ft-annot-panel');
		var target = body || panel;
		if (target) {
			target.innerHTML = '<p class="ft-annot-help">Click on a text event to see annotations.</p>';
		}
		if (panel) panel.style.display = '';
		// Remove locked highlight from all spans
		var hlCont = document.getElementById('ft-highlight-view');
		if (hlCont) hlCont.querySelectorAll('.ft-hl-span.ft-hl-locked').forEach(function(s) { s.classList.remove('ft-hl-locked'); });
		_clearKwActivePills();
		_annotatedNid = null;
	}

	function showReadingAnnotation(ev, triggerEl) {
		var panel = document.getElementById('ft-annot-panel');
		if (!panel) return;
		initAnnotPanelHeader();
		// If switching to a different event, deactivate any active keyword pill
		if (_annotatedNid !== null && _annotatedNid !== String(ev.event_nid)) {
			_clearKwActivePills();
			_closeVertPopup();
		}
		_annotatedNid = String(ev.event_nid);
		panel.style.display = ''; // let CSS flex layout take over (panel is inside #ft-layout)

		var style    = 'full'; // always full detail; styling radios removed
		var present  = idsToChars(ev.characters_present  || '');
		var mentioned= idsToChars(ev.characters_mentioned || '');
		var mentOnly = mentioned.filter(function(c) {
			return !present.some(function(p) { return p.id === c.id; });
		});
		var locData  = locByTitle[ev.event_location || ''] || {};

		function iconImg(src) {
			return '<img class="fa-icon" src="' + src + '" alt="">';
		}
		function charIcon(ch) {
			return iconImg(charIconUrl(ch));
		}
		function locIcon(lt) {
			return iconImg(locIconUrl(lt));
		}

		// ── Character row builder — name only; click to expand details ─
		function charRow(ch) {
			var meta = [ch.race, ch.gender, ch['class'], ch.family].filter(Boolean).join(' · ');
			var hasDetail = meta || ch.biography;
			var row = '<div class="fa-row' + (hasDetail ? ' fa-expandable' : '') + '">';
			row += charIcon(ch);
			row += '<div class="fa-row-body">';
			row += '<div class="fa-name-line"><span class="fa-name">' + esc(ch.name) + '</span>';
			if (hasDetail) row += '<span class="fa-expand-icon">&#9654;</span>';
			row += '</div>';
			if (hasDetail) {
				row += '<div class="fa-detail">';
				if (meta) row += '<div class="fa-meta">' + esc(meta) + '</div>';
				if (ch.biography) row += '<div class="fa-desc">' + esc(ch.biography) + '</div>';
				row += '</div>';
			}
			row += '</div></div>';
			return row;
		}

		// ── Location block — name only; click to expand details ─────
		function locBlock() {
			var hasDetail = locData.location_type || locData.description;
			var h = '<div class="fa-section" data-annot="locations">';
			h += '<div class="fa-heading">Location</div>';
			h += '<div class="fa-row' + (hasDetail ? ' fa-expandable' : '') + '">';
			h += locIcon(locData.location_type || '');
			h += '<div class="fa-row-body">';
			h += '<div class="fa-name-line"><span class="fa-name">' + esc(ev.event_location || '—') + '</span>';
			if (hasDetail) h += '<span class="fa-expand-icon">&#9654;</span>';
			h += '</div>';
			if (hasDetail) {
				h += '<div class="fa-detail">';
				if (locData.location_type) h += '<div class="fa-meta">' + esc(locData.location_type) + '</div>';
				if (locData.description) h += '<div class="fa-desc">' + esc(locData.description) + '</div>';
				if (locData.in_yok !== undefined) {
					h += '<div class="fa-meta">' + (locData.location_type === 'OutOfYoknapatawpha' ? 'Outside Yoknapatawpha' : 'In Yoknapatawpha') + '</div>';
				}
				h += '</div>';
			}
			h += '</div></div></div>';
			return h;
		}

		// ── Characters block ──────────────────────────────────────
		function charsBlock() {
			if (!present.length && !mentOnly.length) return '';
			var h = '<div class="fa-section" data-annot="characters">';
			h += '<div class="fa-heading">Characters</div>';
			if (present.length) {
				h += '<div class="fa-subheading">Present</div>';
				present.forEach(function(ch) { h += charRow(ch); });
			}
			if (mentOnly.length) {
				h += '<div class="fa-subheading">Mentioned</div>';
				mentOnly.forEach(function(ch) { h += charRow(ch); });
			}
			h += '</div>';
			return h;
		}

		// ── Events block — always shows summary + metadata ───────────
		function evBlock() {
			var h = '<div class="fa-section" data-annot="events">';
			h += '<div class="fa-heading">Event</div>';
			if (ev.first_words) h += '<div class="fa-meta fa-first-words">&ldquo;' + esc(ev.first_words) + '&hellip;&rdquo;</div>';
			h += '<div class="fa-desc">' + esc(ev.summary || '') + '</div>';
			if (ev.event_date) h += '<div class="fa-meta">' + esc(ev.event_date) + '</div>';
			if (ev.narrative_status) h += '<div class="fa-meta">' + esc(ev.narrative_status) + '</div>';
			h += '</div>';
			return h;
		}

		// ── Keywords block ────────────────────────────────────────
		function kwBlock() {
			var nid = String(ev.event_nid);
			var kwData = reEventKeywords[nid];
			if (!kwData) return '';
			var colOrder = ['Actions','Aesthetics','Cultural Issues','Environment','Relationships','Themes and Motifs'];
			var h = '<div class="fa-section" data-annot="keywords">';
			h += '<div class="fa-heading">Keywords</div>';

			function kwCount(term) {
				var idx = reKeywordIndex && reKeywordIndex.index && reKeywordIndex.index[term];
				return idx ? ' <span class="ft-kw-count">(' + idx.length + ')</span>' : '';
			}

			if (style === 'minimal') {
				// Flat list of leaf terms only
				var terms = [];
				colOrder.forEach(function(col) {
					if (!kwData[col]) return;
					kwData[col].forEach(function(pair) { terms.push(pair[1]); });
				});
				h += '<div class="ft-kw-minimal">';
				terms.forEach(function(t) {
					h += '<span class="ft-kw-term" data-term="' + esc(t) + '">' + esc(t) + kwCount(t) + '</span>';
				});
				h += '</div>';

			} else if (style === 'summary') {
				// Column headings with leaf terms below each
				colOrder.forEach(function(col) {
					if (!kwData[col] || !kwData[col].length) return;
					h += '<div class="ft-kw-group">';
					h += '<div class="ft-kw-col-label">' + esc(col) + '</div>';
					h += '<div class="ft-kw-terms">';
					kwData[col].forEach(function(pair) {
						var t = pair[1];
						h += '<span class="ft-kw-term" data-term="' + esc(t) + '">' + esc(t) + kwCount(t) + '</span>';
					});
					h += '</div></div>';
				});

			} else { // full
				// Column headings, then "Secondary > Term" entries
				colOrder.forEach(function(col) {
					if (!kwData[col] || !kwData[col].length) return;
					h += '<div class="ft-kw-group">';
					h += '<div class="ft-kw-col-label">' + esc(col) + '</div>';
					h += '<div class="ft-kw-terms">';
					kwData[col].forEach(function(pair) {
						var t = pair[1];
						var label = pair[0] ? esc(pair[0]) + ' &rsaquo; ' + esc(t) : esc(t);
						h += '<span class="ft-kw-term ft-kw-full" data-term="' + esc(t) + '">' + label + kwCount(t) + '</span>';
					});
					h += '</div></div>';
				});
			}

			h += '</div>';
			return h;
		}

		var contentHtml = locBlock() + charsBlock() + evBlock() + kwBlock();

		// Determine target container based on layout mode
		var target;
		if (_annotLayout === 'vertical') {
			// Build an inline popup inserted after the last span for this NID (or the trigger span)
			_closeVertPopup();
			var hlCont2 = document.getElementById('ft-highlight-view');
			var nidSpans = hlCont2
				? Array.from(hlCont2.querySelectorAll('.ft-hl-span[data-nid="' + _annotatedNid + '"]'))
				: [];
			var insertAfter = nidSpans.length ? nidSpans[nidSpans.length - 1] : (triggerEl || null);

			var popup = document.createElement('div');
			popup.className = 'ft-inline-popup';
			popup.innerHTML = '<button class="ft-ip-close" title="Close">&#x2715;</button>' + contentHtml;

			if (insertAfter && insertAfter.parentNode) {
				insertAfter.parentNode.insertBefore(popup, insertAfter.nextSibling);
			}
			_vertPopup = popup;

			popup.querySelector('.ft-ip-close').addEventListener('click', function() {
				_closeVertPopup();
				_annotatedNid = null;
				var hlC = document.getElementById('ft-highlight-view');
				if (hlC) hlC.querySelectorAll('.ft-hl-span.ft-hl-locked').forEach(function(s) { s.classList.remove('ft-hl-locked'); });
			});

			// Click-outside-to-close (deferred so the triggering click doesn't immediately close)
			var _popupRef = popup;
			setTimeout(function() {
				function outsideClose(e) {
					if (!_popupRef.parentNode) { document.removeEventListener('click', outsideClose); return; }
					if (!_popupRef.contains(e.target)) {
						_closeVertPopup();
						_annotatedNid = null;
						var hlC = document.getElementById('ft-highlight-view');
						if (hlC) hlC.querySelectorAll('.ft-hl-span.ft-hl-locked').forEach(function(s) { s.classList.remove('ft-hl-locked'); });
						document.removeEventListener('click', outsideClose);
					}
				}
				document.addEventListener('click', outsideClose);
			}, 0);

			target = popup;
		} else {
			// Horizontal mode: write to #ft-annot-body inside the panel
			var body = document.getElementById('ft-annot-body');
			target = body || panel;
			target.innerHTML = contentHtml;
		}

		// Wire click-to-expand on character and location rows
		target.querySelectorAll('.fa-row.fa-expandable').forEach(function(row) {
			row.addEventListener('click', function(e) {
				e.stopPropagation();
				if (_annotLayout === 'horizontal') {
					// Toggle: if this row is already open, close; otherwise open new popup
					if (_hPopupRow === row) { _closeHPopup(); } else { _showHDetailPopup(row); }
				} else {
					row.classList.toggle('expanded');
				}
			});
		});

		// Wire keyword term clicks → keyword search in highlight view
		target.querySelectorAll('.ft-kw-term').forEach(function(el) {
			el.addEventListener('click', function(e) {
				e.stopPropagation(); // prevent document outside-click handler from firing
				var term = el.dataset.term;
				if (!term) return;
				var isActive = el.classList.contains('ft-kw-active');
				// Deactivate all pills in target
				target.querySelectorAll('.ft-kw-term').forEach(function(p) { p.classList.remove('ft-kw-active'); });
				if (isActive) {
					// Re-clicking active pill → clear the search
					if (_doKwSearch) _doKwSearch('');
				} else {
					el.classList.add('ft-kw-active');
					// Switch toolbar to keyword mode and run search
					var modeSelect = document.getElementById('ft-search-mode');
					var input = document.getElementById('ft-search-input');
					if (modeSelect) {
						modeSelect.value = 'keyword';
						modeSelect.dispatchEvent(new Event('change', {bubbles: true}));
					}
					if (input) input.value = term;
					if (_doKwSearch) _doKwSearch(term);
				}
			});
		});
		// Apply current checkbox visibility state (horizontal only; vertical popup shows all)
		if (_annotLayout !== 'vertical') {
			document.querySelectorAll('input[data-annot]').forEach(function(cb) {
				var sec = target.querySelector('[data-annot="' + cb.dataset.annot + '"]');
				if (sec) sec.style.display = cb.checked ? '' : 'none';
			});
		}
		// Lock highlight on the matching span(s) in the highlight view
		var hlCont = document.getElementById('ft-highlight-view');
		if (hlCont) {
			hlCont.querySelectorAll('.ft-hl-span.ft-hl-locked').forEach(function(s) { s.classList.remove('ft-hl-locked'); });
			hlCont.querySelectorAll('.ft-hl-span[data-nid="' + _annotatedNid + '"]').forEach(function(s) { s.classList.add('ft-hl-locked'); });
		}
	}

	// ── Suppress default show_characters ─────────────────────────
	// In Map Only mode the native radios work; in other modes we take over.
	$(document).ready(function() {
		// ── Story catalog dropdown ────────────────────────────────
		(function initStoryCatalog() {
			var sel = document.getElementById('dy-story-select');
			if (!sel) return;
			// Current story code from URL ?text=XX
			var params = new URLSearchParams(window.location.search);
			var currentCode = (params.get('text') || DY_TEXT.code).toUpperCase();
			// Only the texts that exist as local mockups.
			var catalog = [
				{code:'SF', label:'The Sound and the Fury', type:'novel',
				 href:'../sound_and_the_fury_model/DIGITAL Yoknapatawpha.html?text=SF'},
				{code:'RE', label:'\u201cA Rose for Emily\u201d', type:'story',
				 href:'../a_rose_for_emily_model/DIGITAL Yoknapatawpha.html?text=RE'}
			];
			// Group headers
			var novelGroup = document.createElement('optgroup');
			novelGroup.label = 'Novels';
			var storyGroup = document.createElement('optgroup');
			storyGroup.label = 'Short Fiction';
			catalog.forEach(function(item) {
				var opt = document.createElement('option');
				opt.value = item.code;
				opt.textContent = item.label;
				if (item.code === currentCode) {
					opt.selected = true;
					opt.className = 'dy-story-current';
				}
				(item.type === 'novel' ? novelGroup : storyGroup).appendChild(opt);
			});
			sel.appendChild(novelGroup);
			sel.appendChild(storyGroup);
			sel.addEventListener('change', function() {
				var code = sel.value;
				if (code === currentCode) return;
				var item = catalog.filter(function(c) { return c.code === code; })[0];
				if (item) window.location.href = item.href;
			});
		})();
		var _origShowChars = typeof window.show_characters === 'function' ? window.show_characters : null;
		window._dyShowCharsOverride = true; // start in map-text mode
		window.show_characters = function() {
			if (!window._dyShowCharsOverride && _origShowChars) _origShowChars.apply(this, arguments);
		};
		// Wire Display Options radios (legacy, kept for compatibility)
		document.querySelectorAll('input[name="dy-display"]').forEach(function(r) {
			r.addEventListener('change', function() {
				if (r.checked) setDisplayMode(r.value);
			});
		});
		// Wire global nav buttons
		document.querySelectorAll('#dy-global-nav .dy-nav-btn').forEach(function(btn) {
			btn.addEventListener('click', function() {
				setDisplayMode(btn.dataset.mode);
			});
		});
		// Apply the default display mode on load
		setDisplayMode(dyDisplayMode);
		// ── Move zoom buttons to floating overlay at image coords (1600, 20) ─────
		(function createZoomPanel() {
			var c2 = document.getElementById('content_2');
			if (!c2) return;
			var zp = document.createElement('div');
			zp.id = 'dy-zoom-panel';
			var cb = document.querySelector('.control-buttons');
			if (cb) {
				cb.parentNode.removeChild(cb);
				zp.appendChild(cb);
				c2.appendChild(zp);
			}
		})();

		// ── Map canvas resize (S / M / L) ──────────────────────────
		function resizeMapCanvas(idx) {
			_mapSizeIdx = idx;
			var sz = _mapSizes[idx];
			var newScale = 0.305 * (sz.w / 800);

			// Resize Konva stage
			stage.width(sz.w);
			stage.height(sz.h);

			// Scale map layers proportionally
			backgroundLayer.scaleX(newScale);
			backgroundLayer.scaleY(newScale);
			contentLayer.scaleX(newScale);
			contentLayer.scaleY(newScale);

			// Reposition contentLayer to new stage center
			contentLayer.x((-1320 * newScale) + (sz.w / 2));
			contentLayer.y((-825  * newScale) + (sz.h / 2));

			// Sync heatLayer with contentLayer
			heatLayer.scaleX(newScale);
			heatLayer.scaleY(newScale);
			heatLayer.x(contentLayer.x());
			heatLayer.y(contentLayer.y());

			// Redraw all layers
			backgroundLayer.draw();
			contentLayer.draw();
			heatLayer.draw();
			drawSpatialHeatmap();

			layoutPanels();

			// Sync button active state
			document.querySelectorAll('.dy-map-size-btn').forEach(function(btn, i) {
				btn.classList.toggle('active', i === idx);
			});
		}
		document.querySelectorAll('.dy-map-size-btn').forEach(function(btn, i) {
			btn.addEventListener('click', function() { resizeMapCanvas(i); });
		});

		// Wire Autozoom (Fit) button — curated view centred on Yoknapatawpha locations
		document.getElementById('autozoom').addEventListener('click', function() {
			contentLayer.scaleX(1.305);
			contentLayer.scaleY(1.305);
			contentLayer.position({ x: -1284.6, y: -690.625 });
			contentLayer.draw();
			drawSpatialHeatmap();
		});

		// ── Relocate Controls into left-map sidebar panel ────────────
		// jQuery UI dialog is intercepted above, so #layer_dialog never moves.
		// We just create the panel and move #layer_dialog into it synchronously.
		(function attachControlsPanel() {
			var c2  = document.getElementById('content_2');
			var ldlg = document.getElementById('layer_dialog');
			if (!c2 || !ldlg) return;
			var panel = document.createElement('div');
			panel.id = 'dy-controls-panel';
			if (dyDisplayMode === 'map') panel.classList.add('dy-map-mode');
			c2.appendChild(panel);
			panel.appendChild(ldlg);
		})();
	});

	// ── Show panels + build list when events JSON loads ───────────
	$(document).ajaxComplete(function(event, xhr, settings) {
		if (settings.url && settings.url.indexOf(DY_TEXT.prefix + 'events.json') >= 0) {
			// In map-text mode, re-affirm the right panels are visible
			var fp = document.getElementById('fulltext-panel');
			if (fp && dyDisplayMode === 'map-text') fp.style.display = 'flex';
			var ip = document.getElementById('info-panel');
			if (ip && dyDisplayMode === 'map-text' && currentEv) ip.style.display = 'block';
			eventsReady = true;
			if (dataReady) buildEventList();
		}
	});
})();
