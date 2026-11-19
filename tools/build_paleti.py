#!/usr/bin/env python3
"""Generează docs/paleti-data.js din „Lista_4752module_pe_paleti” (Excel).

Folosire:  python3 tools/build_paleti.py Lista_4752module_pe_paleti_rev01.xlsx docs/paleti-data.js
Necesită:  pip install openpyxl

Citește foaia „Căutare” (serie -> palet, clasă, observații) și foaia „Paleți” (observațiile paletului).
"""
import collections
import json
import sys

import openpyxl

SERIAL_PREFIX = 'A161098744B97'
PALLET_PREFIX = '6100001987-3-'


def main(src, dst):
    wb = openpyxl.load_workbook(src, data_only=True)
    rows = [r for r in wb['Căutare'].iter_rows(min_row=2, values_only=True) if r[0]]
    pal_notes = {str(r[0]): r[3] for r in wb['Paleți'].iter_rows(min_row=2, values_only=True) if r[0] and r[0] != 'TOTAL' and r[3]}

    serials = set()
    pallets = collections.OrderedDict()
    notes = {}
    for six, pal, cls, note, full, palfull in rows:
        six, pal, cls = str(six).strip(), str(pal).strip(), str(cls).strip()
        assert len(six) == 6 and six.isdigit(), six
        assert full == SERIAL_PREFIX + six, full
        assert palfull == PALLET_PREFIX + pal, palfull
        assert six not in serials, 'serie dublă ' + six
        serials.add(six)
        pallets.setdefault(pal, []).append((six, cls))
        if note:
            notes[six] = str(note).strip()

    out = {}
    for pal in sorted(pallets):
        mods = sorted(pallets[pal])
        main_cls = collections.Counter(c for _, c in mods).most_common(1)[0][0]
        entry = {'c': main_cls, 's': ' '.join(s for s, _ in mods)}
        other = {s: c for s, c in mods if c != main_cls}
        if other:
            entry['x'] = other
        if pal in pal_notes:
            entry['n'] = str(pal_notes[pal]).strip()
        out[pal] = entry

    total = sum(len(v) for v in pallets.values())
    data = {
        'sursa': 'Lista_4752module_pe_paleti_rev01',
        'prefixSerie': SERIAL_PREFIX,
        'prefixPalet': PALLET_PREFIX,
        'clase': {
            '720L': '720 W, curent mic (L)', '715L': '715 W, curent mic (L)',
            '710H': '710 W, curent mare (H)', '710L': '710 W, curent mic (L)',
        },
        'paleti': out,
        'observatii': notes,
    }
    with open(dst, 'w', encoding='utf-8') as f:
        f.write('// Generat de tools/build_paleti.py din lista modulelor pe paleți. Nu edita manual.\n')
        f.write('export const PALETI = ')
        json.dump(data, f, ensure_ascii=False, separators=(',', ':'))
        f.write(';\n')
    print('module', total, '| paleți', len(out), '| clase', dict(collections.Counter(c for v in pallets.values() for _, c in v)), '| observații', len(notes))


if __name__ == '__main__':
    main(sys.argv[1], sys.argv[2])
