// Class Tests — shared calculations (pure: no Firebase, no DOM).
// Used by class-tests.html and by tests/class-tests-calc.test.js.

export const COMPETENCIES = ['Remember', 'Understand', 'Apply', 'Analyse/Evaluate'];
export const FLAG_TYPES = ['copying', 'double-tick', 'unclear', 'no-working', 'other'];
export const BANDS = {
  EXCELLENT: 'Excellent',
  GOOD: 'Good',
  PASS: 'Pass – needs practice',
  SUPPORT: 'Needs support'
};
export const DEFAULT_PAPER_SECTIONS = [
  { code: 'A', title: 'MCQ', maxMarks: 0 },
  { code: 'B', title: 'Very Short Answer', maxMarks: 0 },
  { code: 'C', title: 'Short Answer', maxMarks: 0 },
  { code: 'D', title: 'Long Answer', maxMarks: 0 },
  { code: 'E', title: 'Case Study', maxMarks: 0 }
];

const IST_OFFSET_MS = 330 * 60 * 1000;

/** Round to 1 decimal place, for display. */
export function round1(x) {
  if (x === null || x === undefined || !isFinite(x)) return x;
  return Math.round((x + Number.EPSILON) * 10) / 10;
}

/** Default pass mark: 33% of max, rounded up (50 → 17, 25 → 9, 100 → 33). Integer maths avoids 0.33 float error. */
export function defaultPassMarks(maxMarks) {
  const m = Number(maxMarks);
  if (!(m > 0)) return 0;
  return Math.ceil((m * 33) / 100 - 1e-9);
}

// ---------- Dates (stored as the instant of 00:00 India time) ----------

/** 'YYYY-MM-DD' → epoch ms of 00:00 IST on that day. */
export function istYmdToMillis(ymd) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd || '');
  if (!m) return null;
  return Date.UTC(+m[1], +m[2] - 1, +m[3]) - IST_OFFSET_MS;
}

/** epoch ms → 'YYYY-MM-DD' in IST. */
export function millisToIstYmd(ms) {
  const d = new Date(ms + IST_OFFSET_MS);
  return d.toISOString().slice(0, 10);
}

/** epoch ms → 'DD/MM/YYYY' in IST. */
export function millisToIstDmy(ms) {
  const [y, m, d] = millisToIstYmd(ms).split('-');
  return `${d}/${m}/${y}`;
}

/** Today's date in IST as 'YYYY-MM-DD'. */
export function todayIstYmd(nowMs = Date.now()) {
  return millisToIstYmd(nowMs);
}

/** True when the test date (YYYY-MM-DD) is after today in IST. */
export function isFutureYmd(ymd, nowMs = Date.now()) {
  return !!ymd && ymd > todayIstYmd(nowMs);
}

// ---------- Test validation ----------

/**
 * Validate a test definition. Returns an array of error strings (empty = valid).
 * test.testDateYmd is the 'YYYY-MM-DD' value from the date picker.
 */
export function validateTest(test) {
  const errors = [];
  if (!test.class) errors.push('Class is required.');
  if (!test.subject) errors.push('Subject is required.');
  if (!test.testName || !String(test.testName).trim()) errors.push('Test name is required.');
  if (!test.testDateYmd) errors.push('Test date is required.');
  else if (istYmdToMillis(test.testDateYmd) === null) errors.push('Test date is not a valid date.');

  const max = Number(test.maxMarks);
  if (!(max > 0)) errors.push('Max marks must be more than 0.');
  const pass = Number(test.passMarks);
  if (!(pass >= 0) || (max > 0 && pass > max)) errors.push('Pass marks must be between 0 and max marks.');

  const secs = test.paperSections || [];
  if (!secs.length) errors.push('Add at least one paper section.');
  const codes = new Set();
  let secSum = 0;
  for (const s of secs) {
    const code = String(s.code || '').trim();
    if (!code) { errors.push('Every paper section needs a code.'); continue; }
    if (codes.has(code)) errors.push(`Paper section "${code}" is listed twice.`);
    codes.add(code);
    const sm = Number(s.maxMarks);
    if (!(sm > 0)) errors.push(`Paper section ${code}: max marks must be more than 0.`);
    secSum += sm || 0;
  }
  if (max > 0 && secs.length && Math.abs(secSum - max) > 1e-9) {
    errors.push(`Paper section maxima add up to ${secSum}, but the test is out of ${max}.`);
  }

  const qs = test.questions || [];
  if (qs.length) {
    const qNos = new Set();
    const perSec = {};
    for (const q of qs) {
      const qNo = String(q.qNo || '').trim();
      if (!qNo) { errors.push('Every question needs a Q no.'); continue; }
      if (qNos.has(qNo)) errors.push(`Question ${qNo} is listed twice.`);
      qNos.add(qNo);
      if (!codes.has(q.paperSection)) errors.push(`Question ${qNo}: paper section "${q.paperSection || ''}" does not exist.`);
      const qm = Number(q.maxMarks);
      if (!(qm > 0)) errors.push(`Question ${qNo}: max marks must be more than 0.`);
      if (q.competency && !COMPETENCIES.includes(q.competency)) errors.push(`Question ${qNo}: unknown competency "${q.competency}".`);
      perSec[q.paperSection] = (perSec[q.paperSection] || 0) + (qm || 0);
    }
    for (const s of secs) {
      const got = perSec[s.code] || 0;
      if (Math.abs(got - Number(s.maxMarks)) > 1e-9) {
        errors.push(`Questions in section ${s.code} add up to ${got}, but the section is out of ${s.maxMarks}.`);
      }
    }
  }
  return errors;
}

// ---------- Per-student results ----------

/** Section totals from question-wise marks. Missing questions count as 0; a section with no entered question is omitted. */
export function sectionTotalsFromQuestions(questionMarks, questions) {
  const out = {};
  for (const q of questions || []) {
    const v = questionMarks ? questionMarks[q.qNo] : undefined;
    if (v === undefined || v === null || v === '') continue;
    out[q.paperSection] = (out[q.paperSection] || 0) + Number(v);
  }
  return out;
}

/** Effective section marks for a result: from questionMarks when present, else sectionMarks. */
export function effectiveSectionMarks(result, test) {
  const qm = result.questionMarks;
  if (qm && Object.keys(qm).length && (test.questions || []).length) {
    return sectionTotalsFromQuestions(qm, test.questions);
  }
  return { ...(result.sectionMarks || {}) };
}

/** Result band from total marks. Uses the unrounded percentage. */
export function resultBand(total, maxMarks, passMarks) {
  if (total < passMarks) return BANDS.SUPPORT;
  const pct = (total / maxMarks) * 100;
  if (pct >= 80) return BANDS.EXCELLENT;
  if (pct >= 60) return BANDS.GOOD;
  return BANDS.PASS;
}

/**
 * Validate a mark against a maximum. Returns null if OK, else an error string.
 * Blank is allowed (not yet entered).
 */
export function checkMark(value, max) {
  if (value === '' || value === null || value === undefined) return null;
  const n = Number(value);
  if (!isFinite(n)) return 'Not a number';
  if (n < 0) return 'Cannot be negative';
  if (n > Number(max)) return `More than max (${max})`;
  return null;
}

/**
 * Compute total / percentage / band for one student's result.
 * Returns { sectionMarks, total, percentage (unrounded), resultBand, entered, absent }.
 */
export function computeResult(result, test) {
  const absent = !!result.absent;
  const sectionMarks = effectiveSectionMarks(result, test);
  const entered = !absent && Object.values(sectionMarks).some(v => v !== '' && v !== null && v !== undefined);
  if (absent || !entered) {
    return { sectionMarks, total: null, percentage: null, resultBand: absent ? 'Absent' : null, entered: false, absent };
  }
  let total = 0;
  for (const s of test.paperSections || []) total += Number(sectionMarks[s.code] || 0);
  const percentage = (total / Number(test.maxMarks)) * 100;
  return {
    sectionMarks, total, percentage,
    resultBand: resultBand(total, Number(test.maxMarks), Number(test.passMarks)),
    entered: true, absent
  };
}

// ---------- Re-tests ----------

/**
 * Apply re-test scores to an original test's results.
 * results:        [{ studentId, ... }] of the original test
 * retests:        [{ test, results: [...] }] tests whose retestOf is the original, oldest first
 * Returns new rows: each with `computed` (the score that counts), and when replaced:
 *   cancelled: true, original: <original computed>, replacedByTest: <retest id>
 * A later re-test wins over an earlier one. A re-test out of a different max is scaled to the original max.
 */
export function applyRetests(results, test, retests = []) {
  const latest = {};
  const sorted = [...retests].sort((a, b) => (a.test.testDateMs || 0) - (b.test.testDateMs || 0));
  for (const rt of sorted) {
    for (const r of rt.results || []) {
      const c = computeResult(r, rt.test);
      if (c.entered) latest[r.studentId] = { rt, c };
    }
  }
  return results.map(r => {
    const original = computeResult(r, test);
    const hit = latest[r.studentId];
    if (!hit) return { ...r, computed: original, cancelled: false };
    const scale = Number(test.maxMarks) / Number(hit.rt.test.maxMarks);
    const total = hit.c.total * scale;
    const percentage = (total / Number(test.maxMarks)) * 100;
    return {
      ...r,
      computed: {
        sectionMarks: hit.c.sectionMarks, total, percentage,
        resultBand: resultBand(total, Number(test.maxMarks), Number(test.passMarks)),
        entered: true, absent: false
      },
      cancelled: true,
      original,
      replacedByTest: hit.rt.test.id
    };
  });
}

// ---------- Ranking and class statistics ----------

/** Competition ranking (1, 1, 3) by score, highest first. Returns Map(key → rank). */
export function competitionRank(items, scoreOf, keyOf) {
  const sorted = [...items].sort((a, b) => scoreOf(b) - scoreOf(a));
  const ranks = new Map();
  let prevScore = null;
  let prevRank = 0;
  sorted.forEach((it, i) => {
    const s = scoreOf(it);
    const rank = (prevScore !== null && Math.abs(s - prevScore) < 1e-9) ? prevRank : i + 1;
    ranks.set(keyOf(it), rank);
    prevScore = s;
    prevRank = rank;
  });
  return ranks;
}

/**
 * Class statistics from rows that have `computed` (output of applyRetests or { computed: computeResult() }).
 * Absent and not-yet-entered students are excluded from averages and pass %.
 */
export function classStats(rows, test) {
  const marked = rows.filter(r => r.computed && r.computed.entered);
  const absent = rows.filter(r => r.computed && r.computed.absent).length;
  const bandCounts = { [BANDS.EXCELLENT]: 0, [BANDS.GOOD]: 0, [BANDS.PASS]: 0, [BANDS.SUPPORT]: 0 };
  if (!marked.length) {
    return { marked: 0, absent, avgMarks: null, avgPct: null, highest: null, lowest: null,
             passed: 0, belowPass: 0, passPct: null, bandCounts, sectionAverages: [] };
  }
  const totals = marked.map(r => r.computed.total);
  const sum = totals.reduce((a, b) => a + b, 0);
  const avgMarks = sum / marked.length;
  const passed = marked.filter(r => r.computed.total >= Number(test.passMarks)).length;
  marked.forEach(r => { bandCounts[r.computed.resultBand]++; });
  const sectionAverages = (test.paperSections || []).map(s => {
    const vals = marked.map(r => Number(r.computed.sectionMarks[s.code] || 0));
    const avg = vals.reduce((a, b) => a + b, 0) / vals.length;
    return { code: s.code, title: s.title, maxMarks: Number(s.maxMarks), avg, avgPct: (avg / Number(s.maxMarks)) * 100 };
  });
  return {
    marked: marked.length,
    absent,
    avgMarks,
    avgPct: (avgMarks / Number(test.maxMarks)) * 100,
    highest: Math.max(...totals),
    lowest: Math.min(...totals),
    passed,
    belowPass: marked.length - passed,
    passPct: (passed / marked.length) * 100,
    bandCounts,
    sectionAverages
  };
}

/** Rank rows (with `computed`) — absent / not entered get rank null. Returns rows sorted highest first, absent last. */
export function rankRows(rows) {
  const marked = rows.filter(r => r.computed && r.computed.entered);
  const ranks = competitionRank(marked, r => r.computed.total, r => r.studentId);
  const withRank = rows.map(r => ({ ...r, rank: ranks.has(r.studentId) ? ranks.get(r.studentId) : null }));
  return withRank.sort((a, b) => {
    if (a.rank === null && b.rank === null) return (a.rollNo || 0) - (b.rollNo || 0);
    if (a.rank === null) return 1;
    if (b.rank === null) return -1;
    return a.rank - b.rank || (a.rollNo || 0) - (b.rollNo || 0);
  });
}

/** Compact summary stored on the test doc for the list view (rounded). */
export function summaryForList(stats) {
  return {
    marked: stats.marked,
    absent: stats.absent,
    avgMarks: stats.avgMarks === null ? null : round1(stats.avgMarks),
    avgPct: stats.avgPct === null ? null : round1(stats.avgPct),
    passPct: stats.passPct === null ? null : round1(stats.passPct)
  };
}
