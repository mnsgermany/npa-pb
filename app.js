/* НПА · Пожарная профилактика — офлайн-справочник. Без фреймворков, работает из кэша. */
(function () {
  'use strict';
  const { norm, isBox, isRow, cells, splitLines, makeMatcher, headingLevel } = window.NPA;

  const $ = (s, el = document) => el.querySelector(s);
  const main = $('#main');
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const icon = (name, cls = '') => `<svg class="ic ${cls}" aria-hidden="true"><use href="#i-${name}"/></svg>`;
  const plural = (n, a, b, c) => { const m10 = n % 10, m100 = n % 100; return m10 === 1 && m100 !== 11 ? a : m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20) ? b : c; };
  const store = {
    get(k, d) { try { const v = localStorage.getItem('npa:' + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem('npa:' + k, JSON.stringify(v)); } catch (e) { /* приватный режим */ } }
  };

  // Подсветка: ranges считаются по нормализованной строке, длина которой совпадает с исходной.
  function hl(text, ranges, curIdx = -1, base = 0) {
    if (!ranges || !ranges.length) return esc(text);
    let out = '', p = 0;
    ranges.forEach((r, k) => {
      out += esc(text.slice(p, r[0]));
      const cls = base + k === curIdx ? ' class="cur"' : '';
      out += `<mark data-k="${base + k}"${cls}>` + esc(text.slice(r[0], r[1])) + '</mark>';
      p = r[1];
    });
    return out + esc(text.slice(p));
  }
  function hlQuery(text, q) {
    const m = q && makeMatcher(q, false);
    return m ? hl(text, m.ranges(norm(text))) : esc(text);
  }

  // ---------- Данные ----------
  let CAT = null, DOCS = [], BYID = new Map(), GROUPS = [], GBYID = new Map();
  let favs = new Set(store.get('favs', []));
  const ui = {
    list: { q: '', group: 'all', sort: store.get('sort', 'group') },
    search: { q: '', exact: false, group: 'all', results: null, shown: 20 },
    scroll: {}
  };

  function setCatalog(c) {
    CAT = c;
    GROUPS = CAT.groups; GBYID = new Map(); BYID = new Map();
    GROUPS.forEach((g, i) => { g.color = `var(--g${i + 1})`; GBYID.set(g.id, g); });
    DOCS = CAT.docs;
    DOCS.forEach((d) => {
      BYID.set(d.id, d);
      d.textUrl = d.text ? `data/texts/${d.id}.txt?v=${d.text.h}` : null;
      d.hay = norm([d.short, d.name, d.title, d.kind].join(' '));
      d.dateKey = d.date ? d.date.split('.').reverse().join('') : (d.year ? String(d.year) + '0000' : '0');
    });
  }
  async function fetchCatalog(fresh) {
    const r = await fetch('data/catalog.json' + (fresh ? '?t=' + Date.now() : ''), { cache: 'no-store' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return r.json();
  }
  // На устройстве живёт «установленная» версия перечня; новая применяется только по кнопке.
  async function loadCatalog() {
    const local = store.get('cat', null);
    if (local && local.docs) { setCatalog(local); return; }
    const c = await fetchCatalog(false);
    store.set('cat', c); store.set('checkedAt', Date.now()); setCatalog(c);
  }

  // ---------- Проверка актуальности ----------
  const upd = { state: 'idle', diff: null, remote: null, error: null };
  function diffCatalogs(a, b) {
    const A = new Map(a.docs.map((d) => [d.id, d])), out = { changed: [], added: [], removed: [], bytes: 0, listChanged: false };
    for (const d of b.docs) {
      const o = A.get(d.id);
      if (!o) { out.added.push(d); if (d.text) out.bytes += d.text.bytes || d.text.chars * 2; continue; }
      const ho = o.text && o.text.h, hn = d.text && d.text.h;
      if (ho !== hn && hn) { out.changed.push(d); out.bytes += d.text.bytes || d.text.chars * 2; }
      else if (o.title !== d.title) out.listChanged = true;
    }
    const B = new Set(b.docs.map((d) => d.id));
    for (const d of a.docs) if (!B.has(d.id)) out.removed.push(d);
    if (a.asOf !== b.asOf) out.listChanged = true;
    out.count = out.changed.length + out.added.length + out.removed.length;
    out.any = out.count > 0 || out.listChanged;
    return out;
  }
  async function checkUpdates(manual) {
    if (upd.state === 'checking' || upd.state === 'applying') return;
    if (!navigator.onLine) { upd.state = 'offline'; renderUpd(); if (manual) toast('Нет интернета, проверить нельзя'); return; }
    upd.state = 'checking'; renderUpd();
    try {
      const remote = await fetchCatalog(true);
      store.set('checkedAt', Date.now());
      upd.remote = remote; upd.diff = diffCatalogs(CAT, remote);
      upd.state = upd.diff.any ? 'available' : 'current';
      if (manual && !upd.diff.any) toast('Все документы актуальны');
    } catch (e) { upd.state = 'error'; if (manual) toast('Не удалось проверить обновления'); }
    renderUpd();
  }
  async function applyUpdate() {
    if (!upd.remote) return;
    upd.state = 'applying'; renderUpd();
    store.set('cat', upd.remote); setCatalog(upd.remote);
    if (worker) { worker.terminate(); worker = null; wState = { ready: false, done: 0, total: 0 }; }
    textCache.clear(); ui.search.results = null;
    await saveAll();
    upd.state = 'current'; upd.diff = null; upd.remote = null;
    toast('База обновлена');
    route();
  }
  function fmtDate(ts) {
    if (!ts) return 'ещё не проверялось';
    return new Date(ts).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  }
  function fmtSize(b) { return b > 1e6 ? (b / 1048576).toFixed(1).replace('.', ',') + ' МБ' : Math.max(1, Math.round(b / 1024)) + ' КБ'; }
  function renderUpd() {
    const dot = $('.tabbar a[data-tab="info"]');
    if (dot) dot.classList.toggle('has-upd', upd.state === 'available');
    const ban = $('#update-banner');
    if (ban) {
      ban.innerHTML = upd.state === 'available'
        ? `<a class="banner upd" href="#/info">${icon('down', 'sm')}<span><b>Есть обновления.</b> ${upd.diff.count ? `${upd.diff.count} ${plural(upd.diff.count, 'документ', 'документа', 'документов')}` : 'Изменён перечень'}</span>${icon('chev', 'sm')}</a>` : '';
    }
    const el = $('#updinfo'); if (!el) return;
    const last = `<p class="muted">Последняя проверка: ${fmtDate(store.get('checkedAt', 0))}</p>`;
    const btn = (label, id, primary) => `<button class="btn ${primary ? '' : 'ghost'}" id="${id}">${label}</button>`;
    let html = '';
    if (upd.state === 'checking') html = `<div class="stat"><span class="spinner"></span> Проверяю обновления…</div>`;
    else if (upd.state === 'applying') html = `<div class="stat"><span class="spinner"></span> Скачиваю новые редакции…</div>`;
    else if (upd.state === 'available') {
      const D = upd.diff, item = (d, what) => `<li><b>${esc(d.short)}</b> — ${what}${d.text && d.text.ed ? `: ${esc(d.text.ed)}` : ''}</li>`;
      html = `<div class="stat"><span class="badge">новое</span><span>Перечень от ${esc(upd.remote.asOf)}</span></div>
        <ul class="chg">${D.changed.map((d) => item(d, 'новая редакция')).join('')}${D.added.map((d) => item(d, 'добавлен')).join('')}${D.removed.map((d) => `<li><b>${esc(d.short)}</b> — исключён из перечня</li>`).join('')}
        ${!D.count ? '<li>Обновлены названия и примечания в перечне</li>' : ''}</ul>
        ${(upd.remote.changes || []).slice(0, 3).map((c) => `<p class="muted">${esc(c.date)}: ${esc(c.text)}</p>`).join('')}
        <p class="btns">${btn(`Скачать${D.bytes ? ' (' + fmtSize(D.bytes) + ')' : ''}`, 'applyupd', true)}</p>`;
    } else {
      const msg = { current: `<div class="stat"><span class="ok">${icon('check')}</span><span>Все документы актуальны</span></div>`,
        offline: `<div class="stat">${icon('cloud-off')}<span>Нет интернета. Проверка возможна при подключении к сети.</span></div>`,
        error: `<div class="stat">${icon('cloud-off')}<span>Сервер не ответил. Попробуйте позже.</span></div>` }[upd.state] || '';
      html = msg + `<p class="btns">${btn('Проверить обновления', 'chkupd', !msg)}</p>`;
    }
    el.innerHTML = html + last;
    const a = $('#applyupd'); if (a) a.addEventListener('click', applyUpdate);
    const c = $('#chkupd'); if (c) c.addEventListener('click', () => checkUpdates(true));
  }

  // ---------- Роутинг ----------
  function parseHash() {
    const h = location.hash.replace(/^#/, '') || '/';
    const [path, qs] = h.split('?');
    const params = new URLSearchParams(qs || '');
    const parts = path.split('/').filter(Boolean);
    return { name: parts[0] || 'list', arg: parts[1], params, key: path };
  }
  let current = null;
  function route() {
    if (current) ui.scroll[current.key] = window.scrollY;
    if (current && current.cleanup) current.cleanup();
    const r = parseHash();
    current = r;
    closeSheet();
    document.body.classList.toggle('reading', r.name === 'doc');
    document.querySelectorAll('.tabbar a').forEach((a) => {
      if (a.dataset.tab === r.name) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
    });
    const view = { list: viewList, search: viewSearch, fav: viewFav, info: viewInfo, doc: viewDoc }[r.name] || viewList;
    view(r);
    const y = ui.scroll[r.key];
    if (r.name !== 'doc') requestAnimationFrame(() => window.scrollTo(0, y || 0));
  }
  window.addEventListener('hashchange', route);
  window.addEventListener('scroll', () => {
    const t = $('.top'); if (t) t.classList.toggle('scrolled', window.scrollY > 4);
  }, { passive: true });

  // ---------- Общие куски ----------
  function searchField(id, placeholder, value, label) {
    return `<label class="search ${value ? 'has' : ''}">
      <span class="sr">${esc(label)}</span>
      ${icon('search')}
      <input id="${id}" type="search" inputmode="search" enterkeyhint="search" autocomplete="off" autocorrect="off" spellcheck="false" placeholder="${esc(placeholder)}" value="${esc(value)}">
      <button type="button" class="clear" aria-label="Очистить">${icon('x', 'sm')}</button>
    </label>`;
  }
  function wireSearch(input, onInput, delay = 0) {
    const box = input.closest('.search');
    let t;
    input.addEventListener('input', () => {
      box.classList.toggle('has', !!input.value);
      clearTimeout(t);
      t = setTimeout(() => onInput(input.value), delay);
    });
    box.querySelector('.clear').addEventListener('click', () => {
      input.value = ''; box.classList.remove('has'); onInput(''); input.focus();
    });
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') input.blur(); });
  }
  function chipsHtml(active, counts) {
    const all = `<button class="chip" data-g="all" aria-pressed="${active === 'all'}">Все <span class="n">${counts.all}</span></button>`;
    return all + GROUPS.map((g) => `<button class="chip${counts[g.id] ? '' : ' zero'}" data-g="${g.id}" aria-pressed="${active === g.id}">${esc(g.short)} <span class="n">${counts[g.id] || 0}</span></button>`).join('');
  }
  function docRow(d, q) {
    const g = GBYID.get(d.group);
    const fav = favs.has(d.id);
    return `<li><a class="row" href="#/doc/${d.id}" style="--gc:${g.color}">
      <span class="code"><span class="dot"></span>${hlQuery(d.short, q)}<span class="kind">· ${esc(d.kind)}</span></span>
      <span class="title">${hlQuery(d.name, q)}</span>
      ${d.note || d.date ? `<span class="meta">${hlQuery([d.date ? 'от ' + d.date : '', d.note].filter(Boolean).join(' · '), q)}</span>` : ''}
      <span class="side">${fav ? `<span class="fav" title="В избранном">${icon('star', 'sm')}</span>` : ''}${!d.text ? '<span class="nofile">нет текста</span>' : d.text.src && d.text.src.status === 'partial' ? '<span class="nofile">неполный</span>' : ''}${icon('chev', 'sm')}</span>
    </a></li>`;
  }

  // ---------- Перечень ----------
  function filterDocs(q, group) {
    const m = q.trim() ? makeMatcher(q, false) : null;
    return DOCS.filter((d) => (group === 'all' || d.group === group) && (!m || m.test(d.hay)));
  }
  function viewList() {
    const s = ui.list;
    main.innerHTML = `
      <div class="top"><div class="wrap">
        <div class="hero"><h1>НПА <span class="accent">·</span> Пожарная профилактика</h1>
          <p>Актуально на ${esc(CAT.asOf)} · ${DOCS.length} ${plural(DOCS.length, 'документ', 'документа', 'документов')}</p></div>
        ${searchField('lq', 'Название, номер, «СП 484», «123-ФЗ»…', s.q, 'Поиск по перечню')}
        <div class="chips" role="group" aria-label="Группы документов"></div>
      </div></div>
      <div class="wrap">
        <div id="update-banner"></div><div id="offline-banner"></div>
        <div class="toolbar"><span id="lcount" aria-live="polite"></span>
          <div class="seg" role="group" aria-label="Порядок">
            <button data-sort="group">Группы</button><button data-sort="new">Новые</button><button data-sort="az">А–Я</button>
          </div>
        </div>
        <div id="lbody"></div>
      </div>`;
    const input = $('#lq');
    wireSearch(input, (v) => { s.q = v; renderList(); });
    $('.chips').addEventListener('click', (e) => {
      const b = e.target.closest('.chip'); if (!b) return;
      s.group = b.dataset.g; renderList();
      b.scrollIntoView({ inline: 'nearest', block: 'nearest', behavior: 'smooth' });
    });
    $('.seg').addEventListener('click', (e) => {
      const b = e.target.closest('button'); if (!b) return;
      s.sort = b.dataset.sort; store.set('sort', s.sort); renderList();
    });
    renderList();
    renderOfflineBanner();
    renderUpd();
  }
  function renderList() {
    const s = ui.list;
    const base = filterDocs(s.q, 'all');
    const counts = { all: base.length };
    base.forEach((d) => { counts[d.group] = (counts[d.group] || 0) + 1; });
    $('.chips').innerHTML = chipsHtml(s.group, counts);
    document.querySelectorAll('.seg button').forEach((b) => b.setAttribute('aria-pressed', b.dataset.sort === s.sort));
    const docs = base.filter((d) => s.group === 'all' || d.group === s.group);
    $('#lcount').textContent = `${docs.length} ${plural(docs.length, 'документ', 'документа', 'документов')}`;
    let html = '';
    if (!docs.length) {
      html = `<div class="empty">${icon('search')}<h2>В перечне ничего не нашлось</h2>
        <p>Попробуйте номер документа («1479», «СП 1.13130») или часть названия.</p></div>`;
    } else if (s.sort === 'group') {
      for (const g of GROUPS) {
        const gd = docs.filter((d) => d.group === g.id);
        if (!gd.length) continue;
        html += `<h2 class="group-h" style="color:${g.color}">${esc(g.title)} <span class="n">${gd.length}</span></h2>`;
        const main_ = gd.filter((d) => !d.sub), sub = gd.filter((d) => d.sub);
        if (main_.length) html += `<ul class="list">${main_.map((d) => docRow(d, s.q)).join('')}</ul>`;
        if (sub.length) html += `<div class="sub-h">${esc(sub[0].sub)}</div><ul class="list">${sub.map((d) => docRow(d, s.q)).join('')}</ul>`;
      }
    } else {
      const sorted = docs.slice().sort(s.sort === 'new'
        ? (a, b) => b.dateKey.localeCompare(a.dateKey)
        : (a, b) => a.name.localeCompare(b.name, 'ru'));
      html = `<ul class="list" style="margin-top:4px">${sorted.map((d) => docRow(d, s.q)).join('')}</ul>`;
    }
    if (s.q.trim()) {
      html += `<a class="btn ghost" style="width:100%;margin-top:14px" href="#/search?q=${encodeURIComponent(s.q.trim())}">${icon('search', 'sm')} Искать «${esc(s.q.trim())}» в текстах документов</a>`;
    }
    $('#lbody').innerHTML = html;
  }

  // ---------- Избранное ----------
  function viewFav() {
    const docs = DOCS.filter((d) => favs.has(d.id));
    main.innerHTML = `<div class="top"><div class="wrap"><div class="hero"><h1>Избранное</h1>
      <p>${docs.length ? `${docs.length} ${plural(docs.length, 'документ', 'документа', 'документов')}` : 'Пока пусто'}</p></div></div></div>
      <div class="wrap" style="padding-top:12px">${docs.length ? `<ul class="list">${docs.map((d) => docRow(d, '')).join('')}</ul>`
      : `<div class="empty">${icon('star')}<h2>Нет избранных документов</h2><p>Откройте документ и нажмите звёздочку вверху, чтобы он был под рукой.</p></div>`}</div>`;
  }

  // ---------- Полнотекстовый поиск ----------
  let worker = null, wState = { ready: false, done: 0, total: 0 }, seq = 0;
  function getWorker() {
    if (worker) return worker;
    worker = new Worker('search-worker.js');
    const docs = DOCS.filter((d) => d.textUrl).map((d) => ({ id: d.id, url: d.textUrl }));
    wState.total = docs.length;
    worker.onmessage = (e) => {
      const m = e.data;
      if (m.type === 'progress') { wState.done = m.done; updateSearchStatus(); }
      if (m.type === 'ready') { wState.ready = true; wState.loaded = m.loaded; updateSearchStatus(); }
      if (m.type === 'results' && m.seq === seq) { ui.search.results = m; ui.search.shown = 20; renderResults(); }
    };
    worker.postMessage({ type: 'load', docs });
    return worker;
  }
  function runSearch() {
    const s = ui.search;
    if (!s.q.trim()) { s.results = null; renderResults(); return; }
    const ids = DOCS.filter((d) => d.textUrl && (s.group === 'all' || d.group === s.group)).map((d) => d.id);
    seq++;
    getWorker().postMessage({ type: 'search', q: s.q, exact: s.exact, ids, seq });
    if (!wState.ready) renderResults(true);
    const rec = store.get('recent', []).filter((x) => x !== s.q.trim());
    rec.unshift(s.q.trim()); store.set('recent', rec.slice(0, 8));
  }
  function updateSearchStatus() {
    const el = $('#sstatus'); if (!el) return;
    el.innerHTML = wState.ready ? '' : `<div class="banner"><span class="spinner" aria-hidden="true"></span><span>Готовлю поиск: ${wState.done} из ${wState.total}</span></div>`;
  }
  function viewSearch(r) {
    const s = ui.search;
    const q = r.params.get('q');
    if (q != null && q !== s.q) { s.q = q; s.results = null; }
    main.innerHTML = `
      <div class="top"><div class="wrap">
        <div class="hero"><h1>Поиск по текстам</h1><p>Во всех документах сразу, без интернета</p></div>
        ${searchField('sq', 'Например: огнетушитель, эвакуационный выход', s.q, 'Поиск по текстам всех документов')}
        <div class="opts"><label class="switch"><input type="checkbox" id="sx" ${s.exact ? 'checked' : ''}> Точная фраза</label></div>
        <div class="chips" role="group" aria-label="Искать в группе"></div>
      </div></div>
      <div class="wrap"><div id="sstatus"></div><div id="sbody" aria-live="polite"></div></div>`;
    const counts = { all: DOCS.filter((d) => d.textUrl).length };
    DOCS.forEach((d) => { if (d.textUrl) counts[d.group] = (counts[d.group] || 0) + 1; });
    const chips = $('.chips');
    chips.innerHTML = chipsHtml(s.group, counts);
    chips.addEventListener('click', (e) => {
      const b = e.target.closest('.chip'); if (!b) return;
      s.group = b.dataset.g;
      chips.querySelectorAll('.chip').forEach((c) => c.setAttribute('aria-pressed', c === b));
      runSearch();
    });
    const input = $('#sq');
    wireSearch(input, (v) => { s.q = v; history.replaceState(null, '', '#/search' + (v.trim() ? '?q=' + encodeURIComponent(v.trim()) : '')); current.key = 'search'; runSearch(); }, 250);
    $('#sx').addEventListener('change', (e) => { s.exact = e.target.checked; runSearch(); });
    getWorker();
    updateSearchStatus();
    if (s.q && !s.results) runSearch(); else renderResults();
    if (!s.q) setTimeout(() => input.focus(), 50);
  }
  function renderResults(pending) {
    const el = $('#sbody'); if (!el) return;
    const s = ui.search;
    if (!s.q.trim()) {
      const rec = store.get('recent', []);
      el.innerHTML = `<div class="hint">
        ${rec.length ? `<h3>Недавние запросы</h3><div class="recent">${rec.map((x) => `<button class="chip" data-r="${esc(x)}">${esc(x)}</button>`).join('')}</div>` : ''}
        <h3>Как искать</h3>
        <ul>
          <li>Слова ищутся с учётом окончаний: «огнетушитель» найдёт «огнетушителей».</li>
          <li>В абзаце должны встретиться все слова запроса, порядок не важен.</li>
          <li>«Точная фраза» ищет текст буквально, например «не менее 1,2 м».</li>
          <li>Номера пунктов тоже ищутся: «4.2.5», «статья 20.4».</li>
        </ul></div>`;
      el.querySelectorAll('[data-r]').forEach((b) => b.addEventListener('click', () => {
        const i = $('#sq'); i.value = b.dataset.r; i.dispatchEvent(new Event('input'));
      }));
      return;
    }
    if (pending || !s.results) { el.innerHTML = ''; return; }
    const R = s.results;
    if (!R.results.length) {
      el.innerHTML = `<div class="empty">${icon('search')}<h2>Ничего не найдено</h2>
        <p>${s.exact ? 'Отключите «Точная фраза» или сократите запрос.' : 'Сократите запрос до 1–2 ключевых слов или проверьте написание.'}${s.group !== 'all' ? ' Поиск сейчас ограничен одной группой.' : ''}</p></div>`;
      return;
    }
    const enc = encodeURIComponent(s.q.trim());
    const ex = s.exact ? '&x=1' : '';
    let html = `<p class="hint" style="margin:4px 0 10px">${R.hitsTotal} ${plural(R.hitsTotal, 'фрагмент', 'фрагмента', 'фрагментов')} в ${R.results.length} ${plural(R.results.length, 'документе', 'документах', 'документах')}</p>`;
    html += R.results.slice(0, s.shown).map((r) => {
      const d = BYID.get(r.id), g = GBYID.get(d.group);
      return `<article class="res" style="--gc:${g.color}">
        <a class="res-h" href="#/doc/${d.id}?q=${enc}${ex}"><span class="t"><span class="code">${esc(d.short)}</span><span class="name">${esc(d.name)}</span></span>
          <span class="badge" aria-label="${r.count} совпадений">${r.count}</span></a>
        ${r.hits.map((h) => `<a class="snip" href="#/doc/${d.id}?q=${enc}${ex}&i=${h.i}">
          ${h.where ? `<span class="where">${esc(h.where)}</span>` : ''}${h.cut[0] ? '…' : ''}${hl(h.text, h.ranges)}${h.cut[1] ? '…' : ''}</a>`).join('')}
        ${r.count > r.hits.length ? `<a class="more" href="#/doc/${d.id}?q=${enc}${ex}">Ещё ${r.count - r.hits.length} в документе ${icon('chev', 'sm')}</a>` : ''}
      </article>`;
    }).join('');
    if (R.results.length > s.shown) html += `<button class="btn ghost" id="smore" style="width:100%">Показать ещё ${R.results.length - s.shown}</button>`;
    el.innerHTML = html;
    const more = $('#smore');
    if (more) more.addEventListener('click', () => { s.shown += 30; renderResults(); });
  }

  // ---------- Чтение документа ----------
  const textCache = new Map();
  async function getLines(d) {
    if (textCache.has(d.id)) return textCache.get(d.id);
    const r = await fetch(d.textUrl);
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const lines = splitLines(await r.text());
    const res = { lines, nl: lines.map(norm), lv: lines.map(headingLevel) };
    textCache.clear(); textCache.set(d.id, res);
    return res;
  }
  function lineHtml(l, lv, i, prevTable, nextTable, inner) {
    const body = (inner != null ? inner : esc(l)).replace(/\[рис\.\]/g, '<span class="fig" title="Рисунок, формула или сноска есть только в оригинале">рис.</span>');
    if (isRow(l)) {
      const cls = 'tr' + (prevTable ? '' : ' first') + (nextTable ? '' : ' last');
      return `<div class="${cls}" data-i="${i}">${inner != null ? inner : cells(l).map(([a, b]) => `<span>${esc(l.slice(a, b))}</span>`).join('')}</div>`;
    }
    if (isBox(l)) return `<pre class="pg" data-i="${i}">${body}</pre>`;
    if (lv) return `<h${lv + 1} class="h h${lv}" id="p${i}" data-i="${i}">${body}</h${lv + 1}>`;
    return `<p data-i="${i}">${body}</p>`;
  }
  function tableInner(l, ranges, curIdx, base) {
    // Подсветка внутри ячеек таблицы: разбиваем диапазоны по ячейкам.
    let k = base, out = '';
    for (const [a, b] of cells(l)) {
      const rr = ranges.filter((r) => r[0] >= a && r[1] <= b).map((r) => [r[0] - a, r[1] - a]);
      out += `<span>${hl(l.slice(a, b), rr, curIdx, k)}</span>`;
      k += rr.length;
    }
    return { html: out, n: k - base };
  }

  function viewDoc(r) {
    const d = BYID.get(r.arg);
    if (!d) { location.replace('#/'); return; }
    const g = GBYID.get(d.group);
    const fav = favs.has(d.id);
    const q0 = r.params.get('q') || '';
    const exact = r.params.get('x') === '1';
    const at = r.params.has('i') ? +r.params.get('i') : null;
    window.scrollTo(0, 0);
    main.innerHTML = `
      <div class="top"><div class="wrap">
        <div class="rbar">
          <button class="ibtn" id="back" aria-label="Назад">${icon('back')}</button>
          <div class="ttl">${esc(d.short)}</div>
          ${d.textUrl ? `<button class="ibtn" id="find" aria-label="Поиск в документе" aria-pressed="false">${icon('search')}</button>
          <button class="ibtn" id="toc" aria-label="Содержание">${icon('toc')}</button>
          <button class="ibtn" id="fs" aria-label="Размер текста">${icon('text')}</button>` : ''}
          <button class="ibtn ${fav ? 'on' : ''}" id="fav" aria-label="${fav ? 'Убрать из избранного' : 'В избранное'}" aria-pressed="${fav}">${icon('star')}</button>
        </div>
        <div class="findbar" id="findbar" hidden>
          ${searchField('fq', 'Найти в документе', q0, 'Поиск по документу')}
          <span class="count" id="fcount" aria-live="polite"></span>
          <button class="ibtn" id="fprev" aria-label="Предыдущее совпадение" disabled>${icon('up')}</button>
          <button class="ibtn" id="fnext" aria-label="Следующее совпадение" disabled>${icon('down')}</button>
        </div>
      </div></div>
      <div class="wrap" style="--gc:${g.color}">
        <header class="dochead">
          <div class="kind">${esc(d.kind)}</div>
          <h1>${esc(d.name)}</h1>
          <p class="num">${esc(d.short)}${d.date ? ' от ' + esc(d.date) : ''}</p>
          ${d.note ? `<div class="note">${esc(d.note)}</div>` : ''}
          ${d.text && d.text.src ? `<div class="src">${d.text.src.url ? `<a href="${esc(d.text.src.url)}" target="_blank" rel="noopener">Источник ${icon('ext', 'sm')}</a>` : ''}
            ${d.text.ed ? `<span>Редакция: ${esc(d.text.ed)}</span>` : ''}
            ${d.text.src.retrieved ? `<span>Проверено ${esc(d.text.src.retrieved)}</span>` : ''}
            </div>` : ''}
          ${d.text && d.text.src && d.text.src.status === 'partial' ? `<div class="note warn"><b>Текст неполный.</b> В открытых источниках документ доступен с сокращениями: часть разделов или приложений может отсутствовать. Сверяйте с официальной публикацией.</div>` : ''}
        </header>
        <div class="doc" id="doc" lang="ru">${d.textUrl ? '<p class="hint"><span class="spinner"></span> Открываю документ…</p>' : ''}</div>
      </div>`;
    $('#back').addEventListener('click', () => { if (ui.cameFromApp) history.back(); else location.hash = '#/'; });
    $('#fav').addEventListener('click', (e) => {
      const b = e.currentTarget;
      if (favs.has(d.id)) favs.delete(d.id); else favs.add(d.id);
      store.set('favs', [...favs]);
      const on = favs.has(d.id);
      b.classList.toggle('on', on); b.setAttribute('aria-pressed', on);
      b.setAttribute('aria-label', on ? 'Убрать из избранного' : 'В избранное');
      toast(on ? 'Добавлено в избранное' : 'Убрано из избранного');
    });
    if (!d.textUrl) {
      $('#doc').innerHTML = `<div class="empty">${icon('doc')}<h2>Текста пока нет в базе</h2>
        <p>Документ есть в перечне, но его полный текст ещё не загружен в приложение.</p>
        <p style="margin-top:14px"><a class="btn ghost" href="https://www.consultant.ru/search/?q=${encodeURIComponent(d.short)}" target="_blank" rel="noopener">Найти онлайн ${icon('ext', 'sm')}</a></p></div>`;
      return;
    }

    let T = null, els = [], matches = [], cur = -1, marked = new Set(), matcher = null;
    const docEl = $('#doc');
    getLines(d).then((t) => {
      if (current.arg !== d.id) return;
      T = t;
      const CH = 200; let html = '';
      for (let c = 0; c < T.lines.length; c += CH) {
        html += '<div class="ch">';
        for (let i = c; i < Math.min(c + CH, T.lines.length); i++) {
          const isT = isRow(T.lines[i]);
          html += lineHtml(T.lines[i], T.lv[i], i, isT && i > 0 && isRow(T.lines[i - 1]), isT && i + 1 < T.lines.length && isRow(T.lines[i + 1]));
        }
        html += '</div>';
      }
      docEl.innerHTML = html;
      els = Array.from(docEl.querySelectorAll('[data-i]'));
      if (q0) { openFind(false); doFind(q0, at); }
    }).catch(() => {
      docEl.innerHTML = `<div class="empty">${icon('cloud-off')}<h2>Документ не сохранён на устройстве</h2>
        <p>Подключитесь к интернету один раз, чтобы приложение скачало тексты для работы офлайн.</p></div>`;
    });

    function renderLine(i, inner) {
      const l = T.lines[i], isT = isRow(l);
      const html = lineHtml(l, T.lv[i], i, isT && i > 0 && isRow(T.lines[i - 1]), isT && i + 1 < T.lines.length && isRow(T.lines[i + 1]), inner);
      const tmp = document.createElement('div'); tmp.innerHTML = html;
      const n = tmp.firstChild; els[i].replaceWith(n); els[i] = n;
    }
    function doFind(q, startAt) {
      if (!T) return;
      for (const i of marked) renderLine(i);
      marked.clear(); matches = []; cur = -1;
      matcher = makeMatcher(q, exact);
      if (matcher) {
        for (let i = 0; i < T.nl.length; i++) {
          if (!matcher.test(T.nl[i])) continue;
          const rr = matcher.ranges(T.nl[i]);
          const l = T.lines[i];
          let inner, n;
          if (isRow(l)) { const t = tableInner(l, rr, -1, matches.length); inner = t.html; n = t.n; }
          else { inner = hl(l, rr, -1, matches.length); n = rr.length; }
          for (let k = 0; k < n; k++) matches.push(i);
          renderLine(i, inner); marked.add(i);
        }
      }
      if (matches.length) {
        let k = 0;
        if (startAt != null) { k = matches.findIndex((i) => i >= startAt); if (k < 0) k = 0; }
        go(k);
      } else updCount();
    }
    function updCount() {
      const c = $('#fcount');
      c.textContent = !matcher ? '' : matches.length ? `${cur + 1} из ${matches.length}` : 'нет';
      $('#fprev').disabled = $('#fnext').disabled = matches.length < 2;
    }
    function go(k) {
      if (!matches.length) return;
      cur = (k + matches.length) % matches.length;
      const prev = docEl.querySelector('mark.cur'); if (prev) prev.classList.remove('cur');
      const m = docEl.querySelector(`mark[data-k="${cur}"]`);
      if (m) { m.classList.add('cur'); m.scrollIntoView({ block: 'center' }); }
      updCount();
    }
    function openFind(focus) {
      const fb = $('#findbar'); fb.hidden = false; $('#find').setAttribute('aria-pressed', 'true');
      if (focus) $('#fq').focus();
    }
    $('#find').addEventListener('click', () => {
      const fb = $('#findbar');
      if (fb.hidden) openFind(true);
      else { fb.hidden = true; $('#find').setAttribute('aria-pressed', 'false'); doFind(''); $('#fq').value = ''; $('#fq').closest('.search').classList.remove('has'); }
    });
    const fq = $('#fq');
    wireSearch(fq, (v) => doFind(v), 200);
    fq.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); go(cur + (e.shiftKey ? -1 : 1)); } });
    $('#fprev').addEventListener('click', () => go(cur - 1));
    $('#fnext').addEventListener('click', () => go(cur + 1));
    $('#toc').addEventListener('click', () => {
      if (!T) return;
      const items = [];
      T.lv.forEach((lv, i) => { if (lv) items.push(`<a class="l${lv}" href="#p${i}" data-i="${i}">${esc(T.lines[i])}</a>`); });
      openSheet('Содержание', items.length ? `<nav class="toc">${items.join('')}</nav>` : '<p class="hint" style="padding:12px 18px">В этом документе нет выделенных разделов.</p>');
      const sh = $('.sheet');
      sh.addEventListener('click', (e) => {
        const a = e.target.closest('a[data-i]'); if (!a) return;
        e.preventDefault(); closeSheet();
        const el = els[+a.dataset.i];
        el.scrollIntoView({ block: 'start' }); el.classList.add('flash'); setTimeout(() => el.classList.remove('flash'), 1500);
      });
    });
    $('#fs').addEventListener('click', () => {
      const v = store.get('fs', 17);
      openSheet('Размер текста', `<div class="fsz"><span style="font-size:14px">А</span>
        <input type="range" min="13" max="26" step="1" value="${v}" aria-label="Размер текста"><span style="font-size:24px">А</span></div>`);
      $('.fsz input').addEventListener('input', (e) => { document.documentElement.style.setProperty('--fs-doc', e.target.value + 'px'); store.set('fs', +e.target.value); });
    });
  }

  // ---------- Шторка ----------
  function openSheet(title, body) {
    closeSheet();
    const bg = document.createElement('div'); bg.className = 'sheet-bg';
    const sh = document.createElement('div'); sh.className = 'sheet'; sh.setAttribute('role', 'dialog'); sh.setAttribute('aria-modal', 'true'); sh.setAttribute('aria-label', title);
    sh.innerHTML = `<header><h2>${esc(title)}</h2><button class="ibtn" aria-label="Закрыть">${icon('x')}</button></header><div class="body">${body}</div>`;
    document.body.append(bg, sh);
    bg.addEventListener('click', closeSheet);
    sh.querySelector('header .ibtn').addEventListener('click', closeSheet);
    sh.querySelector('header .ibtn').focus();
  }
  function closeSheet() { document.querySelectorAll('.sheet, .sheet-bg').forEach((e) => e.remove()); }
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeSheet(); });

  // ---------- Тост ----------
  let tt;
  function toast(msg, action, fn) {
    const t = $('#toast');
    t.innerHTML = esc(msg) + (action ? ` <button type="button">${esc(action)}</button>` : '');
    if (action) t.querySelector('button').addEventListener('click', fn);
    t.classList.add('show');
    clearTimeout(tt);
    tt = setTimeout(() => t.classList.remove('show'), action ? 10000 : 2200);
  }

  // ---------- Офлайн ----------
  const TEXT_CACHE = 'npa-texts';
  const off = { done: 0, total: 0, running: false, saved: null };
  async function countSaved() {
    if (!('caches' in window)) return 0;
    const c = await caches.open(TEXT_CACHE);
    const keys = new Set((await c.keys()).map((r) => new URL(r.url).pathname.split('/').pop() + new URL(r.url).search));
    const need = DOCS.filter((d) => d.textUrl);
    off.total = need.length;
    off.saved = need.filter((d) => keys.has(d.textUrl.split('/').pop())).length;
    return off.saved;
  }
  async function saveAll() {
    if (off.running || !('caches' in window)) return;
    off.running = true;
    try { if (navigator.storage && navigator.storage.persist) await navigator.storage.persist(); } catch (e) { /* не критично */ }
    const c = await caches.open(TEXT_CACHE);
    const need = DOCS.filter((d) => d.textUrl);
    const wanted = new Set(need.map((d) => new URL(d.textUrl, location.href).href));
    for (const req of await c.keys()) if (!wanted.has(req.url)) await c.delete(req);
    off.total = need.length; off.done = 0;
    const queue = need.slice();
    let failed = 0;
    const work = async () => {
      while (queue.length) {
        const d = queue.shift();
        const url = new URL(d.textUrl, location.href).href;
        if (!(await c.match(url))) {
          try { const r = await fetch(url); if (r.ok) await c.put(url, r); else failed++; } catch (e) { failed++; }
        }
        off.done++; renderOfflineBanner(); renderOfflineInfo();
      }
    };
    await Promise.all([work(), work(), work()]);
    off.running = false;
    await countSaved();
    renderOfflineBanner(); renderOfflineInfo();
    if (!failed && off.saved === off.total) toast('Все документы доступны без интернета');
  }
  function renderOfflineBanner() {
    const el = $('#offline-banner'); if (!el) return;
    if (off.running) {
      el.innerHTML = `<div class="banner">${icon('cloud-off', 'sm')}<span>Сохраняю для офлайна ${off.done}/${off.total}</span><span class="bar"><i style="width:${Math.round(off.done / Math.max(1, off.total) * 100)}%"></i></span></div>`;
    } else el.innerHTML = '';
  }

  // ---------- О базе ----------
  function renderOfflineInfo() {
    const el = $('#offinfo'); if (!el) return;
    const all = off.saved != null && off.saved === off.total && off.total > 0;
    el.innerHTML = off.running
      ? `<div class="stat"><span class="spinner"></span> Сохраняю тексты: ${off.done} из ${off.total}</div>`
      : `<div class="stat">${all ? `<span class="ok">${icon('check')}</span>` : icon('cloud-off')}
          <span>${all ? 'Все тексты сохранены на устройстве' : `Сохранено ${off.saved || 0} из ${off.total} текстов`}</span></div>
          ${all ? '' : `<p style="margin:10px 0 0"><button class="btn" id="saveall" ${navigator.onLine ? '' : 'disabled'}>Сохранить все для офлайна</button></p>`}`;
    const b = $('#saveall'); if (b) b.addEventListener('click', saveAll);
  }
  function viewInfo() {
    const withText = DOCS.filter((d) => d.text).length;
    const ua = navigator.userAgent;
    const ios = /iPhone|iPad|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    const standalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone;
    const notes = (CAT.notes || '').split('\n').map((l) => l.replace(/^-\s*/, '').trim()).filter(Boolean);
    main.innerHTML = `
      <div class="top"><div class="wrap"><div class="hero"><h1>О базе</h1><p>Версия перечня от ${esc(CAT.asOf)}</p></div></div></div>
      <div class="wrap" style="padding-top:12px">
        <section class="card"><h2>Актуальность документов</h2><div id="updinfo"></div></section>
        <section class="card"><h2>Работа без интернета</h2><div id="offinfo"></div>
          <p style="margin:10px 0 0;font-size:14px;color:var(--text-3)">В базе ${DOCS.length} ${plural(DOCS.length, 'документ', 'документа', 'документов')}, полный текст есть у ${withText}. При подключении к сети приложение само проверяет обновления.</p></section>
        ${standalone ? '' : `<section class="card"><h2>Установить на устройство</h2>
          ${ios ? `<ol><li>Откройте эту страницу в Safari.</li><li>Нажмите «Поделиться» ${icon('share', 'sm')} внизу экрана.</li><li>Выберите «На экран “Домой”» и нажмите «Добавить».</li></ol>`
          : `<ul><li><b>Android, Chrome:</b> меню ⋮ → «Установить приложение».</li><li><b>Компьютер, Chrome или Edge:</b> значок установки в адресной строке.</li><li><b>iPhone и iPad:</b> Safari → «Поделиться» → «На экран “Домой”».</li></ul>`}
          <p style="font-size:14px;color:var(--text-3)">После установки приложение открывается с иконки и работает офлайн. Эта же ссылка открывается на любом телефоне, планшете и компьютере.</p></section>`}
        ${notes.length ? `<section class="card"><h2>Примечания к перечню</h2><ul>${notes.map((n) => `<li>${esc(n)}</li>`).join('')}</ul></section>` : ''}
        <section class="card"><h2>Важно</h2><p style="margin:0">Это справочная копия для работы. Юридическую силу имеют тексты, официально опубликованные на publication.pravo.gov.ru и в источниках официального опубликования.</p></section>
      </div>`;
    renderOfflineInfo();
    renderUpd();
  }

  // ---------- Service worker ----------
  function initSW() {
    if (!('serviceWorker' in navigator)) return;
    navigator.serviceWorker.register('sw.js').then((reg) => {
      reg.addEventListener('updatefound', () => {
        const nw = reg.installing;
        nw.addEventListener('statechange', () => {
          if (nw.state === 'installed' && navigator.serviceWorker.controller) {
            toast('Вышло обновление базы', 'Обновить', () => nw.postMessage('skipWaiting'));
          }
        });
      });
      setInterval(() => reg.update().catch(() => {}), 60 * 60 * 1000);
    }).catch(() => {});
    let reloaded = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => { if (!reloaded) { reloaded = true; location.reload(); } });
  }

  // ---------- Старт ----------
  (async function start() {
    document.documentElement.style.setProperty('--fs-doc', store.get('fs', 17) + 'px');
    try { await loadCatalog(); } catch (e) {
      main.innerHTML = `<div class="wrap"><div class="empty">${icon('cloud-off')}<h2>Не удалось открыть базу</h2><p>Откройте приложение один раз при подключении к интернету.</p></div></div>`;
      return;
    }
    window.addEventListener('hashchange', () => { ui.cameFromApp = true; }, { once: true });
    route();
    initSW();
    await countSaved();
    renderOfflineInfo();
    if (navigator.onLine && off.saved < off.total) await saveAll();
    const last = store.get('checkedAt', 0);
    if (navigator.onLine && Date.now() - last > 6 * 3600 * 1000) checkUpdates(false);
  })();
})();
