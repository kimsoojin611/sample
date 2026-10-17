// 자율성과지표 성과관리 — Netlify Function (API)
// 데이터는 Netlify Blobs("kpi" 저장소)에 보관합니다. 로그인·수정 키 없이 누구나 조회·수정할 수 있습니다.
import { getStore } from '@netlify/blobs';
import ReportCore from '../../public/report-core.js';
import seed from '../../data/seed.json' with { type: 'json' };

const STATUS_OPTIONS = ['확정', '잠정', '계획 포함', '부분 입력', '미측정', '미입력'];
const CHECK_TAGS = ['수정', '확인', '정리'];
const MAX_HISTORY = 2000;
const MAX_BODY = 100 * 1024;

const json = (status, body) => new Response(JSON.stringify(body), {
  status,
  headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }
});
const clone = (o) => JSON.parse(JSON.stringify(o));
const cleanText = (v, max) => v == null ? '' : String(v).replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, max);

function store() {
  return getStore({ name: 'kpi', consistency: 'strong' });
}
async function loadData(s) {
  let data = await s.get('data', { type: 'json' });
  if (!data) {
    data = clone(seed);
    await s.setJSON('data', data);
  }
  return data;
}
async function loadHistory(s) {
  return (await s.get('history', { type: 'json' })) || [];
}
async function commit(s, data, entry) {
  const day = new Date().toISOString().slice(0, 10);
  const backupKey = 'backup/' + day;
  if (!(await s.get(backupKey))) await s.setJSON(backupKey, data);
  data.meta.rev = (data.meta.rev || 0) + 1;
  data.meta.updatedAt = new Date().toISOString();
  // 새 데이터를 먼저 저장해야 백업은 "그날 첫 변경 직전" 상태로 남습니다
  await s.setJSON('data', data);
  let history = await loadHistory(s);
  history.unshift({ ...entry, at: data.meta.updatedAt, rev: data.meta.rev });
  if (history.length > MAX_HISTORY) history = history.slice(0, MAX_HISTORY);
  await s.setJSON('history', history);
}
async function readBody(req) {
  const text = await req.text();
  if (text.length > MAX_BODY) throw new Error('too large');
  return text ? JSON.parse(text) : {};
}
function clientIp(req, context) {
  return (context && context.ip) || req.headers.get('x-nf-client-connection-ip') || '';
}

// ---------- Claude (선택) ----------
async function callClaude(prompt) {
  const key = process.env.ANTHROPIC_API_KEY;
  const model = process.env.ANTHROPIC_MODEL || 'claude-sonnet-5-5';
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 25000);
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      signal: ctrl.signal,
      headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model, max_tokens: 2000, system: prompt.system, messages: [{ role: 'user', content: prompt.user }] })
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error((j.error && j.error.message) || ('Claude API 오류 ' + res.status));
    return { text: (j.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n'), model };
  } finally { clearTimeout(timer); }
}

export default async (req, context) => {
  const url = new URL(req.url);
  const path = url.pathname.replace(/\/+$/, '');
  const method = req.method;
  const s = store();

  try {
    if (method === 'GET' && path === '/api/data') return json(200, await loadData(s));
    if (method === 'GET' && path === '/api/rev') {
      const d = await loadData(s);
      return json(200, { rev: d.meta.rev, updatedAt: d.meta.updatedAt });
    }
    if (method === 'GET' && path === '/api/history') {
      const limit = Math.min(500, Math.max(1, Number(url.searchParams.get('limit')) || 100));
      return json(200, (await loadHistory(s)).slice(0, limit));
    }
    if (method === 'GET' && path === '/api/export') {
      const body = JSON.stringify({ kind: 'kpi-backup', savedAt: new Date().toISOString(), data: await loadData(s), history: await loadHistory(s) }, null, 2);
      return new Response(body, { status: 200, headers: { 'content-type': 'application/json; charset=utf-8', 'content-disposition': 'attachment; filename="kpi-backup-' + new Date().toISOString().slice(0, 10) + '.json"', 'cache-control': 'no-store' } });
    }
    // 이 배포판은 수정 키가 없습니다: 항상 허용
    if (method === 'POST' && path === '/api/auth') return json(200, { ok: true, open: true });

    if (method === 'GET' && path === '/api/report/status') {
      const on = !!process.env.ANTHROPIC_API_KEY;
      return json(200, { ai: on, model: on ? (process.env.ANTHROPIC_MODEL || 'claude-sonnet-5-5') : null });
    }
    if (method === 'POST' && path === '/api/report/ai') {
      if (!process.env.ANTHROPIC_API_KEY) return json(400, { error: 'AI 키가 설정되지 않았습니다. Netlify 환경 변수 ANTHROPIC_API_KEY를 등록하세요.' });
      const data = await loadData(s);
      const facts = ReportCore.computeFacts(data, new Date());
      const cacheKey = data.meta.rev + '|' + facts.reportDateIso;
      const cached = await s.get('ai-cache', { type: 'json' });
      if (cached && cached.key === cacheKey) return json(200, { report: cached.report, cached: true });
      try {
        const out = await callClaude(ReportCore.buildPrompt(facts));
        const report = ReportCore.parseAi(out.text);
        if (!report) return json(502, { error: 'AI 응답을 해석하지 못했습니다. 잠시 후 다시 시도해 주세요.' });
        report.model = out.model;
        await s.setJSON('ai-cache', { key: cacheKey, report });
        return json(200, { report });
      } catch (e) {
        return json(502, { error: 'AI 요약을 받지 못했습니다: ' + (e.name === 'AbortError' ? '응답 시간 초과' : e.message) });
      }
    }

    let m = path.match(/^\/api\/subs\/([a-z0-9]+)$/);
    if (m && method === 'PUT') {
      let body;
      try { body = await readBody(req); } catch (e) { return json(400, { error: '요청 형식이 올바르지 않습니다.' }); }
      const data = await loadData(s);
      const sub = data.subs.find((x) => x.id === m[1]);
      if (!sub) return json(404, { error: '지표를 찾을 수 없습니다.' });
      const next = {};
      if ('cur' in body) {
        if (body.cur === null || body.cur === '') next.cur = null;
        else {
          const n = Number(body.cur);
          if (!Number.isFinite(n) || n < 0 || n > 1e9) return json(400, { error: '현재값은 0 이상의 숫자여야 합니다.' });
          next.cur = n;
        }
      }
      if ('st' in body) {
        if (!STATUS_OPTIONS.includes(body.st)) return json(400, { error: '상태 값이 올바르지 않습니다.' });
        next.st = body.st;
      }
      if ('asOf' in body) {
        const d = cleanText(body.asOf, 10);
        if (d && !/^\d{4}-\d{2}-\d{2}$/.test(d)) return json(400, { error: '집계 시점은 YYYY-MM-DD 형식이어야 합니다.' });
        next.asOf = d;
      }
      if ('note' in body) next.note = cleanText(body.note, 300);
      if (body.rev != null && Number(body.rev) !== data.meta.rev) {
        const last = (await loadHistory(s)).find((h) => h.target === sub.id);
        if (last && last.rev > Number(body.rev)) return json(409, { error: '다른 사용자가 이 지표를 먼저 수정했습니다. 새로고침 후 다시 입력해 주세요.', current: sub });
      }
      const changes = {};
      for (const k of Object.keys(next)) if (sub[k] !== next[k]) changes[k] = { from: sub[k], to: next[k] };
      if (!Object.keys(changes).length) return json(200, { ok: true, unchanged: true, rev: data.meta.rev });
      Object.assign(sub, next);
      await commit(s, data, { type: 'sub', target: sub.id, label: sub.name, changes, editor: cleanText(body.editor, 40) || '(이름 미입력)', ip: clientIp(req, context) });
      return json(200, { ok: true, rev: data.meta.rev, sub });
    }

    m = path.match(/^\/api\/checks\/([a-z0-9]+)$/);
    if (m && method === 'PUT') {
      let body;
      try { body = await readBody(req); } catch (e) { return json(400, { error: '요청 형식이 올바르지 않습니다.' }); }
      const data = await loadData(s);
      const chk = data.checks.find((c) => c.id === m[1]);
      if (!chk) return json(404, { error: '항목을 찾을 수 없습니다.' });
      const done = !!body.done;
      if (chk.done === done) return json(200, { ok: true, unchanged: true, rev: data.meta.rev });
      chk.done = done;
      await commit(s, data, { type: 'check', target: chk.id, label: chk.title, changes: { done: { from: !done, to: done } }, editor: cleanText(body.editor, 40) || '(이름 미입력)', ip: clientIp(req, context) });
      return json(200, { ok: true, rev: data.meta.rev, check: chk });
    }

    if (method === 'POST' && path === '/api/checks') {
      let body;
      try { body = await readBody(req); } catch (e) { return json(400, { error: '요청 형식이 올바르지 않습니다.' }); }
      const title = cleanText(body.title, 80);
      if (!title) return json(400, { error: '제목을 입력해 주세요.' });
      const data = await loadData(s);
      if (data.checks.length >= 200) return json(400, { error: '점검 항목이 너무 많습니다.' });
      const chk = { id: 'c' + Date.now().toString(36), tag: CHECK_TAGS.includes(body.tag) ? body.tag : '확인', title, src: cleanText(body.src, 40), detail: cleanText(body.detail, 200), done: false };
      data.checks.push(chk);
      await commit(s, data, { type: 'check-add', target: chk.id, label: chk.title, changes: {}, editor: cleanText(body.editor, 40) || '(이름 미입력)', ip: clientIp(req, context) });
      return json(200, { ok: true, rev: data.meta.rev, check: chk });
    }

    return json(404, { error: 'Not found' });
  } catch (e) {
    console.error(e);
    return json(500, { error: '서버 오류가 발생했습니다.' });
  }
};

export const config = { path: '/api/*' };
