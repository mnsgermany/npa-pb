/* Полнотекстовый поиск по всем документам в фоне, чтобы интерфейс не подтормаживал. */
importScripts('match.js');
const { norm, splitLines, makeMatcher, headingLevel, snippet } = self.NPA;

const store = new Map(); // id -> { lines, nl, head }
let loading = null;

async function loadAll(docs) {
  let done = 0;
  const total = docs.length;
  const queue = docs.filter((d) => !store.has(d.id));
  done = total - queue.length;
  const work = async () => {
    while (queue.length) {
      const d = queue.shift();
      try {
        const r = await fetch(d.url);
        if (!r.ok) throw new Error(r.status);
        const lines = splitLines(await r.text());
        const nl = lines.map(norm);
        const head = new Int32Array(lines.length);
        let h = -1;
        for (let i = 0; i < lines.length; i++) { if (headingLevel(lines[i])) h = i; head[i] = h; }
        store.set(d.id, { lines, nl, head });
      } catch (e) { /* документ недоступен офлайн — пропускаем */ }
      done++;
      self.postMessage({ type: 'progress', done, total });
    }
  };
  await Promise.all([work(), work(), work(), work()]);
  self.postMessage({ type: 'ready', loaded: store.size });
}

self.onmessage = async (e) => {
  const m = e.data;
  if (m.type === 'load') {
    loading = loadAll(m.docs);
    await loading;
  } else if (m.type === 'search') {
    if (loading) await loading;
    const t0 = performance.now();
    const matcher = makeMatcher(m.q, m.exact);
    const results = [];
    let hitsTotal = 0;
    if (matcher) {
      for (const id of m.ids) {
        const d = store.get(id);
        if (!d) continue;
        let count = 0; const hits = [];
        for (let i = 0; i < d.nl.length; i++) {
          if (!matcher.test(d.nl[i])) continue;
          count++;
          if (hits.length < 3) {
            const sn = snippet(d.lines[i], matcher.ranges(d.nl[i]));
            const hi = d.head[i];
            hits.push({ i, text: sn.text, ranges: sn.ranges, cut: sn.cut, where: hi >= 0 && hi !== i ? d.lines[hi] : '' });
          }
        }
        if (count) { results.push({ id, count, hits }); hitsTotal += count; }
      }
    }
    results.sort((a, b) => b.count - a.count);
    self.postMessage({ type: 'results', seq: m.seq, results, hitsTotal, ms: Math.round(performance.now() - t0) });
  }
};
