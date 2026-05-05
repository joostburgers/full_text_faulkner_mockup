import csv, json

with open('dy_data/events.csv', encoding='utf-8-sig') as f:
    reader = csv.DictReader(f)
    re_events = []
    for row in reader:
        if row.get('SourceTextCode') != 'RE':
            continue
        re_events.append({
            'nid': row['Nid'].strip(),
            'page': float(row.get('PageNumber','0').strip() or 0),
            'order': float(row.get('OrderWithinPage','0').strip() or 0),
            'chrono_raw': float(row.get('Chronological Order','0').strip() or 0)
        })

# Normalize: sort by raw chrono, assign sequential 1..N integers
chrono_sorted = sorted(re_events, key=lambda e: e['chrono_raw'])
for i, ev in enumerate(chrono_sorted):
    ev['chrono'] = i + 1
print(f'Normalized {len(re_events)} events to chrono 1..{len(re_events)}')

# Process in narrative order
narrative_order = sorted(re_events, key=lambda e: (e['page'], e['order']))

transitions = {}
print('Narrative order transitions:')
for i in range(1, len(narrative_order)):
    prev = narrative_order[i-1]
    curr = narrative_order[i]
    diff = curr['chrono'] - prev['chrono']
    if diff < 0:
        t = 'flashback'
    elif diff > 1:
        t = 'flashforward'
    else:
        t = None

    if t:
        transitions[curr['nid']] = t
        print(f"  {prev['nid']}(c{prev['chrono']}) -> {curr['nid']}(c{curr['chrono']}) diff={diff:+d} : {t}")

print(f"\nTotal: {len(transitions)} ({sum(1 for v in transitions.values() if v=='flashback')} flashbacks, {sum(1 for v in transitions.values() if v=='flashforward')} flashforwards)")

with open('a_rose_for_emily_model/data/re_event_transitions.json', 'w', encoding='utf-8') as f:
    json.dump(transitions, f, indent=2)
print('Saved re_event_transitions.json')
