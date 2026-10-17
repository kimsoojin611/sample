/* 자율성과지표 성과관리 — 프런트엔드 (외부 라이브러리 없음) */
(function () {
  'use strict';

  // ---------- 상태 ----------
  const store = {
    data: null,
    rev: null,
    g: 0,
    sort: 'low',
    view: 'dashboard',
    dirty: {},
    key: lsGet('kpi-edit-key') || '',
    unlocked: true,
    editor: lsGet('kpi-editor') || '',
    staleNotice: false
  };
  const STATUS = ['확정', '잠정', '계획 포함', '부분 입력', '미측정', '미입력'];
  const POLL_MS = 15000;

  function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* 무시 */ } }

  // ---------- DOM 도우미 ----------
  function h(tag, props) {
    const el = document.createElement(tag);
    const kids = Array.prototype.slice.call(arguments, 2);
    applyProps(el, props);
    appendKids(el, kids);
    return el;
  }
  function sv(tag, attrs) {
    const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
    for (const k in attrs || {}) el.setAttribute(k, attrs[k]);
    appendKids(el, Array.prototype.slice.call(arguments, 2));
    return el;
  }
  function applyProps(el, props) {
    if (!props) return;
    for (const k in props) {
      const v = props[k];
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
      else if (k.slice(0, 2) === 'on' && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
      else el.setAttribute(k, v === true ? '' : v);
    }
  }
  function appendKids(el, kids) {
    kids.forEach(function add(c) {
      if (c == null || c === false) return;
      if (Array.isArray(c)) { c.forEach(add); return; }
      el.appendChild(typeof c === 'string' || typeof c === 'number' ? document.createTextNode(String(c)) : c);
    });
  }

  // ---------- 숫자·날짜 ----------
  const fmt = (v) => v == null ? '—' : (Number.isInteger(v) ? v.toLocaleString('ko-KR') : String(v));
  const f1 = (v) => (Math.round(v * 10) / 10).toFixed(1);
  function fmtDate(iso) {
    if (!iso) return '미기재';
    const p = iso.split('-');
    return "'" + p[0].slice(2) + '. ' + Number(p[1]) + '. ' + Number(p[2]);
  }
  function fmtDateTime(iso) {
    const d = new Date(iso);
    const pad = (n) => String(n).padStart(2, '0');
    return d.getFullYear() + '. ' + pad(d.getMonth() + 1) + '. ' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  }
  function elapsedPct() {
    const m = store.data.meta;
    const s = new Date(m.periodStart + 'T00:00:00');
    const e = new Date(m.periodEnd + 'T00:00:00'); e.setDate(e.getDate() + 1);
    return Math.max(0, Math.min(100, (Date.now() - s) / (e - s) * 100));
  }

  // ---------- 판정 ----------
  function sgOf(st) {
    if (st === '확정') return 'ok';
    if (st === '미측정') return 'none';
    if (st === '미입력') return 'missing';
    return 'prov';
  }
  function band(p) {
    if (p >= 90) return { label: '양호', color: 'var(--good)', critical: false };
    if (p >= 60) return { label: '주의', color: 'var(--warn)', critical: false };
    if (p >= 30) return { label: '미흡', color: 'var(--bad)', critical: false };
    return { label: '위험', color: 'var(--bad)', critical: true };
  }
  function derive() {
    const d = store.data;
    const subs = d.subs.map((s) => {
      const has = s.cur != null && s.cur !== '';
      const cur = has ? Number(s.cur) : null;
      return Object.assign({}, s, {
        cur,
        sg: sgOf(s.st),
        contrib: has ? cur / s.t3 * s.w : 0,
        pending: has ? 0 : s.t2 / s.t3 * s.w,
        prog: has ? cur / s.t2 * 100 : null,
        yoy: has && s.a1 != null ? cur / s.a1 * 100 : null,
        idx: d.indices.find((k) => k.id === s.g)
      });
    });
    const indices = d.indices.map((k) => {
      const mine = subs.filter((s) => s.g === k.id);
      const conf = mine.reduce((a, s) => a + s.contrib, 0);
      const pend = mine.reduce((a, s) => a + s.pending, 0);
      return Object.assign({}, k, { mine, conf, pend, prog: (conf + pend) / k.t2 * 100 });
    });
    return { subs, indices };
  }

  // ---------- 서버 통신 ----------
  async function api(method, url, body) {
    const opt = { method, headers: {} };
    if (body !== undefined) { opt.headers['Content-Type'] = 'application/json'; opt.body = JSON.stringify(body); }
    if (store.key) opt.headers['X-Edit-Key'] = store.key;
    const res = await fetch(url, opt);
    let json = null;
    try { json = await res.json(); } catch (e) { /* 무시 */ }
    if (!res.ok) { const err = new Error((json && json.error) || ('HTTP ' + res.status)); err.status = res.status; throw err; }
    return json;
  }
  async function loadData() {
    store.data = await api('GET', '/api/data');
    store.rev = store.data.meta.rev;
    setSync(true);
  }
  async function poll() {
    try {
      const r = await api('GET', '/api/rev');
      setSync(true);
      if (r.rev !== store.rev) {
        if (store.view === 'input' && Object.keys(store.dirty).length) {
          if (!store.staleNotice) { store.staleNotice = true; toast('다른 사용자가 데이터를 변경했습니다. 입력 중인 내용을 저장하면 반영됩니다.'); }
          return;
        }
        await loadData();
        render();
      }
    } catch (e) { setSync(false); }
  }
  function setSync(ok) {
    const el = document.getElementById('sync');
    el.className = 'sync ' + (ok ? 'ok' : 'err');
    document.getElementById('sync-text').textContent = ok
      ? (store.data && store.data.meta.updatedAt ? '실시간 공유 · ' + fmtDateTime(store.data.meta.updatedAt).slice(6) + ' 갱신' : '실시간 공유')
      : '서버 연결 끊김';
  }
  let toastTimer = null;
  function toast(msg, isErr) {
    const el = document.getElementById('toast');
    el.textContent = msg;
    el.className = 'toast show' + (isErr ? ' err' : '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.className = 'toast'; }, 3200);
  }

  // ---------- 툴팁 ----------
  let tipEl = null;
  function tipShow(text, x, y) {
    if (!tipEl) { tipEl = h('div', { class: 'viz-tip', role: 'tooltip' }); document.body.appendChild(tipEl); }
    tipEl.replaceChildren.apply(tipEl, text.split('\n').map((ln, i) => h(i === 0 ? 'b' : 'span', { text: ln })));
    tipEl.style.display = 'flex';
    const w = tipEl.offsetWidth, hgt = tipEl.offsetHeight;
    let left = x + 14, top = y + 16;
    if (left + w > window.innerWidth - 8) left = x - w - 14;
    if (top + hgt > window.innerHeight - 8) top = y - hgt - 12;
    tipEl.style.left = Math.max(8, left) + 'px';
    tipEl.style.top = Math.max(8, top) + 'px';
  }
  function tipHide() { if (tipEl) tipEl.style.display = 'none'; }
  function tipOn(el, text) {
    el.addEventListener('mouseenter', (e) => tipShow(text, e.clientX, e.clientY));
    el.addEventListener('mousemove', (e) => tipShow(text, e.clientX, e.clientY));
    el.addEventListener('mouseleave', tipHide);
    el.addEventListener('focus', () => { const r = el.getBoundingClientRect(); tipShow(text, r.left + Math.min(r.width, 240) / 2, r.bottom); });
    el.addEventListener('blur', tipHide);
  }
  window.addEventListener('scroll', tipHide, { passive: true });

  // ---------- 공통 조각 ----------
  function pill(s) { return h('span', { class: 'pill ' + s.sg, text: s.st }); }
  function bandChip(p) {
    const b = band(p);
    const icon = b.critical
      ? sv('svg', { width: 12, height: 12, viewBox: '0 0 24 24', 'aria-hidden': 'true' },
        sv('path', { d: 'M12 3 L22 20 H2 Z', fill: 'var(--bad)' }),
        sv('path', { d: 'M12 10v4M12 17v.5', stroke: '#fff', 'stroke-width': '2.4', 'stroke-linecap': 'round' }))
      : h('span', { class: 'dot', style: { background: b.color } });
    return h('span', { class: 'band' }, icon, b.label);
  }
  function bandLegend() {
    const items = [['90% 이상 양호', 'var(--good)'], ['60~90% 주의', 'var(--warn)'], ['30~60% 미흡', 'var(--bad)'], ['30% 미만 위험', 'var(--bad)'], ['미측정', 'var(--none)']];
    return h('span', { class: 'legend' }, h('b', { style: { color: 'var(--ink)', fontWeight: '500' }, text: '진척률 기준' }),
      items.map((i) => h('span', null, h('span', { class: 'sw', style: { background: i[1] } }), i[0])));
  }
  function cardHead(title, desc, right) {
    return h('div', { class: 'card-head' }, h('div', null, h('h2', { text: title }), desc ? h('p', { class: 'desc', text: desc }) : null), right || null);
  }
  function readout(placeholder) {
    const el = h('p', { class: 'readout', 'aria-live': 'polite', text: placeholder });
    return { el, set: (t) => { el.textContent = t; } };
  }

  // ---------- 대시보드 ----------
  function viewDashboard() {
    const { subs, indices } = derive();
    const el = elapsedPct();
    const inF = (s) => store.g === 0 || s.g === store.g;
    const m = store.data.meta;

    const head = h('div', { class: 'page-head' },
      h('div', { style: { display: 'flex', flexDirection: 'column', gap: '6px' } },
        h('span', { class: 'eyebrow', text: m.project + ' · ' + m.year }),
        h('h1', { text: '자율성과지표 진척 현황' }),
        h('span', { class: 'muted small', text: '측정기간 ' + m.periodStart.replace(/-/g, '. ') + ' ~ ' + m.periodEnd.replace(/-/g, '. ') + ' · 실적 원자료는 지표별 집계 시점 기준' })),
      h('div', { class: 'elapsed-box' },
        h('span', null, h('span', { class: 'muted small', text: '측정기간 경과율' }), h('strong', { text: f1(el) + '%' })),
        h('span', { class: 'bar-track', style: { width: '160px', flex: 'none' } }, h('span', { class: 'bar-fill', style: { width: el + '%', background: 'var(--primary)' } }))));

    const chips = h('div', { class: 'filters', role: 'group', 'aria-label': '지수 필터' },
      h('span', { class: 'muted small', style: { marginRight: '4px' }, text: '지수 선택' }),
      [{ id: 0, short: '전체' }].concat(indices).map((k) => h('button', {
        type: 'button', class: 'chip', 'aria-pressed': String(store.g === k.id), text: k.short,
        onClick: () => { store.g = k.id; render(); }
      })),
      bandLegend());

    // 1. 지수별 도넛 게이지 (링 전체 = 2차 목표)
    const R = 54, SW = 14, SIZE = 140, GC = 2 * Math.PI * R;
    const gauges = h('section', { class: 'card', 'aria-labelledby': 'c1' },
      h('div', { class: 'card-head' },
        h('div', null, h('h2', { id: 'c1', text: '지수별 잠정 진척률' }),
          h('p', { class: 'desc', text: '링 한 바퀴 = 2차년도 목표. 색 조각은 실적이 입력된 세부지표의 기여분(구간 색), 회색은 미측정 항목을 목표치로 가정한 몫입니다.' })),
        h('span', { class: 'legend' },
          h('span', null, h('span', { class: 'sw tri' }), '실적 기여분'),
          h('span', null, h('span', { class: 'sw', style: { background: 'var(--none)' } }), '미측정 가정분'))),
      h('div', { class: 'gauges' }, indices.filter((k) => store.g === 0 || k.id === store.g).map((k) => {
        const parts = [];
        k.mine.forEach((s) => { if (s.contrib > 0) parts.push({ v: s.contrib, color: band(s.prog).color, tip: s.name + '\n기여 ' + f1(s.contrib / k.t2 * 100) + '%p · 진척률 ' + f1(s.prog) + '% (' + band(s.prog).label + ')\n' + s.st }); });
        k.mine.forEach((s) => { if (s.pending > 0) parts.push({ v: s.pending, color: 'var(--none)', tip: s.name + '\n' + s.st + ' — 목표 달성 가정 ' + f1(s.pending / k.t2 * 100) + '%p (잠정)' }); });
        const total = parts.reduce((a, p) => a + p.v, 0);
        const scale = total > k.t2 ? k.t2 / total : 1;
        let acc = 0;
        const arcs = parts.map((p) => {
          const len = p.v / k.t2 * GC * scale;
          const gap = len > 6 ? 2 : 0;
          const arc = sv('circle', { cx: SIZE / 2, cy: SIZE / 2, r: R, fill: 'none', stroke: p.color, 'stroke-width': SW, 'stroke-dasharray': Math.max(0.1, len - gap) + ' ' + GC, 'stroke-dashoffset': String(-acc), class: 'g-arc' });
          tipOn(arc, k.short + ' · ' + p.tip);
          acc += len;
          return arc;
        });
        const confPct = k.conf / k.t2 * 100, pendPct = k.pend / k.t2 * 100;
        return h('div', { class: 'gauge' },
          h('div', { class: 'gauge-top' }, h('span', { class: 'gauge-name', text: k.short }), bandChip(k.prog)),
          h('div', { class: 'gauge-ring' },
            sv('svg', { width: SIZE, height: SIZE, viewBox: '0 0 ' + SIZE + ' ' + SIZE, role: 'img', 'aria-label': k.name + ' 잠정 진척률 ' + f1(k.prog) + '%, 실적 기여 ' + f1(confPct) + '%, 미측정 가정 ' + f1(pendPct) + '%' },
              sv('circle', { cx: SIZE / 2, cy: SIZE / 2, r: R, fill: 'none', stroke: 'var(--track)', 'stroke-width': SW }),
              sv('g', { transform: 'rotate(-90 ' + SIZE / 2 + ' ' + SIZE / 2 + ')' }, arcs)),
            h('span', { class: 'gauge-center' }, h('strong', { text: f1(k.prog) }), h('span', { text: '% 잠정' }))),
          h('div', { class: 'gauge-split' },
            h('span', null, h('b', { text: f1(confPct) + '%' }), '실적 기여'),
            h('span', null, h('b', { text: f1(pendPct) + '%' }), '미측정 가정')),
          h('ul', { class: 'gauge-subs' }, k.mine.map((s) => {
            const tip = s.name + '\n' + (s.prog != null ? fmt(s.cur) + ' / ' + fmt(s.t2) + s.unit + ' = ' + f1(s.prog) + '% (' + band(s.prog).label + ')' : s.st) + '\n가중치 ' + s.w + '%';
            const li = h('li', { tabindex: '0', 'aria-label': tip.replace(/\n/g, ', ') },
              h('span', { class: 'dot', style: { background: s.prog != null ? band(s.prog).color : 'var(--none)' } }),
              h('span', { class: 'gs-name', text: s.short }),
              h('span', { class: 'gs-w', text: s.w + '%' }),
              h('b', { class: s.prog == null ? 'muted' : '', text: s.prog != null ? f1(s.prog) + '%' : s.st }));
            tipOn(li, tip);
            return li;
          })),
          h('div', { class: 'gauge-foot' }, '1차년도 달성률 ', h('b', { text: k.r1 + '%' }), ' · 2차 목표 ' + k.t2));
      })));

    // 2. 세부지표 진척률 — 불릿 그래프 (구간 배경 + 목표선 + 경과율)
    const X = (v) => 'calc((100% - 64px) * ' + (Math.min(Math.max(v, 0), 100) / 100) + ')';
    const shown = subs.filter(inF);
    const measured = shown.filter((s) => s.prog != null);
    const pendingList = shown.filter((s) => s.prog == null);
    if (store.sort === 'low') measured.sort((a, b) => a.prog - b.prog);
    const bands = () => h('span', { class: 'bl-bands', 'aria-hidden': 'true' },
      h('i', { class: 'b0', style: { left: 0, width: X(30) } }),
      h('i', { class: 'b1', style: { left: X(30), width: 'calc((100% - 64px) * 0.3)' } }),
      h('i', { class: 'b2', style: { left: X(60), width: 'calc((100% - 64px) * 0.3)' } }),
      h('i', { class: 'b3', style: { left: X(90), width: 'calc((100% - 64px) * 0.1)' } }));
    const remain = (s) => {
      const gap = s.t2 - s.cur;
      if (gap <= 0) return h('span', { class: 'bl-gap ok', text: '목표 달성' });
      const v = Number.isInteger(gap) ? gap.toLocaleString('ko-KR') : f1(gap);
      return h('span', { class: 'bl-gap', text: '목표까지 ' + v + s.unit });
    };
    const blRow = (s) => {
      const b = band(s.prog);
      const tip = s.name + ' (' + s.idx.short + ')\n현재 ' + fmt(s.cur) + s.unit + ' / 2차 목표 ' + fmt(s.t2) + s.unit + ' → ' + f1(s.prog) + '% ' + b.label
        + '\n가중치 ' + s.w + '% · 경과율 대비 ' + (s.prog - el >= 0 ? '+' : '') + f1(s.prog - el) + '%p · ' + s.st + (s.asOf ? ' (' + fmtDate(s.asOf) + ' 기준)' : '') + (s.note ? '\n' + s.note : '');
      const row = h('div', { class: 'bl-row', tabindex: '0', role: 'listitem', 'aria-label': tip.replace(/\n/g, ', ') },
        h('div', { class: 'bl-label' },
          h('span', { class: 'bl-name', text: s.name }),
          h('span', { class: 'bl-meta' }, h('span', { class: 'idx-tag', text: s.idx.short.slice(0, 1) }), h('span', { class: 'bl-num' }, h('b', { text: fmt(s.cur) }), ' / ' + fmt(s.t2) + s.unit))),
        h('div', { class: 'bl-plot' },
          bands(),
          h('span', { class: 'bl-bar', style: { width: X(s.prog), background: b.color } }),
          s.prog > 100 ? h('span', { class: 'bl-over', style: { left: X(100) }, text: '▶' }) : null,
          h('span', { class: 'bl-target', style: { left: X(100) } }),
          h('span', { class: 'bl-el', style: { left: X(el) } }),
          h('span', { class: 'bl-val', style: { left: 'calc(' + X(s.prog > 78 ? 100 : s.prog) + ' + ' + (s.prog > 78 ? 10 : 8) + 'px)' }, text: f1(s.prog) + '%' })),
        h('div', { class: 'bl-status' }, bandChip(s.prog), remain(s)));
      tipOn(row, tip);
      return row;
    };
    const sortCtl = h('div', { class: 'seg', role: 'group', 'aria-label': '정렬' },
      [['low', '진척률 낮은 순'], ['idx', '지수순']].map((o) => h('button', { type: 'button', 'aria-pressed': String(store.sort === o[0]), text: o[1], onClick: () => { store.sort = o[0]; render(); } })));
    const progCard = h('section', { class: 'card grow', 'aria-labelledby': 'c3' },
      h('div', { class: 'card-head' },
        h('div', null, h('h2', { id: 'c3', text: '세부지표 진척률' }),
          h('p', { class: 'desc', text: '2차 목표 대비 실적. 배경 띠는 구간 경계(30·60·90%), 굵은 세로선은 목표, 가는 선은 오늘 경과율입니다.' })),
        sortCtl),
      h('div', { class: 'bl' },
        h('div', { class: 'bl-axis', 'aria-hidden': 'true' },
          h('div', { class: 'bl-label' }),
          h('div', { class: 'bl-plot' },
            [[0, '0'], [30, '30'], [60, '60'], [90, '90']].map((t) => h('span', { class: 'tick', style: { left: X(t[0]) }, text: t[1] })),
            h('span', { class: 'tick strong', style: { left: X(100) }, text: '목표' }),
            h('span', { class: 'el-tag', style: { left: X(el) }, text: '오늘 ' + Math.round(el) + '%' })),
          h('div', { class: 'bl-status' })),
        measured.length ? h('div', { role: 'list', 'aria-label': '실적이 입력된 세부지표' }, measured.map(blRow)) : h('div', { class: 'empty', text: '실적이 입력된 지표가 없습니다.' })),
      pendingList.length ? h('div', { class: 'bl-pending' },
        h('span', { class: 'bl-pending-title', text: '아직 실적이 없는 지표 ' + pendingList.length + '개' }),
        h('div', { class: 'bl-pending-list' }, pendingList.map((s) => {
          const why = s.kind === 'survey' ? '학년도 말 조사' : s.kind === 'ratio' ? '10.1자 재학인원 입력 필요' : '원자료 입력 필요';
          const it = h('div', { class: 'bl-pend', tabindex: '0', 'aria-label': s.name + ', ' + s.st + ', ' + why },
            h('span', { class: 'pill ' + s.sg, text: s.st }),
            h('span', { class: 'bl-pend-name', text: s.short }),
            h('span', { class: 'bl-pend-why', text: why }));
          tipOn(it, s.name + ' (' + s.idx.short + ')\n' + s.st + ' — ' + why + '\n2차 목표 ' + fmt(s.t2) + s.unit + ' · 담당 ' + s.dept);
          return it;
        }))) : null);

    // 3. 산점도
    const pts = subs.filter((s) => s.yoy != null && s.prog != null && inF(s));
    const plot = h('div', { class: 'scatter' },
      [25, 50, 75, 100].map((v) => h('span', { class: 'gx', style: { bottom: v + '%' } })),
      [25, 50, 75, 100].map((v) => h('span', { class: 'gy', style: { left: v + '%' } })),
      h('span', { class: 'refx', style: { left: 'calc(' + el + '% - 1px)' } }),
      h('span', { class: 'refy', style: { bottom: 'calc(' + el + '% - 1px)' } }),
      pts.map((s) => {
        const x = Math.min(100, s.prog), y = Math.min(100, s.yoy);
        const tip = s.name + '\n2차 목표 대비 ' + f1(s.prog) + '%\n전년 실적(' + fmt(s.a1) + s.unit + ') 대비 ' + f1(s.yoy) + '%';
        const lbl = h('span', { class: 'lbl', text: s.short, style: x > 70 ? { right: 'calc(' + (100 - x) + '% + 12px)', bottom: y + '%' } : { left: 'calc(' + x + '% + 12px)', bottom: y + '%' } });
        const pt = h('button', { type: 'button', class: 'pt', 'aria-label': tip.replace(/\n/g, ', '), style: { left: x + '%', bottom: y + '%' } }, h('i', { style: { background: band(s.prog).color } }));
        tipOn(pt, tip);
        return [pt, lbl];
      }),
      pts.length ? null : h('span', { class: 'quad', style: { bottom: '50%' }, text: '선택한 지수에 전년 실적이 있는 누적형 지표가 없습니다.' }));
    const scatter = h('section', { class: 'card side', 'aria-labelledby': 'c4' },
      h('div', null, h('h2', { id: 'c4', text: '목표 대비 vs 전년 실적 대비' }),
        h('p', { class: 'desc', text: '1차년도 실적이 있는 누적형 지표. 두 선은 오늘 경과율이며, 왼쪽 아래일수록 목표·전년 모두 뒤처진 지표입니다.' })),
      h('span', { class: 'muted', style: { fontSize: '12px', marginBottom: '-8px' }, text: '↑ 전년 실적 대비(%)' }),
      h('div', { class: 'scatter-wrap' },
        h('div', { class: 'scatter-col' }, plot,
          h('div', { class: 'axis-row' }, [0, 25, 50, 75, 100].map((v) => h('span', { style: { left: v + '%' }, text: String(v) }))),
          h('span', { class: 'muted', style: { fontSize: '12px', textAlign: 'center' }, text: '2차 목표 대비 진척률(%) →' }))));

    // 4. 데이터 상태 도넛
    const groups = [['ok', '확정', 'var(--primary)'], ['prov', '잠정·부분', '#86b6ef'], ['none', '미측정', 'var(--none)'], ['missing', '미입력', 'var(--warn)']];
    const C = 2 * Math.PI * 62;
    let acc = 0;
    const arcs = [], leg = [];
    groups.forEach((g) => {
      const list = subs.filter((s) => s.sg === g[0]);
      const len = list.length / subs.length * C;
      if (list.length) {
        const a = sv('circle', { cx: 84, cy: 84, r: 62, fill: 'none', stroke: g[2], 'stroke-width': 20, 'stroke-dasharray': Math.max(0, len - 3) + ' ' + C, 'stroke-dashoffset': String(-acc), class: 'g-arc' });
        tipOn(a, g[1] + ' ' + list.length + '개\n' + list.map((s) => s.short).join(', '));
        arcs.push(a);
      }
      acc += len;
      leg.push(h('div', null, h('span', { class: 'sw', style: { background: g[2] } }),
        h('span', null, h('b', { text: g[1] + ' ' + list.length + '개' }), h('br'), h('span', { class: 'muted', text: list.map((s) => s.short).join(', ') || '없음' }))));
    });
    const okN = subs.filter((s) => s.sg === 'ok').length;
    const donut = h('section', { class: 'card side', 'aria-labelledby': 'c2' },
      cardHead('실적 데이터 상태', '세부지표 ' + subs.length + '개 기준'),
      h('div', { class: 'donut-box' },
        h('div', { class: 'donut' },
          sv('svg', { width: 168, height: 168, viewBox: '0 0 168 168', role: 'img', 'aria-label': groups.map((g) => g[1] + ' ' + subs.filter((s) => s.sg === g[0]).length + '개').join(', ') },
            sv('g', { transform: 'rotate(-90 84 84)' }, arcs)),
          h('span', { class: 'donut-center' }, h('strong', null, String(okN), h('span', { class: 'muted', style: { fontSize: '15px', fontWeight: '500' }, text: '/' + subs.length })), h('span', { class: 'muted', style: { fontSize: '12px' }, text: '확정' }))),
        h('div', { class: 'donut-legend' }, leg)));

    // 5. 유의사항 (도넛 옆 카드)
    const notes = h('section', { class: 'card grow', 'aria-labelledby': 'nt' },
      h('h2', { id: 'nt', text: '해석 시 유의사항' }),
      h('div', { class: 'notes' }, [
        ['지수만 보면 부진 항목이 가려집니다', '분모가 3차 목표라 가중치 큰 조사형 항목이 지수를 끌어올립니다. 세부지표 진척률을 함께 확인하세요.'],
        ['유형별로 읽는 법이 다릅니다', '누적형은 경과율과 비교, 조사형은 학년도 말 1회 측정, 유지율은 10.1자 1회 확정입니다.'],
        ['2차 목표가 전년 실적보다 낮습니다', '진로·취업(535 < 595), 협력교육(1,197 < 1,240), AI 학습지원(61 < 65). 목표를 넘어도 전년보다 줄 수 있습니다.'],
        ['세부지수 상한 규정이 없습니다', '1차년도에 3차 목표를 넘은 값(1,240/1,209 등)을 그대로 반영했습니다. 전문기관 인정 여부 확인이 필요합니다.']
      ].map((n) => h('div', { class: 'note' }, h('b', { text: n[0] }), h('span', { text: n[1] })))));

    // 6. 수치표
    const rows = subs.filter(inF);
    const table = h('section', { class: 'card flush', 'aria-labelledby': 'tbl' },
      h('div', { class: 'card-head' },
        h('div', null, h('h2', { id: 'tbl', text: '세부지표 수치표' }), h('p', { class: 'desc', text: '정의서 연차별 목표 · 1차년도 실적 · 2차년도 실적 · 정정 반영값' })),
        h('div', { style: { display: 'flex', gap: '8px' } },
          h('button', { type: 'button', class: 'btn', text: 'CSV(엑셀) 내보내기', onClick: () => exportCsv(rows) }),
          h('button', { type: 'button', class: 'btn', text: '인쇄', onClick: () => window.print() }))),
      h('div', { class: 'table-wrap' },
        h('table', { style: { minWidth: '1180px' } },
          h('thead', null, h('tr', null, ['지수', '세부지표', '가중치', '기준', '1차 목표', '1차 실적', '2차 목표', '현재', '진척률', '3차 목표', '상태', '집계 시점', '관리부서']
            .map((c, i) => h('th', { scope: 'col', class: i >= 2 && i <= 9 ? 'r' : '', text: c })))),
          h('tbody', null, rows.map((s) => h('tr', null,
            h('td', { class: 'muted nowrap', text: s.idx.short }),
            h('td', null, h('b', { style: { fontWeight: '500' }, text: s.name }), ' ', h('span', { class: 'muted', text: '(' + s.unit + ')' })),
            h('td', { class: 'r muted', text: s.w + '%' }),
            h('td', { class: 'r muted', text: fmt(s.base) }),
            h('td', { class: 'r muted', text: fmt(s.t1) }),
            h('td', { class: 'r', text: s.a1 == null ? '미기재' : fmt(s.a1) }),
            h('td', { class: 'r', text: fmt(s.t2) }),
            h('td', { class: 'r', style: { fontWeight: '600' }, text: fmt(s.cur) }),
            h('td', { class: 'r nowrap', style: { fontWeight: '600' } }, s.prog != null ? h('span', { class: 'dot', style: { background: band(s.prog).color, marginRight: '6px' } }) : null, s.prog != null ? f1(s.prog) + '%' : '—'),
            h('td', { class: 'r muted', text: fmt(s.t3) }),
            h('td', null, pill(s)),
            h('td', { class: 'muted nowrap', text: s.kind === 'survey' && s.cur == null ? '학년도 말' : fmtDate(s.asOf) }),
            h('td', { class: 'muted', text: s.dept })))))),
      h('p', { class: 'table-note', text: '정정 반영: ① 1·2차 목표 76.5·88.3(산출식 표 71.6·85.9 오기), ② 1차 유지율 실적 90.8(산출식 91.2 오기). 지수 목표·실적은 정의서 총괄표 기준입니다.' }));

    // 7. 점검 요약
    const open = store.data.checks.filter((c) => !c.done);
    const checks = h('section', { class: 'card flush', 'aria-labelledby': 'ck' },
      h('div', { class: 'card-head' },
        h('h2', { id: 'ck', text: '데이터 점검 필요 항목' }),
        h('span', { class: 'muted small' }, '미처리 ' + open.length + ' / 전체 ' + store.data.checks.length + ' · ', h('a', { href: '#/checks', text: '처리하기' }))),
      open.length ? h('div', { class: 'checks' }, open.map(checkItem)) : h('div', { class: 'empty', text: '모든 점검 항목이 처리되었습니다.' }));

    return [head, gauges, chips,
      h('div', { class: 'row' }, progCard, scatter),
      h('div', { class: 'row' }, donut, notes),
      table, checks];
  }

  function tagClass(t) { return t === '수정' ? 'fix' : t === '확인' ? 'ask' : 'tidy'; }
  function checkItem(c, withToggle) {
    return h('div', { class: 'check' + (c.done ? ' done' : '') },
      h('span', { class: 'tag ' + tagClass(c.tag), text: c.tag }),
      h('span', { class: 'check-body' }, h('span', { class: 'check-title', text: c.title }), h('span', { class: 'muted small', text: [c.src, c.detail].filter(Boolean).join(' · ') })),
      withToggle === true ? h('label', null,
        h('input', { type: 'checkbox', checked: c.done, disabled: !store.unlocked, onChange: (e) => toggleCheck(c, e.target) }), '처리 완료') : null);
  }

  function exportCsv(rows) {
    const head = ['지수', '세부지표', '단위', '가중치(%)', '기준', '1차 목표', '1차 실적', '2차 목표', '현재', '진척률(%)', '구간', '3차 목표', '상태', '집계 시점', '관리부서', '비고'];
    const q = (v) => '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"';
    const lines = [head.map(q).join(',')].concat(rows.map((s) => [
      s.idx.name, s.name, s.unit, s.w, s.base, s.t1, s.a1, s.t2, s.cur, s.prog == null ? '' : f1(s.prog), s.prog == null ? '' : band(s.prog).label, s.t3, s.st, s.asOf, s.dept, s.note
    ].map(q).join(',')));
    const blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
    const a = h('a', { href: URL.createObjectURL(blob), download: '자율성과지표_' + new Date().toISOString().slice(0, 10) + '.csv' });
    document.body.appendChild(a); a.click(); a.remove();
  }

  // ---------- 잠금(수정 키) ----------
  function lockBanner() {
    return h('div', { class: 'lock-banner' },
      h('span', null, h('b', { text: '누구나 수정 가능' }), h('span', { class: 'muted small', text: ' · 저장하면 모든 접속자 화면에 반영되고 변경 이력에 남습니다.' })),
      h('div', { class: 'edit-bar' },
        h('label', { class: 'field' }, '입력자 이름', h('input', { class: 'input', value: store.editor, placeholder: '예: 홍길동(IR센터)', maxlength: 40, onInput: (e) => { store.editor = e.target.value; lsSet('kpi-editor', store.editor); } })),
        h('a', { class: 'btn', href: '/api/export', download: '', style: { display: 'inline-flex', alignItems: 'center', textDecoration: 'none' }, text: '백업 내려받기' })));
  }

  // ---------- 실적 입력 ----------
  function viewInput() {
    const { subs } = derive();
    const head = h('div', { class: 'page-head' },
      h('div', null, h('span', { class: 'eyebrow', text: '2차년도 실적 관리' }), h('h1', { text: '실적 입력' }),
        h('p', { class: 'desc', text: '현재값은 세부운영지수 합계를 입력합니다. 조사형 지표는 학년도 말 결과가 나오면 입력하고 상태를 "확정"으로 바꾸세요.' })));
    const rowsEls = subs.map((s) => {
      const src = store.data.subs.find((x) => x.id === s.id);
      const d = store.dirty[s.id] || {};
      const val = (k) => (k in d ? d[k] : src[k]);
      const mark = (k, v) => {
        store.dirty[s.id] = Object.assign({}, store.dirty[s.id], { [k]: v });
        tr.classList.add('row-dirty');
        saveBtn.disabled = false;
        updateSaveAll();
      };
      const cur = h('input', { class: 'input num-in', type: 'number', step: 'any', min: '0', value: val('cur') == null ? '' : val('cur'), disabled: !store.unlocked, 'aria-label': s.name + ' 현재값', onInput: (e) => mark('cur', e.target.value === '' ? null : e.target.value) });
      const st = h('select', { class: 'select', disabled: !store.unlocked, 'aria-label': s.name + ' 상태', onChange: (e) => mark('st', e.target.value) },
        STATUS.map((o) => h('option', { value: o, selected: o === val('st'), text: o })));
      const asOf = h('input', { class: 'input date-in', type: 'date', value: val('asOf') || '', disabled: !store.unlocked, 'aria-label': s.name + ' 집계 시점', onInput: (e) => mark('asOf', e.target.value) });
      const note = h('input', { class: 'input note-in', type: 'text', maxlength: 300, value: val('note') || '', disabled: !store.unlocked, 'aria-label': s.name + ' 비고', onInput: (e) => mark('note', e.target.value) });
      const saveBtn = h('button', { type: 'button', class: 'btn primary', text: '저장', disabled: !store.unlocked || !store.dirty[s.id], onClick: () => saveSub(s.id) });
      const tr = h('tr', { class: store.dirty[s.id] ? 'row-dirty' : '' },
        h('td', { class: 'muted nowrap', text: s.idx.short }),
        h('td', { style: { minWidth: '240px' } }, h('b', { style: { fontWeight: '500' }, text: s.name }), h('br'), h('span', { class: 'muted small', text: s.dept })),
        h('td', { class: 'r nowrap', text: fmt(s.t2) + ' ' + s.unit }),
        h('td', { class: 'r nowrap' }, cur, ' ', h('span', { class: 'muted small', text: s.unit })),
        h('td', { class: 'r nowrap' }, s.prog != null ? bandChip(s.prog) : h('span', { class: 'muted small', text: '—' }), ' ', s.prog != null ? f1(s.prog) + '%' : ''),
        h('td', null, st),
        h('td', null, asOf),
        h('td', { style: { minWidth: '240px' } }, note),
        h('td', null, saveBtn));
      return tr;
    });
    const saveAll = h('button', { type: 'button', class: 'btn primary', text: '변경 모두 저장', onClick: saveAllDirty });
    function updateSaveAll() { const n = Object.keys(store.dirty).length; saveAll.disabled = !store.unlocked || !n; saveAll.textContent = n ? '변경 ' + n + '건 모두 저장' : '변경 모두 저장'; }
    updateSaveAll();
    const table = h('section', { class: 'card flush' },
      h('div', { class: 'card-head' }, h('div', null, h('h2', { text: '세부지표 실적' }), h('p', { class: 'desc', text: '진척률 = 현재값 ÷ 2차 목표' })), saveAll),
      h('div', { class: 'table-wrap' }, h('table', { class: 'edit-grid', style: { minWidth: '1320px' } },
        h('thead', null, h('tr', null, ['지수', '세부지표', '2차 목표', '현재값', '진척률', '상태', '집계 시점', '비고', ''].map((c, i) => h('th', { scope: 'col', class: i === 2 || i === 3 || i === 4 ? 'r' : '', text: c })))),
        h('tbody', null, rowsEls))));
    return [head, lockBanner(), table];
  }

  async function saveSub(id) {
    const d = store.dirty[id];
    if (!d) return;
    try {
      await api('PUT', '/api/subs/' + id, Object.assign({}, d, { editor: store.editor, rev: store.rev }));
      delete store.dirty[id];
      await loadData();
      store.staleNotice = false;
      render();
      toast('저장했습니다.');
    } catch (e) {
      if (e.status === 401) { store.unlocked = false; render(); }
      toast(e.message, true);
    }
  }
  async function saveAllDirty() {
    const ids = Object.keys(store.dirty);
    for (const id of ids) {
      try { await api('PUT', '/api/subs/' + id, Object.assign({}, store.dirty[id], { editor: store.editor })); delete store.dirty[id]; }
      catch (e) { toast(e.message, true); if (e.status === 401) { store.unlocked = false; } break; }
    }
    await loadData();
    store.staleNotice = false;
    render();
    if (!Object.keys(store.dirty).length) toast(ids.length + '건 저장했습니다.');
  }

  // ---------- 데이터 점검 ----------
  async function toggleCheck(c, box) {
    try {
      await api('PUT', '/api/checks/' + c.id, { done: box.checked, editor: store.editor });
      await loadData(); render(); toast(box.checked ? '처리 완료로 표시했습니다.' : '미처리로 되돌렸습니다.');
    } catch (e) { box.checked = !box.checked; toast(e.message, true); }
  }
  function viewChecks() {
    const all = store.data.checks;
    const order = { '수정': 0, '확인': 1, '정리': 2 };
    const sorted = all.slice().sort((a, b) => (a.done - b.done) || (order[a.tag] - order[b.tag]));
    const tagSel = h('select', { class: 'select', disabled: !store.unlocked, 'aria-label': '구분' }, ['수정', '확인', '정리'].map((t) => h('option', { value: t, text: t })));
    const title = h('input', { class: 'input', maxlength: 80, placeholder: '점검 항목', disabled: !store.unlocked, 'aria-label': '점검 항목', style: { flex: '1 1 220px' } });
    const src = h('input', { class: 'input', maxlength: 40, placeholder: '출처(예: 엑셀 세부현황)', disabled: !store.unlocked, 'aria-label': '출처', style: { flex: '1 1 160px' } });
    const detail = h('input', { class: 'input', maxlength: 200, placeholder: '내용', disabled: !store.unlocked, 'aria-label': '내용', style: { flex: '2 1 280px' } });
    const add = async () => {
      try {
        await api('POST', '/api/checks', { tag: tagSel.value, title: title.value, src: src.value, detail: detail.value, editor: store.editor });
        await loadData(); render(); toast('점검 항목을 추가했습니다.');
      } catch (e) { toast(e.message, true); }
    };
    return [
      h('div', { class: 'page-head' }, h('div', null, h('span', { class: 'eyebrow', text: '정의서·실적 파일 정합성' }), h('h1', { text: '데이터 점검' }))),
      lockBanner(),
      h('section', { class: 'card' }, cardHead('점검 항목 추가'),
        h('div', { class: 'edit-bar' }, tagSel, title, src, detail, h('button', { type: 'button', class: 'btn primary', text: '추가', disabled: !store.unlocked, onClick: add }))),
      h('section', { class: 'card flush' },
        h('div', { class: 'card-head' }, h('h2', { text: '점검 목록' }), h('span', { class: 'muted small', text: '미처리 ' + all.filter((c) => !c.done).length + ' / 전체 ' + all.length })),
        h('div', { class: 'checks' }, sorted.map((c) => checkItem(c, true))))
    ];
  }

  // ---------- 변경 이력 ----------
  function describe(item) {
    const names = { cur: '현재값', st: '상태', asOf: '집계 시점', note: '비고', done: '처리' };
    if (item.type === 'check-add') return '점검 항목 추가';
    return Object.keys(item.changes || {}).map((k) => {
      const c = item.changes[k];
      const v = (x) => x === true ? '완료' : x === false ? '미처리' : (x == null || x === '' ? '—' : String(x));
      return names[k] + ' ' + v(c.from) + ' → ' + v(c.to);
    }).join(', ');
  }
  function viewHistory() {
    const box = h('section', { class: 'card flush' }, cardHead('최근 변경 200건', '저장할 때마다 자동으로 기록됩니다.'), h('div', { class: 'empty', text: '불러오는 중…' }));
    api('GET', '/api/history?limit=200').then((list) => {
      box.lastChild.remove();
      if (!list.length) { box.appendChild(h('div', { class: 'empty', text: '아직 변경 이력이 없습니다.' })); return; }
      box.appendChild(h('div', { class: 'hist' }, list.map((it) => h('div', { class: 'hist-item' },
        h('span', { class: 'when', text: fmtDateTime(it.at) }),
        h('span', null, h('b', { style: { fontWeight: '500' }, text: it.label }), h('br'), h('span', { class: 'muted small', text: describe(it) })),
        h('span', { class: 'who', text: it.editor + ' · ' + it.ip })))));
    }).catch((e) => { box.lastChild.textContent = e.message; });
    return [h('div', { class: 'page-head' }, h('div', null, h('span', { class: 'eyebrow', text: '감사 추적' }), h('h1', { text: '변경 이력' }))), box];
  }

  // ---------- AI 요약보고서 ----------
  const LOCAL_MODE = false;
  const AI_KEY_LS = 'kpi-ai-key', AI_MODEL_LS = 'kpi-ai-model';
  const rpt = { open: false, facts: null, report: null, aiState: 'idle', aiMsg: '', aiReady: false, lastFocus: null };

  async function aiAvailable() {
    if (LOCAL_MODE) return !!lsGet(AI_KEY_LS);
    try { const r = await api('GET', '/api/report/status'); return !!r.ai; } catch (e) { return false; }
  }
  async function fetchAi(facts) {
    if (!LOCAL_MODE) { const r = await api('POST', '/api/report/ai'); return r.report; }
    const key = lsGet(AI_KEY_LS);
    const model = lsGet(AI_MODEL_LS) || 'claude-sonnet-5-5';
    const prompt = ReportCore.buildPrompt(facts);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 90000);
    try {
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST', signal: ctrl.signal,
        headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json', 'anthropic-dangerous-direct-browser-access': 'true' },
        body: JSON.stringify({ model, max_tokens: 2000, system: prompt.system, messages: [{ role: 'user', content: prompt.user }] })
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error((j.error && j.error.message) || ('Claude API 오류 ' + res.status));
      const out = ReportCore.parseAi((j.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n'));
      if (!out) throw new Error('AI 응답을 해석하지 못했습니다.');
      out.model = model;
      return out;
    } catch (e) {
      if (e.name === 'AbortError') throw new Error('응답 시간 초과');
      if (e instanceof TypeError) throw new Error('인터넷 연결 또는 브라우저 보안 설정으로 API에 접속하지 못했습니다.');
      throw e;
    } finally { clearTimeout(timer); }
  }

  async function openReport() {
    rpt.facts = ReportCore.computeFacts(store.data, new Date());
    rpt.report = ReportCore.ruleReport(rpt.facts);
    rpt.aiState = 'idle'; rpt.aiMsg = '';
    rpt.open = true;
    rpt.lastFocus = document.activeElement;
    document.body.classList.add('modal-open');
    paintReport();
    const close = document.querySelector('.modal .modal-close');
    if (close) close.focus();
    rpt.aiReady = await aiAvailable();
    if (rpt.aiReady) runAi(); else paintReport();
  }
  async function runAi() {
    rpt.aiState = 'loading'; rpt.aiMsg = ''; paintReport();
    try {
      const r = await fetchAi(rpt.facts);
      if (!rpt.open) return;
      rpt.report = r; rpt.aiState = 'done';
    } catch (e) {
      rpt.aiState = 'error'; rpt.aiMsg = e.message;
    }
    if (rpt.open) paintReport();
  }
  function closeReport() {
    rpt.open = false;
    document.body.classList.remove('modal-open');
    const root = document.getElementById('modal-root');
    if (root) root.replaceChildren();
    if (rpt.lastFocus && rpt.lastFocus.focus) rpt.lastFocus.focus();
  }

  function reportText() { return ReportCore.toPlainText(rpt.report, rpt.facts); }
  function copyText(text) {
    const fallback = () => {
      const ta = h('textarea', { style: { position: 'fixed', left: '-9999px', top: '0' } });
      ta.value = text; document.body.appendChild(ta); ta.select();
      let ok = false; try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
      ta.remove(); return ok;
    };
    if (navigator.clipboard && window.isSecureContext) return navigator.clipboard.writeText(text).then(() => true, fallback);
    return Promise.resolve(fallback());
  }
  async function shareReport() {
    const text = reportText();
    if (navigator.share) {
      try { await navigator.share({ title: '자율성과지표 요약보고 ' + rpt.facts.reportDate, text }); return; }
      catch (e) { if (e.name === 'AbortError') return; }
    }
    const ok = await copyText(text);
    toast(ok ? '요약 내용을 복사했습니다. 메신저 대화창에 붙여넣기(Ctrl+V) 하세요.' : '복사하지 못했습니다. 보고서 내용을 직접 선택해 복사해 주세요.', !ok);
  }
  async function mailReport() {
    let body = reportText();
    const subject = '[보고] 자율성과지표 ' + rpt.facts.year + ' 진척 요약 (' + rpt.facts.reportDate + ')';
    if (body.length > 1800) {
      await copyText(body);
      body = body.slice(0, 1700) + '\n…\n(전체 내용은 클립보드에 복사되어 있습니다. 붙여넣기 하거나 PDF를 첨부해 주세요.)';
    }
    window.location.href = 'mailto:?subject=' + encodeURIComponent(subject) + '&body=' + encodeURIComponent(body);
  }
  function printReport(asPdf) {
    const root = document.documentElement;
    const prevTheme = root.getAttribute('data-theme');
    const prevTitle = document.title;
    root.setAttribute('data-theme', 'light');
    document.body.classList.add('print-report');
    document.title = '자율성과지표_요약보고_' + rpt.facts.reportDateIso.replace(/-/g, '');
    const restore = () => {
      document.body.classList.remove('print-report');
      if (prevTheme) root.setAttribute('data-theme', prevTheme); else root.removeAttribute('data-theme');
      document.title = prevTitle;
      window.removeEventListener('afterprint', restore);
    };
    window.addEventListener('afterprint', restore);
    if (asPdf) toast('인쇄 창의 "대상(프린터)"에서 "PDF로 저장"을 선택하세요.');
    setTimeout(() => { window.print(); setTimeout(restore, 1000); }, asPdf ? 600 : 50);
  }

  function icon(d) {
    return sv('svg', { width: 16, height: 16, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': 1.8, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' }, sv('path', { d }));
  }
  const ICONS = {
    share: 'M4 12v7a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-7M16 6l-4-4-4 4M12 2v14',
    mail: 'M3 6h18v12H3zM3 7l9 6 9-6',
    copy: 'M9 9h11v11H9zM5 15H4V4h11v1',
    pdf: 'M14 3H6a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8zM14 3v5h5M9 13h6M9 17h6',
    print: 'M6 9V3h12v6M6 18H4v-6a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v6h-2M7 14h10v7H7z',
    close: 'M6 6l12 12M18 6L6 18',
    redo: 'M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7'
  };
  function actBtn(label, ic, fn, primary) {
    return h('button', { type: 'button', class: 'btn act' + (primary ? ' primary' : ''), onClick: fn }, icon(ICONS[ic]), h('span', { text: label }));
  }

  function aiSettings() {
    if (!LOCAL_MODE) {
      if (rpt.aiReady) return null;
      return h('p', { class: 'ai-note', text: '지금은 규칙 기반 자동 요약입니다. Netlify 환경 변수에 ANTHROPIC_API_KEY를 등록하면 AI가 총평·이슈·제언 문장을 작성합니다(README 참고).' });
    }
    const keyIn = h('input', { class: 'input', type: 'password', autocomplete: 'off', placeholder: 'sk-ant-…', value: lsGet(AI_KEY_LS) || '', 'aria-label': 'Claude API 키', style: { flex: '1 1 240px' } });
    const modelSel = h('select', { class: 'select', 'aria-label': '모델' },
      [['claude-sonnet-5-5', 'Claude Sonnet 5.5 (권장)'], ['claude-haiku-5-5', 'Claude Haiku 5.5 (빠름)'], ['claude-opus-5-5', 'Claude Opus 5.5']]
        .map((o) => h('option', { value: o[0], selected: (lsGet(AI_MODEL_LS) || 'claude-sonnet-5-5') === o[0], text: o[1] })));
    return h('details', { class: 'ai-settings', open: !lsGet(AI_KEY_LS) ? true : null },
      h('summary', { text: lsGet(AI_KEY_LS) ? 'AI 설정 (Claude 연결됨)' : 'AI 설정 — Claude API 키를 넣으면 AI가 문장을 작성합니다' }),
      h('div', { class: 'edit-bar', style: { marginTop: '10px' } }, keyIn, modelSel,
        h('button', { type: 'button', class: 'btn primary', text: '저장 후 AI 작성', onClick: () => { lsSet(AI_KEY_LS, keyIn.value.trim()); lsSet(AI_MODEL_LS, modelSel.value); rpt.aiReady = !!keyIn.value.trim(); if (rpt.aiReady) runAi(); else paintReport(); } }),
        h('button', { type: 'button', class: 'btn', text: '키 삭제', onClick: () => { lsSet(AI_KEY_LS, ''); rpt.aiReady = false; rpt.report = ReportCore.ruleReport(rpt.facts); rpt.aiState = 'idle'; paintReport(); } })),
      h('p', { class: 'ai-note', text: '키는 이 브라우저에만 저장되고, AI 작성 시 지표 수치가 Anthropic API로 전송됩니다. 공용 PC에서는 사용 후 키를 삭제하세요. 키는 console.anthropic.com 에서 발급합니다.' }));
  }

  function paintReport() {
    if (!rpt.open) return;
    let root = document.getElementById('modal-root');
    if (!root) { root = h('div', { id: 'modal-root', class: 'modal-root' }); document.body.appendChild(root); }
    const F = rpt.facts, R = rpt.report;
    const srcBadge = rpt.aiState === 'loading'
      ? h('span', { class: 'src-badge loading' }, h('span', { class: 'spin', 'aria-hidden': 'true' }), 'Claude 작성 중')
      : R.source === 'ai'
        ? h('span', { class: 'src-badge ai', text: 'AI 작성 · ' + (R.model || 'Claude') })
        : h('span', { class: 'src-badge rule', text: '자동 요약(규칙 기반)' });
    const status = rpt.aiState === 'loading'
      ? h('p', { class: 'ai-note', role: 'status', text: 'Claude가 총평·이슈·제언을 작성하고 있습니다. 아래는 먼저 생성된 자동 요약입니다.' })
      : rpt.aiState === 'error'
        ? h('p', { class: 'ai-note err', role: 'status', text: 'AI 요약을 받지 못해 자동 요약을 표시합니다 — ' + rpt.aiMsg })
        : null;

    const doc = h('article', { class: 'report-doc', 'aria-labelledby': 'rpt-title' },
      h('header', { class: 'rd-head' },
        h('span', { class: 'rd-org', text: F.org + ' · ' + F.project }),
        h('h2', { id: 'rpt-title', text: '자율성과지표 ' + F.year + ' 진척 요약보고' }),
        h('div', { class: 'rd-meta' },
          h('span', null, '기준일 ', h('b', { text: F.reportDate })),
          h('span', null, '측정기간 경과율 ', h('b', { text: ReportCore.f1(F.elapsed) + '%' })),
          h('span', null, '데이터 갱신 ', h('b', { text: F.dataUpdatedAt ? fmtDateTime(F.dataUpdatedAt) : '초기 데이터' })),
          srcBadge)),
      h('section', { class: 'rd-sec' }, h('h3', { text: '1. 총평' }), h('p', { class: 'rd-summary', text: R.summary })),
      h('section', { class: 'rd-sec' }, h('h3', { text: '2. 지수별 잠정 진척률' }),
        h('table', { class: 'rd-table' },
          h('thead', null, h('tr', null, ['지수', '2차 목표', '잠정 진척률', '', '구간', '1차 달성률'].map((c, i) => h('th', { scope: 'col', class: i === 1 || i === 2 || i === 5 ? 'r' : '', text: c })))),
          h('tbody', null, F.indices.map((k) => h('tr', null,
            h('td', { text: k.short }),
            h('td', { class: 'r', text: String(k.t2) }),
            h('td', { class: 'r', style: { fontWeight: '600' }, text: ReportCore.f1(k.prog) + '%' }),
            h('td', { style: { width: '28%' } }, h('span', { class: 'bar-track', style: { display: 'block', height: '6px' } }, h('span', { class: 'bar-fill', style: { width: Math.min(100, k.prog) + '%', background: band(k.prog).color } }))),
            h('td', null, bandChip(k.prog)),
            h('td', { class: 'r', text: k.r1 + '%' })))))),
      R.issues.length ? h('section', { class: 'rd-sec' }, h('h3', { text: '3. 주요 이슈' }), h('ul', null, R.issues.map((s) => h('li', { text: s })))) : null,
      R.actions.length ? h('section', { class: 'rd-sec' }, h('h3', { text: (R.issues.length ? '4' : '3') + '. 조치 제언' }), h('ul', null, R.actions.map((s) => h('li', { text: s })))) : null,
      h('section', { class: 'rd-sec rd-facts' },
        h('div', null, h('b', { text: String(F.measuredCount) }), h('span', { text: '실적 입력 지표' })),
        h('div', null, h('b', { text: String(F.unmeasured.length) }), h('span', { text: '미측정·미입력' })),
        h('div', null, h('b', { text: String(F.focus.length) }), h('span', { text: '미흡·위험 지표' })),
        h('div', null, h('b', { text: String(F.openChecks.length) }), h('span', { text: '점검 미처리' }))),
      h('footer', { class: 'rd-foot', text: '※ 미측정·미입력 항목은 2차 목표치로 가정한 잠정치임. 진척률 구간: 90% 이상 양호, 60~90% 주의, 30~60% 미흡, 30% 미만 위험. '
        + (R.source === 'ai' ? '총평·이슈·제언은 AI(Claude)가 대시보드 수치로 작성한 초안이므로 보고 전 검토가 필요함.' : '대시보드 입력 데이터로 자동 생성함.') }));

    const bar = h('div', { class: 'modal-bar' },
      h('div', { class: 'modal-title' }, sv('svg', { width: 18, height: 18, viewBox: '0 0 24 24', 'aria-hidden': 'true' }, sv('path', { d: 'M12 2l2.2 6.3L20.5 10l-6.3 2.2L12 18.5l-2.2-6.3L3.5 10l6.3-1.7z', fill: 'currentColor' })), h('span', { text: 'AI 요약보고서' })),
      h('div', { class: 'modal-actions' },
        actBtn('공유하기', 'share', shareReport, true),
        actBtn('메일', 'mail', mailReport),
        actBtn('복사', 'copy', async () => { const ok = await copyText(reportText()); toast(ok ? '요약 내용을 복사했습니다.' : '복사하지 못했습니다.', !ok); }),
        actBtn('PDF 저장', 'pdf', () => printReport(true)),
        actBtn('인쇄', 'print', () => printReport(false)),
        rpt.aiReady && rpt.aiState !== 'loading' ? actBtn('AI 다시 작성', 'redo', runAi) : null),
      h('button', { type: 'button', class: 'modal-close', 'aria-label': '닫기', onClick: closeReport }, icon(ICONS.close)));

    const dialog = h('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'AI 요약보고서' },
      bar, h('div', { class: 'modal-body' }, status, aiSettings(), doc));
    root.replaceChildren(h('div', { class: 'modal-backdrop', onClick: closeReport }), dialog);
  }

  document.addEventListener('keydown', (e) => {
    if (!rpt.open) return;
    if (e.key === 'Escape') { closeReport(); return; }
    if (e.key === 'Tab') {
      const f = Array.prototype.filter.call(document.querySelectorAll('.modal button, .modal input, .modal select, .modal summary, .modal a[href]'), (el) => !el.disabled && el.offsetParent !== null);
      if (!f.length) return;
      const first = f[0], last = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
  });

  // ---------- 라우팅·렌더 ----------
  function route() {
    const hash = location.hash.replace(/^#\/?/, '');
    store.view = ['input', 'checks', 'history'].includes(hash) ? hash : 'dashboard';
    render();
    document.getElementById('app').focus({ preventScroll: true });
  }
  function render() {
    if (!store.data) return;
    const app = document.getElementById('app');
    const y = window.scrollY;
    const views = { dashboard: viewDashboard, input: viewInput, checks: viewChecks, history: viewHistory };
    tipHide();
    app.replaceChildren.apply(app, [].concat(views[store.view]()));
    window.scrollTo(0, y);
    document.querySelectorAll('.nav a').forEach((a) => {
      if (a.dataset.view === store.view) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
    });
    document.getElementById('brand-org').textContent = store.data.meta.org;
    document.getElementById('footer-org').textContent = '© ' + new Date().getFullYear() + ' ' + store.data.meta.org + ' · 성과관리시스템';
    setSync(true);
  }

  function tick() {
    const n = new Date();
    const pad = (x) => String(x).padStart(2, '0');
    const wd = ['일', '월', '화', '수', '목', '금', '토'][n.getDay()];
    const el = document.getElementById('clock');
    el.textContent = n.getFullYear() + '. ' + pad(n.getMonth() + 1) + '. ' + pad(n.getDate()) + ' (' + wd + ') ' + pad(n.getHours()) + ':' + pad(n.getMinutes());
    el.setAttribute('datetime', n.toISOString());
  }

  function isDark() {
    const t = document.documentElement.getAttribute('data-theme');
    if (t) return t === 'dark';
    return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
  }
  function paintThemeBtn() {
    const btn = document.getElementById('theme-btn');
    const dark = isDark();
    btn.replaceChildren(
      dark
        ? sv('svg', { width: 18, height: 18, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': 1.6, 'aria-hidden': 'true' }, sv('circle', { cx: 12, cy: 12, r: 4 }), sv('path', { d: 'M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4' }))
        : sv('svg', { width: 18, height: 18, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': 1.6, 'aria-hidden': 'true' }, sv('path', { d: 'M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z' })),
      h('span', { text: dark ? '라이트' : '다크' }));
    btn.setAttribute('aria-label', dark ? '라이트 모드로 전환' : '다크 모드로 전환');
    btn.setAttribute('aria-pressed', String(dark));
  }

  async function boot() {
    document.getElementById('report-btn').addEventListener('click', () => { if (store.data) openReport(); else toast('데이터를 불러온 뒤 다시 시도해 주세요.', true); });
    document.getElementById('theme-btn').addEventListener('click', () => {
      const next = isDark() ? 'light' : 'dark';
      document.documentElement.setAttribute('data-theme', next);
      lsSet('kpi-theme', next);
      paintThemeBtn();
    });
    if (window.matchMedia) window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', paintThemeBtn);
    paintThemeBtn();
    tick(); setInterval(tick, 30000);
    window.addEventListener('hashchange', route);
    window.addEventListener('beforeunload', (e) => { if (Object.keys(store.dirty).length) { e.preventDefault(); e.returnValue = ''; } });
    try {
      await loadData();
      if (store.key) {
        try { await api('POST', '/api/auth'); store.unlocked = true; } catch (e) { store.key = ''; lsSet('kpi-edit-key', ''); }
      }
      route();
    } catch (e) {
      setSync(false);
      document.getElementById('app').replaceChildren(h('div', { class: 'card' }, h('h2', { text: '서버에 연결할 수 없습니다' }), h('p', { class: 'desc', text: '인터넷 연결을 확인한 뒤 새로고침해 주세요. 계속되면 Netlify 배포 상태를 확인하세요.' })));
    }
    setInterval(poll, POLL_MS);
    setInterval(() => { if (store.view === 'dashboard' && !document.hidden) render(); }, 5 * 60 * 1000);
  }
  boot();
})();
