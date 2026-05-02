import csv

missing = {'1804','1824','1840','1842','1845','2756'}
with open('dy_data/events.csv', encoding='utf-8-sig') as f:
    for row in csv.DictReader(f):
        if row['SourceTextCode'].strip()=='RE' and row['Nid'].strip() in missing:
            print(f"Nid {row['Nid']}: '{row['First 8-10 words of event'][:80]}'")
            print(f"  Summary: {row['Summary'][:200]}")
            print()

with open('dy_data/locations.csv', encoding='utf-8-sig') as f:
    r = csv.DictReader(f)
    print('locations cols:', r.fieldnames)
    re_locs = [row for row in r if row.get('SourceTextCode','').strip()=='RE']
    print(f'RE locations: {len(re_locs)}')
    if re_locs:
        print('Sample:', {k: re_locs[0][k] for k in ['LocationTitle','Display Label','True X','True Y','Type','Status']})
