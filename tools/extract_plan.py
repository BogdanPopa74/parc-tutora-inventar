#!/usr/bin/env python3
"""Extrage harta parcului din PDF-ul exportat din DWG și scrie docs/parc-data.js.

Folosire:  python3 tools/extract_plan.py plan.pdf docs/parc-data.js
Necesită:  pip install pdfplumber

Ce citește din PDF (planșe A3, scara 1:1500):
  pag. 4  - panourile (dreptunghiuri albastre) și conturul parcelei
  pag. 8  - invertoarele, PTAB-ul și cablurile DC (ce masă intră în ce invertor)
  pag. 11 - stâlpii de iluminat / supraveghere video
"""
import collections
import json
import math
import sys

import pdfplumber

M_PER_PT = 1500 * 25.4 / 72 / 1000          # scara 1:1500 -> metri pe punct PDF
PANEL_BLUE = (0.0, 0.431, 0.867)
BROWN = (0.722, 0.361, 0.0)
CABLE = {(1.0, 0.0, 0.0): 'R', (1.0, 0.498, 0.0): 'O', (0.0, 0.0, 1.0): 'B'}
COLS, TIERS = 14, 2                          # o masă = 2 rânduri x 14 panouri (2P)
MAP_BOTTOM = 700                             # sub această cotă (pt) sunt legenda și cartușul


def col(c):
    if c is None:
        return ()
    if isinstance(c, (int, float)):
        return (round(float(c), 3),)
    return tuple(round(float(x), 3) for x in c)


def bbox(pts):
    xs = [p[0] for p in pts]
    ys = [p[1] for p in pts]
    return min(xs), min(ys), max(xs), max(ys)


def load(pdf, pno):
    pg = pdf.pages[pno - 1]
    rects = [(r['x0'], r['top'], r['x1'], r['bottom'], col(r.get('stroking_color'))) for r in pg.rects]
    curves = [([(x, y) for x, y in c['pts']], col(c.get('stroking_color')), bool(c.get('fill')),
               col(c.get('non_stroking_color'))) for c in pg.curves]
    words = [(w['text'], w['x0'], w['top'], w['x1'], w['bottom']) for w in pg.extract_words()]
    chars = [(c['text'], c['x0'], c['top'], c['x1'], c['bottom']) for c in pg.chars]
    return rects, curves, words, chars


def main(src, dst):
    with pdfplumber.open(src) as pdf:
        r4, c4, _, _ = load(pdf, 4)
        r8, c8, w8, _ = load(pdf, 8)
        _, _, _, ch11 = load(pdf, 11)

    # ---- mese ----------------------------------------------------------------
    panels = [r for r in r4 if r[4] == PANEL_BLUE and r[1] < MAP_BOTTOM]
    tops = sorted(set(round(r[1], 1) for r in panels))
    assert len(tops) % 2 == 0, 'număr impar de rânduri de panouri'
    tables = []
    for ri in range(0, len(tops), 2):
        top = sorted((r for r in panels if abs(r[1] - tops[ri]) < 0.3), key=lambda r: r[0])
        bot = sorted((r for r in panels if abs(r[1] - tops[ri + 1]) < 0.3), key=lambda r: r[0])
        assert len(top) == len(bot) and len(top) % COLS == 0, (ri, len(top), len(bot))
        for k in range(0, len(top), COLS):
            t, b = top[k:k + COLS], bot[k:k + COLS]
            tables.append(dict(row=ri // 2 + 1, idx=k // COLS + 1,
                               x0=t[0][0], x1=t[-1][2], y0=t[0][1], y1=b[0][3]))

    # ---- cabluri DC: componente conexe de aceeași culoare = un invertor --------
    segs = []
    for pts, _, fill, nsc in c8:
        if fill and nsc in CABLE:
            x0, y0, x1, y1 = bbox(pts)
            if y1 < MAP_BOTTOM:
                segs.append((CABLE[nsc], x0, y0, x1, y1))
    parent = list(range(len(segs)))

    def find(a):
        while parent[a] != a:
            parent[a] = parent[parent[a]]
            a = parent[a]
        return a

    T = 0.15
    for i, a in enumerate(segs):
        for j in range(i + 1, len(segs)):
            b = segs[j]
            if a[0] == b[0] and a[1] - T <= b[3] and b[1] - T <= a[3] and a[2] - T <= b[4] and b[2] - T <= a[4]:
                parent[find(i)] = find(j)
    comps = collections.defaultdict(list)
    for i, s in enumerate(segs):
        comps[find(i)].append(s)
    comps = sorted((c for c in comps.values() if len(c) > 50), key=lambda c: min(s[2] for s in c))

    inv_words = sorted((w for w in w8 if w[0].startswith('INV.0')), key=lambda w: w[0])
    assert len(comps) == len(inv_words), (len(comps), len(inv_words))

    touch = collections.defaultdict(dict)            # masă -> {invertor: calitatea atingerii}
    for ci, comp in enumerate(comps):
        for _, x0, y0, x1, y1 in comp:
            if x1 - x0 < 1.0 and y1 - y0 > 0.8:      # tronson vertical = coborâre la masă
                xm = (x0 + x1) / 2
                for ti, t in enumerate(tables):
                    if not (t['x0'] - 0.3 <= xm <= t['x1'] + 0.3):
                        continue
                    exact = abs(y1 - t['y0']) < 0.6 or abs(y0 - t['y1']) < 0.6
                    over = y0 < t['y1'] and y1 > t['y0']
                    if exact or over:
                        touch[ti][ci] = max(touch[ti].get(ci, 0), 2 if exact else 1)
    counts = collections.Counter()
    for ti, t in enumerate(tables):
        assert touch[ti], 'masă fără cablu: R%d M%d' % (t['row'], t['idx'])
        best = max(touch[ti].values())
        cands = [c for c, q in touch[ti].items() if q == best]
        t['_cands'] = cands
        if len(cands) == 1:
            t['inv'] = cands[0] + 1
            counts[t['inv']] += 1
    for t in tables:                                 # mesele atinse de două cabluri merg la invertorul mai liber
        if 'inv' not in t:
            t['inv'] = min(t['_cands'], key=lambda c: counts[c + 1]) + 1
            counts[t['inv']] += 1
    per_inv = collections.defaultdict(int)
    for t in sorted(tables, key=lambda t: (t['inv'], t['row'], t['idx'])):
        per_inv[t['inv']] += 1
        t['str'] = per_inv[t['inv']]

    # ---- origine și coordonate --------------------------------------------------
    outline_pt = []
    for pts, sc, fill, nsc in c4:
        if fill and nsc == BROWN and bbox(pts)[3] < MAP_BOTTOM:
            a, b = max(((p, q) for p in pts for q in pts), key=lambda pq: math.dist(*pq))
            outline_pt.append((a, b))
    single = []                                     # conturul e desenat cu linie dublă; păstrăm o singură linie
    for a, b in outline_pt:
        mid = ((a[0] + b[0]) / 2, (a[1] + b[1]) / 2)
        if all(math.dist(mid, ((c[0] + d[0]) / 2, (c[1] + d[1]) / 2)) > 2 for c, d in single):
            single.append((a, b))
    outline_pt = single
    xs = [p[0] for seg in outline_pt for p in seg]
    ys = [p[1] for seg in outline_pt for p in seg]
    ox, oy = min(xs) - 10, min(ys) - 10

    def mx(x):
        return round((x - ox) * M_PER_PT, 2)

    def my(y):
        return round((y - oy) * M_PER_PT, 2)

    out_tables = [dict(id='R%02d-M%02d' % (t['row'], t['idx']), row=t['row'], idx=t['idx'],
                       x=mx(t['x0']), y=my(t['y0']), w=round((t['x1'] - t['x0']) * M_PER_PT, 2),
                       h=round((t['y1'] - t['y0']) * M_PER_PT, 2), inv=t['inv'], str=t['str'])
                  for t in tables]

    equip = []
    ptab = next(r for r in r8 if r[4] == (0.0, 0.0, 0.0) and r[1] < MAP_BOTTOM and 4 < r[2] - r[0] < 8 and 9 < r[3] - r[1] < 15)
    equip.append(dict(id='PTAB', type='ptab', name='PTAB / STS', x=mx(ptab[0]), y=my(ptab[1]),
                      w=round((ptab[2] - ptab[0]) * M_PER_PT, 2), h=round((ptab[3] - ptab[1]) * M_PER_PT, 2)))
    for i, w in enumerate(inv_words):               # simbolul invertorului e în stânga etichetei
        equip.append(dict(id='INV%02d' % (i + 1), type='inv', name='Invertor %02d' % (i + 1), n=i + 1,
                          x=mx(w[1] - 10.8), y=my(w[2]), w=round(10.8 * M_PER_PT, 2), h=round(5.64 * M_PER_PT, 2)))
    rac = next((w for w in w8 if w[0] == 'RACORD' and w[2] < MAP_BOTTOM), None)
    if rac:
        equip.append(dict(id='RACORD', type='racord', name='Stâlpi racord 20 kV', x=mx(rac[1]), y=my(rac[4] + 2)))

    # stâlpi: etichetele „SI” sunt scrise literă cu literă, deci căutăm un S cu un I lipit de el
    chars = [c for c in ch11 if c[2] < MAP_BOTTOM]
    letter_i = [((c[1] + c[3]) / 2, (c[2] + c[4]) / 2) for c in chars if c[0] == 'I']
    poles = []
    for c in chars:
        if c[0] == 'S':
            p = ((c[1] + c[3]) / 2, (c[2] + c[4]) / 2)
            if letter_i and min(math.dist(p, i) for i in letter_i) < 2.2:
                poles.append(p)
    if poles:                                       # numerotare în sens orar, pornind de la intrare (nord)
        cx = sum(p[0] for p in poles) / len(poles)
        cy = sum(p[1] for p in poles) / len(poles)
        start = min(poles, key=lambda p: p[1])
        a0 = math.atan2(start[1] - cy, start[0] - cx)
        poles.sort(key=lambda p: (math.atan2(p[1] - cy, p[0] - cx) - a0) % (2 * math.pi))
        for i, p in enumerate(poles):
            equip.append(dict(id='SI%02d' % (i + 1), type='stalp', name='Stâlp SI %d' % (i + 1), x=mx(p[0]), y=my(p[1])))

    data = dict(
        name='CEF EPS Țuțora',
        source='Plan DWG exportat PDF, 7/2026, scara 1:1500',
        specs=dict(panouri=len(tables) * COLS * TIERS, mese=len(tables), randuri=tables[-1]['row'],
                   panouriPeMasa=COLS * TIERS, invertoare=len(inv_words),
                   note='8 invertoare 330KTL + 1 invertor 200KTL, 1 PTAB, module min. 710 W, aranjare 2P, 30°, 6,5 m între rânduri'),
        cols=COLS, tiers=TIERS,
        width=mx(max(xs) + 10), height=my(max(ys) + 10),
        stereo70=dict(e0=round(710050 + (ox - 97.15) * M_PER_PT, 2), n0=round(628750 - (oy - 40.59) * M_PER_PT, 2)),
        outline=[[mx(a[0]), my(a[1]), mx(b[0]), my(b[1])] for a, b in outline_pt],
        tables=out_tables,
        equip=equip,
    )
    with open(dst, 'w', encoding='utf-8') as f:
        f.write('// Generat de tools/extract_plan.py din planul parcului. Nu edita manual.\n')
        f.write('export const PARC = ')
        json.dump(data, f, ensure_ascii=False, separators=(',', ':'))
        f.write(';\n')
    print('mese', len(out_tables), '| panouri', data['specs']['panouri'], '| echipamente', len(equip))
    print('stringuri pe invertor', dict(sorted(collections.Counter(t['inv'] for t in tables).items())))
    print('dimensiune hartă (m)', data['width'], 'x', data['height'])


if __name__ == '__main__':
    main(sys.argv[1], sys.argv[2])
