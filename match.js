/* Общие функции поиска: используются и страницей, и поисковым воркером. */
(function (root) {
  'use strict';

  function norm(s) { return s.toLowerCase().replace(/ё/g, 'е'); }

  function splitLines(text) {
    const out = [];
    for (const raw of text.split(/\r?\n/)) {
      const l = raw.replace(/\s+/g, ' ').trim();
      if (l) out.push(l);
    }
    return out;
  }

  // Лёгкий стемминг для русского: отрезаем типичные окончания, чтобы
  // «огнетушитель» находил «огнетушителей», «огнетушителями» и т. п.
  const ENDINGS = ['иями', 'ями', 'ами', 'иях', 'ией', 'иям', 'ием', 'ого', 'его', 'ому', 'ему', 'ыми', 'ими', 'ых', 'их', 'ой', 'ей', 'ий', 'ый', 'ая', 'яя', 'ое', 'ее', 'ые', 'ие', 'ую', 'юю', 'ом', 'ем', 'ам', 'ям', 'ах', 'ях', 'ов', 'ев', 'ия', 'ию', 'ии', 'ть', 'ся', 'а', 'я', 'ы', 'и', 'е', 'у', 'ю', 'о', 'ь', 'й'];
  function stem(w) {
    if (!/^[а-я]+$/.test(w) || w.length <= 4) return w;
    for (const e of ENDINGS) {
      if (w.endsWith(e) && w.length - e.length >= 4) return w.slice(0, -e.length);
    }
    return w;
  }

  function esc(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
  const WORD = '0-9a-zа-я';

  /**
   * Создаёт сопоставитель для запроса.
   * exact=false: все слова запроса должны встретиться в абзаце (по началу слова, с учётом окончаний).
   * exact=true: точная фраза как подстрока.
   */
  function makeMatcher(query, exact) {
    const q = norm(query).replace(/\s+/g, ' ').trim();
    if (!q) return null;
    if (exact) {
      return {
        test: (n) => n.includes(q),
        ranges(n) {
          const r = []; let i = n.indexOf(q);
          while (i !== -1) { r.push([i, i + q.length]); i = n.indexOf(q, i + q.length); }
          return r;
        }
      };
    }
    const terms = [...new Set(q.split(' ')
      .map((t) => t.replace(/^[^0-9a-zа-я]+|[^0-9a-zа-я]+$/g, ''))
      .filter(Boolean))].map(stem);
    if (!terms.length) return null;
    const res = terms.map((t) => new RegExp('(^|[^' + WORD + '])(' + esc(t) + ')[' + WORD + ']*', 'g'));
    const plain = terms;
    return {
      test(n) {
        for (let k = 0; k < plain.length; k++) {
          if (!n.includes(plain[k])) return false;
          res[k].lastIndex = 0;
          if (!res[k].test(n)) return false;
        }
        return true;
      },
      ranges(n) {
        const r = [];
        for (const re of res) {
          re.lastIndex = 0; let m;
          while ((m = re.exec(n))) {
            const s = m.index + m[1].length;
            r.push([s, m.index + m[0].length]);
            if (m[0].length === 0) re.lastIndex++;
          }
        }
        r.sort((a, b) => a[0] - b[0]);
        const out = [];
        for (const x of r) {
          const last = out[out.length - 1];
          if (last && x[0] <= last[1]) last[1] = Math.max(last[1], x[1]); else out.push(x.slice());
        }
        return out;
      }
    };
  }

  // Уровень заголовка строки: 1 — раздел/часть, 2 — глава/приложение/раздел СП, 3 — статья/подраздел, 0 — обычный текст.
  function headingLevel(l) {
    if (l.length > 160 || l.includes(' | ')) return 0;
    if (/^(РАЗДЕЛ|Раздел|ЧАСТЬ|Часть)\s+[IVXLC\d]+/.test(l)) return 1;
    if (/^(ГЛАВА|Глава)\s+[\dIVXLC]+/.test(l)) return 2;
    if (/^(ПРИЛОЖЕНИЕ|Приложение)(\s|$)/.test(l) && l.length < 90) return 2;
    if (/^Статья\s+\d+(\.\d+)*/.test(l)) return 3;
    if (l.length < 110 && !/[.;:,]$/.test(l)) {
      if (/^[IVX]+\.\s+\S/.test(l)) return 2;
      if (/^\d{1,2}\.?\s+[А-ЯA-Z][^]*$/.test(l) && !/^\d{1,2}\.\d/.test(l)) return 2;
      if (/^\d{1,2}\.\d{1,2}\.?\s+[А-ЯA-Z]/.test(l)) return 3;
    }
    if (l.length < 100 && l.length > 6 && /[А-Я]{3}/.test(l) && l === l.toUpperCase() && !/^\d/.test(l)) return 2;
    return 0;
  }

  // Фрагмент длинного абзаца вокруг первого совпадения.
  function snippet(line, ranges, before = 70, total = 230) {
    if (line.length <= total || !ranges.length) return { text: line, ranges, cut: [false, false] };
    let s = Math.max(0, ranges[0][0] - before);
    if (s > 0) { const sp = line.indexOf(' ', s); if (sp !== -1 && sp < ranges[0][0]) s = sp + 1; }
    let e = Math.min(line.length, s + total);
    if (e < line.length) { const sp = line.lastIndexOf(' ', e); if (sp > ranges[0][1]) e = sp; }
    const rr = ranges.filter((r) => r[0] >= s && r[1] <= e).map((r) => [r[0] - s, r[1] - s]);
    return { text: line.slice(s, e), ranges: rr, cut: [s > 0, e < line.length] };
  }

  root.NPA = { norm, splitLines, stem, makeMatcher, headingLevel, snippet };
})(typeof self !== 'undefined' ? self : this);
