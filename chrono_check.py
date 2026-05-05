import csv, json, math

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
            'chrono': float(row.get('Chronological Order','0').strip() or 0)
        })

re_events.sort(key=lambda e: (e['page'], e['order']))
print('NID\tPage\tOrder\tChrono\tDiff\tType')
for i, ev in enumerate(re_events):
    if i == 0:
        print(f"{ev['nid']}\t{ev['page']}\t{ev['order']}\t{ev['chrono']}\t-\t-")
    else:
        prev = re_events[i-1]
        diff = ev['chrono'] - prev['chrono']
        t = 'flashback' if diff < 0 else ('flashforward' if math.floor(ev['chrono']) > math.floor(prev['chrono']) else 'seq')
        print(f"{ev['nid']}\t{ev['page']}\t{ev['order']}\t{ev['chrono']}\t{diff:+.2f}\t{t}")
