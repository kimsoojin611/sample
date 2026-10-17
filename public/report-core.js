/* 요약보고서 엔진 — 브라우저와 Node(server.js) 양쪽에서 사용 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ReportCore = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const f1 = (v) => (Math.round(v * 10) / 10).toFixed(1);
  const fmt = (v) => v == null ? '—' : (Number.isInteger(v) ? v.toLocaleString('ko-KR') : String(v));
  function band(p) {
    if (p >= 90) return '양호';
    if (p >= 60) return '주의';
    if (p >= 30) return '미흡';
    return '위험';
  }
  function dateLabel(d) {
    return d.getFullYear() + '. ' + (d.getMonth() + 1) + '. ' + d.getDate() + '.';
  }

  // 데이터 → 보고에 쓸 사실(계산값)만 정리
  function computeFacts(data, now) {
    now = now || new Date();
    const m = data.meta;
    const s = new Date(m.periodStart + 'T00:00:00');
    const e = new Date(m.periodEnd + 'T00:00:00'); e.setDate(e.getDate() + 1);
    const elapsed = Math.max(0, Math.min(100, (now - s) / (e - s) * 100));

    const subs = data.subs.map((x) => {
      const has = x.cur != null && x.cur !== '';
      const cur = has ? Number(x.cur) : null;
      const prog = has ? cur / x.t2 * 100 : null;
      const yoy = has && x.a1 != null ? cur / x.a1 * 100 : null;
      const idx = data.indices.find((k) => k.id === x.g);
      return {
        id: x.id, index: idx.short, name: x.name, short: x.short, unit: x.unit, weight: x.w,
        kind: x.kind, status: x.st, dept: x.dept, note: x.note || '', asOf: x.asOf || '',
        cur, t2: x.t2, t3: x.t3, a1: x.a1,
        contrib: has ? cur / x.t3 * x.w : 0,
        pending: has ? 0 : x.t2 / x.t3 * x.w,
        prog, band: prog == null ? '미측정' : band(prog), yoy, g: x.g
      };
    });
    const indices = data.indices.map((k) => {
      const mine = subs.filter((x) => x.g === k.id);
      const conf = mine.reduce((a, x) => a + x.contrib, 0);
      const pend = mine.reduce((a, x) => a + x.pending, 0);
      const prog = (conf + pend) / k.t2 * 100;
      return { short: k.short, name: k.name, t2: k.t2, a1: k.a1, r1: k.r1, conf, pend, prog, band: band(prog) };
    });
    const measured = subs.filter((x) => x.prog != null);
    const bandCount = { '양호': 0, '주의': 0, '미흡': 0, '위험': 0 };
    measured.forEach((x) => { bandCount[x.band]++; });
    const openChecks = data.checks.filter((c) => !c.done);
    const tagCount = { '수정': 0, '확인': 0, '정리': 0 };
    openChecks.forEach((c) => { tagCount[c.tag] = (tagCount[c.tag] || 0) + 1; });

    return {
      org: m.org, project: m.project, year: m.year,
      reportDate: dateLabel(now), reportDateIso: now.toISOString().slice(0, 10),
      dataUpdatedAt: m.updatedAt,
      elapsed,
      indices, subs,
      bandCount,
      measuredCount: measured.length,
      focus: measured.filter((x) => x.prog < 60).sort((a, b) => a.prog - b.prog),
      unmeasured: subs.filter((x) => x.prog == null),
      behindLastYear: measured.filter((x) => x.yoy != null && x.yoy < elapsed).sort((a, b) => a.yoy - b.yoy),
      targetBelowLastYear: subs.filter((x) => x.a1 != null && x.t2 < x.a1),
      openChecks: openChecks.map((c) => ({ tag: c.tag, title: c.title })),
      tagCount
    };
  }

  // 규칙 기반 요약 (API 키가 없을 때도 항상 생성)
  function ruleReport(F) {
    const progs = F.indices.map((k) => k.prog);
    const idxBand = {};
    F.indices.forEach((k) => { idxBand[k.band] = (idxBand[k.band] || 0) + 1; });
    const idxBandText = ['양호', '주의', '미흡', '위험'].filter((b) => idxBand[b]).map((b) => b + ' ' + idxBand[b] + '개').join(', ');
    const bc = F.bandCount;
    let summary = F.reportDate + ' 기준 측정기간 경과율은 ' + f1(F.elapsed) + '%임. '
      + '4개 지수의 잠정 진척률은 ' + f1(Math.min.apply(null, progs)) + '~' + f1(Math.max.apply(null, progs)) + '%로 ' + idxBandText + ' 수준임. '
      + '세부지표 ' + F.subs.length + '개 중 실적이 입력된 ' + F.measuredCount + '개는 양호 ' + bc['양호'] + ', 주의 ' + bc['주의'] + ', 미흡 ' + bc['미흡'] + ', 위험 ' + bc['위험'] + '개이며, '
      + F.unmeasured.length + '개는 미측정·미입력 상태로 지수 진척률은 해당 항목을 2차 목표치로 가정한 잠정치임.';
    if (F.focus.length) summary += ' 특히 ' + F.focus.map((x) => x.short).join('·') + ' 지표가 2차 목표 대비 60% 미만으로 중점 관리가 필요함.';

    const issues = [];
    F.focus.forEach((x) => {
      issues.push(x.name + ': ' + fmt(x.cur) + x.unit + ' / 목표 ' + fmt(x.t2) + x.unit + ' (' + f1(x.prog) + '%, ' + x.band + ')' + (x.note ? ' — ' + x.note : ''));
    });
    const survey = F.unmeasured.filter((x) => x.kind === 'survey');
    const missing = F.unmeasured.filter((x) => x.kind !== 'survey');
    if (survey.length) issues.push('조사형 ' + survey.length + '개(' + survey.map((x) => x.short).join('·') + ')는 학년도 말 조사 전으로 미측정이며, 지수 가중치가 커 결과에 따라 지수가 크게 달라질 수 있음');
    missing.forEach((x) => issues.push(x.name + ': ' + x.status + ' 상태로 진척률 산출 불가'));
    if (F.targetBelowLastYear.length) issues.push('2차 목표가 전년 실적보다 낮은 지표 ' + F.targetBelowLastYear.length + '개(' + F.targetBelowLastYear.map((x) => x.short).join('·') + ') — 목표를 넘어도 전년 대비 감소 가능');

    const actions = [];
    F.focus.forEach((x) => actions.push(x.dept + ': ' + x.short + ' 2학기 실적 집계·반영' + (x.asOf ? ' (현재 ' + x.asOf + ' 기준)' : '')));
    missing.forEach((x) => actions.push(x.dept + ': ' + x.short + ' 원자료 입력' + (x.kind === 'ratio' ? '(4.1자·10.1자 재학인원)' : '')));
    if (survey.length) actions.push('IR센터: 학년도 말 만족도·핵심역량 조사 일정 확정 및 결과 입력');
    if (F.openChecks.length) actions.push('사업단: 데이터 점검 미처리 ' + F.openChecks.length + '건(수정 ' + (F.tagCount['수정'] || 0) + '건) 정리 — 원본 엑셀 수식·참조 오류 우선');
    return { summary, issues: issues.slice(0, 6), actions: actions.slice(0, 6), source: 'rule' };
  }

  // Claude에 보낼 프롬프트 (제공 수치만 쓰도록 제한)
  function buildPrompt(F) {
    const compact = {
      기준일: F.reportDate,
      측정기간_경과율: f1(F.elapsed) + '%',
      진척률_구간: '90% 이상 양호, 60~90% 주의, 30~60% 미흡, 30% 미만 위험',
      지수: F.indices.map((k) => ({ 지수: k.short, 잠정진척률: f1(k.prog) + '%', 구간: k.band, 이차목표: k.t2, 확정잠정기여: f1(k.conf), 미측정가정분: f1(k.pend), 일차년도달성률: k.r1 + '%' })),
      세부지표: F.subs.map((x) => ({
        지수: x.index, 지표: x.name, 단위: x.unit, 가중치: x.weight + '%', 현재: x.cur, 이차목표: x.t2, 전년실적: x.a1,
        진척률: x.prog == null ? null : f1(x.prog) + '%', 구간: x.band, 전년대비: x.yoy == null ? null : f1(x.yoy) + '%',
        상태: x.status, 집계시점: x.asOf || '미기재', 담당: x.dept, 비고: x.note
      })),
      데이터점검_미처리: F.openChecks.map((c) => '[' + c.tag + '] ' + c.title)
    };
    const system = '당신은 대학 혁신지원사업단의 성과관리 담당자로, 사업단장에게 올릴 1쪽 요약보고를 작성합니다. '
      + '한국어 개조식 보고체(~임, ~함, ~필요)로 씁니다. 제공된 수치와 사실만 사용하고, 새로운 수치를 계산·추정하거나 없는 사실을 만들지 않습니다. '
      + '미측정 항목은 잠정치라는 점을 분명히 합니다.';
    const user = '다음은 오늘 기준 자율성과지표 현황 데이터(JSON)입니다.\n\n' + JSON.stringify(compact, null, 1)
      + '\n\n아래 JSON 형식으로만 답하세요. 다른 텍스트나 코드블록 표시는 넣지 마세요.\n'
      + '{"summary": "총평 3~4문장", "issues": ["주요 이슈 3~5개, 각 1문장, 해당 수치 포함"], "actions": ["조치 제언 3~5개, \'담당부서: 조치\' 형식"]}';
    return { system, user };
  }

  function parseAi(text) {
    if (!text) return null;
    let t = String(text).trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
    const a = t.indexOf('{'), b = t.lastIndexOf('}');
    if (a < 0 || b < a) return null;
    try {
      const j = JSON.parse(t.slice(a, b + 1));
      const arr = (v) => Array.isArray(v) ? v.map((s) => String(s).slice(0, 400)).filter(Boolean).slice(0, 6) : [];
      if (typeof j.summary !== 'string' || !j.summary.trim()) return null;
      return { summary: j.summary.slice(0, 1500), issues: arr(j.issues), actions: arr(j.actions), source: 'ai' };
    } catch (e) { return null; }
  }

  function toPlainText(R, F) {
    const lines = [];
    lines.push('[' + F.org + '] 자율성과지표 ' + F.year + ' 진척 요약보고');
    lines.push('기준일 ' + F.reportDate + ' · 측정기간 경과율 ' + f1(F.elapsed) + '%');
    lines.push('');
    lines.push('■ 총평');
    lines.push(R.summary);
    lines.push('');
    lines.push('■ 지수별 잠정 진척률 (2차 목표 대비)');
    F.indices.forEach((k) => lines.push('- ' + k.short + ': ' + f1(k.prog) + '% (' + k.band + ') · 1차년도 달성률 ' + k.r1 + '%'));
    if (R.issues.length) { lines.push(''); lines.push('■ 주요 이슈'); R.issues.forEach((s) => lines.push('- ' + s)); }
    if (R.actions.length) { lines.push(''); lines.push('■ 조치 제언'); R.actions.forEach((s) => lines.push('- ' + s)); }
    lines.push('');
    lines.push('※ 미측정·미입력 항목은 2차 목표치로 가정한 잠정치임. ' + (R.source === 'ai' ? 'AI(Claude) 작성 초안으로 수치는 대시보드 기준.' : '대시보드 데이터로 자동 생성.'));
    return lines.join('\n');
  }

  return { computeFacts, ruleReport, buildPrompt, parseAi, toPlainText, band, f1, fmt };
});
