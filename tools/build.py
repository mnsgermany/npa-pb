#!/usr/bin/env python3
"""Сборка: дополняет перечень полями для интерфейса, учитывает тексты в data/texts/ и пересобирает sw.js.
Запуск из корня приложения: python3 tools/build.py"""
import hashlib, json, os, re

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
J = lambda *p: os.path.join(ROOT, *p)

cat = json.load(open(J('tools', 'catalog.src.json'), encoding='utf-8'))
sources = {}
if os.path.exists(J('tools', 'sources.json')):
    for s in json.load(open(J('tools', 'sources.json'), encoding='utf-8')):
        sources[s['id']] = s

KIND = {'g1': 'Указ Президента', 'g3': 'Постановление Правительства', 'g4': 'Приказ МЧС России', 'g5': 'Приказ Росстандарта'}
CODES = {'d2-1': 'КоАП РФ', 'd2-2': 'УК РФ', 'd2-3': 'УПК РФ', 'd2-4': 'Лесной кодекс РФ'}

def derive(d):
    t = d['title'].strip().rstrip('.')
    g = d['group']
    m = re.search(r'«(.*)»', t)
    if m:
        name = m.group(1)
        note = t[m.end():].strip(' .')
    else:
        mm = re.search(r'№ ?[\dА-Яа-я\-]+\s+(об? .+?)(\s*\((.*)\))?$', t)
        if mm:
            name = mm.group(1)[0].upper() + mm.group(1)[1:]
            note = mm.group(3) or ''
        else:
            name = re.sub(r'\s+от \d\d\.\d\d\.\d{4} № ?\S+', '', t)
            pm = re.search(r'\s*\((.*)\)$', name)
            note = ''
            if pm:
                note = pm.group(1); name = name[:pm.start()]
    note = note.strip()
    if note.startswith('(') and note.endswith(')'): note = note[1:-1]
    num = d.get('code', '') or ''
    if g == 'g2':
        if d['id'] in CODES: short, kind = CODES[d['id']], 'Кодекс'
        else: short, kind = num.replace('№ ', ''), 'Федеральный закон'
    elif g in ('g6', 'g7'):
        short = num
        kind = 'Свод правил' if g == 'g6' else ('ГОСТ Р' if 'ГОСТ Р' in num else 'ГОСТ')
        if not m:  # СП 554 без кавычек
            pm = re.search(r'\((.*)\)', t)
            name = pm.group(1).split(';')[0].capitalize() if pm else t
            note = pm.group(1).split(';', 1)[1].strip() if pm and ';' in pm.group(1) else ''
    else:
        kind = KIND[g]
        pre = {'g1': 'Указ', 'g3': 'ПП РФ', 'g4': 'Приказ МЧС', 'g5': 'Приказ Росстандарта'}[g]
        short = f'{pre} {num}'
    ym = re.search(r'\.(\d{4})(?!\d)', num) or re.search(r'-(\d{2,4})$', num)
    year = None
    if ym:
        y = int(ym.group(1)); year = y if y > 1900 else (1900 + y if y > 30 else 2000 + y)
    d.update(name=name.strip(), note=note, short=short, kind=kind)
    if year and not d.get('date'): d['year'] = year

with_text = 0
for d in cat['docs']:
    derive(d)
    p = J('data', 'texts', d['id'] + '.txt')
    if os.path.exists(p) and os.path.getsize(p) > 200:
        b = open(p, 'rb').read()
        s = sources.get(d['id'], {})
        d['text'] = {'h': hashlib.sha1(b).hexdigest()[:10], 'chars': len(b.decode('utf-8')), 'bytes': len(b),
                     'src': {k: s[k] for k in ('url', 'retrieved', 'status') if s.get(k)}}
        if s.get('edition_note'): d['text']['ed'] = s['edition_note']
        with_text += 1
    else:
        d.pop('text', None)

if os.path.exists(J('tools', 'changelog.json')):
    cat['changes'] = json.load(open(J('tools', 'changelog.json'), encoding='utf-8'))
json.dump(cat, open(J('data', 'catalog.json'), 'w', encoding='utf-8'), ensure_ascii=False, separators=(',', ':'))

assets = ['./', 'index.html', 'app.css', 'app.js', 'match.js', 'search-worker.js', 'manifest.webmanifest', 'data/catalog.json',
          'icons/icon.svg', 'icons/apple-touch-icon.png', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/maskable-512.png']
h = hashlib.sha1()
for a in assets[1:]:
    h.update(open(J(a), 'rb').read())
ver = h.hexdigest()[:10]
tpl = open(J('tools', 'sw.template.js'), encoding='utf-8').read()
open(J('sw.js'), 'w', encoding='utf-8').write(tpl.replace('__VERSION__', ver).replace('__ASSETS__', json.dumps(assets)))
print(f'docs={len(cat["docs"])} with_text={with_text} version={ver}')
