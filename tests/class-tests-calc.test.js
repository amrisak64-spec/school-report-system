// Run with: node tests/class-tests-calc.test.js   (Node 18+, no npm packages)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  round1, defaultPassMarks, istYmdToMillis, millisToIstYmd, millisToIstDmy, isFutureYmd,
  validateTest, sectionTotalsFromQuestions, computeResult, resultBand, checkMark,
  applyRetests, competitionRank, classStats, rankRows, summaryForList, BANDS
} from '../js/class-tests-calc.js';

const T50 = {
  id: 't1', maxMarks: 50, passMarks: 17,
  paperSections: [
    { code: 'A', title: 'MCQ', maxMarks: 10 },
    { code: 'B', title: 'VSA', maxMarks: 10 },
    { code: 'C', title: 'SA', maxMarks: 10 },
    { code: 'D', title: 'LA', maxMarks: 10 },
    { code: 'E', title: 'Case', maxMarks: 10 }
  ]
};
const res = (studentId, marks, extra = {}) => ({
  studentId, rollNo: Number(studentId.replace(/\D/g, '')) || 0,
  sectionMarks: Object.fromEntries(['A', 'B', 'C', 'D', 'E'].map((c, i) => [c, marks[i]])),
  ...extra
});

test('pass-mark rounding: 33% rounded up', () => {
  assert.equal(defaultPassMarks(50), 17);
  assert.equal(defaultPassMarks(25), 9);
  assert.equal(defaultPassMarks(20), 7);
  assert.equal(defaultPassMarks(100), 33);
  assert.equal(defaultPassMarks(80), 27);
  assert.equal(defaultPassMarks(0), 0);
});

test('round1', () => {
  assert.equal(round1(66.66666), 66.7);
  assert.equal(round1(12.25), 12.3);
  assert.equal(round1(80), 80);
});

test('band edges use the unrounded percentage', () => {
  assert.equal(resultBand(40, 50, 17), BANDS.EXCELLENT);          // exactly 80
  assert.equal(resultBand(79.99, 100, 33), BANDS.GOOD);           // 79.99 is not rounded up
  assert.equal(resultBand(30, 50, 17), BANDS.GOOD);               // exactly 60
  assert.equal(resultBand(59.99, 100, 33), BANDS.PASS);
  assert.equal(resultBand(17, 50, 17), BANDS.PASS);               // exactly the pass mark
  assert.equal(resultBand(16, 50, 17), BANDS.SUPPORT);            // one below
  assert.equal(resultBand(16.5, 50, 17), BANDS.SUPPORT);
});

test('IST date storage round-trips and future check', () => {
  const ms = istYmdToMillis('2026-03-05');
  assert.equal(new Date(ms).toISOString(), '2026-03-04T18:30:00.000Z');
  assert.equal(millisToIstYmd(ms), '2026-03-05');
  assert.equal(millisToIstDmy(ms), '05/03/2026');
  assert.equal(istYmdToMillis('05/03/2026'), null);
  const now = Date.UTC(2026, 9, 12, 20, 0); // 12 Oct 20:00 UTC = 13 Oct 01:30 IST
  assert.equal(isFutureYmd('2026-10-13', now), false);
  assert.equal(isFutureYmd('2026-10-14', now), true);
});

test('validateTest: date required, sections must add up', () => {
  const base = { class: 'VII', subject: 'Maths', testName: 'Pre-Final', testDateYmd: '2026-09-01',
                 maxMarks: 50, passMarks: 17, paperSections: T50.paperSections };
  assert.deepEqual(validateTest(base), []);
  assert.match(validateTest({ ...base, testDateYmd: '' }).join(), /Test date is required/);
  const bad = { ...base, paperSections: [...T50.paperSections.slice(0, 4), { code: 'E', title: 'x', maxMarks: 5 }] };
  assert.match(validateTest(bad).join(), /add up to 45, but the test is out of 50/);
  const dup = { ...base, paperSections: [...T50.paperSections.slice(0, 4), { code: 'A', title: 'x', maxMarks: 10 }] };
  assert.match(validateTest(dup).join(), /listed twice/);
});

test('validateTest: questions must add up to their section', () => {
  const base = { class: 'III', subject: 'Maths', testName: 'UT', testDateYmd: '2026-09-01', maxMarks: 5, passMarks: 2,
    paperSections: [{ code: 'A', title: 'MCQ', maxMarks: 3 }, { code: 'B', title: 'SA', maxMarks: 2 }],
    questions: [
      { qNo: 'A1', paperSection: 'A', maxMarks: 1, competency: 'Remember' },
      { qNo: 'A2', paperSection: 'A', maxMarks: 2, competency: 'Apply' },
      { qNo: 'B1', paperSection: 'B', maxMarks: 2, competency: 'Understand' }
    ] };
  assert.deepEqual(validateTest(base), []);
  const bad = { ...base, questions: base.questions.slice(0, 2) };
  assert.match(validateTest(bad).join(), /section B add up to 0/);
  const badComp = { ...base, questions: [...base.questions.slice(0, 2), { qNo: 'B1', paperSection: 'B', maxMarks: 2, competency: 'Guess' }] };
  assert.match(validateTest(badComp).join(), /unknown competency/);
});

test('section totals from question marks override section marks', () => {
  const test5 = { maxMarks: 5, passMarks: 2,
    paperSections: [{ code: 'A', maxMarks: 3 }, { code: 'B', maxMarks: 2 }],
    questions: [{ qNo: 'A1', paperSection: 'A', maxMarks: 1 }, { qNo: 'A2', paperSection: 'A', maxMarks: 2 },
                { qNo: 'B1', paperSection: 'B', maxMarks: 2 }] };
  assert.deepEqual(sectionTotalsFromQuestions({ A1: 1, A2: 2, B1: 0 }, test5.questions), { A: 3, B: 0 });
  const c = computeResult({ sectionMarks: { A: 0, B: 0 }, questionMarks: { A1: 1, A2: 1, B1: 2 } }, test5);
  assert.equal(c.total, 4);
  assert.equal(c.percentage, 80);
  assert.equal(c.resultBand, BANDS.EXCELLENT);
});

test('checkMark blocks above max and negatives', () => {
  assert.equal(checkMark('', 10), null);
  assert.equal(checkMark(10, 10), null);
  assert.match(checkMark(11, 10), /More than max/);
  assert.match(checkMark(-1, 10), /negative/);
  assert.match(checkMark('abc', 10), /Not a number/);
});

test('competition ranking: ties share a rank (1, 1, 3)', () => {
  const ranks = competitionRank([{ k: 'a', s: 40 }, { k: 'b', s: 45 }, { k: 'c', s: 45 }, { k: 'd', s: 30 }],
                                x => x.s, x => x.k);
  assert.equal(ranks.get('b'), 1);
  assert.equal(ranks.get('c'), 1);
  assert.equal(ranks.get('a'), 3);
  assert.equal(ranks.get('d'), 4);
});

test('absent students are excluded from averages, pass % and ranks', () => {
  const rows = [
    res('s1', [10, 10, 10, 10, 5]),   // 45
    res('s2', [8, 8, 8, 8, 8]),       // 40
    res('s3', [2, 2, 2, 2, 2]),       // 10 → below pass
    res('s4', [], { absent: true }),
    res('s5', [])                     // not entered yet
  ].map(r => ({ ...r, computed: computeResult(r, T50) }));
  const st = classStats(rows, T50);
  assert.equal(st.marked, 3);
  assert.equal(st.absent, 1);
  assert.equal(round1(st.avgMarks), 31.7);
  assert.equal(round1(st.avgPct), 63.3);
  assert.equal(st.highest, 45);
  assert.equal(st.lowest, 10);
  assert.equal(st.passed, 2);
  assert.equal(st.belowPass, 1);
  assert.equal(round1(st.passPct), 66.7);
  assert.equal(st.bandCounts[BANDS.EXCELLENT], 2);
  assert.equal(st.bandCounts[BANDS.SUPPORT], 1);
  assert.equal(st.sectionAverages[0].avg, 20 / 3);
  const ranked = rankRows(rows);
  assert.deepEqual(ranked.map(r => [r.studentId, r.rank]),
    [['s1', 1], ['s2', 2], ['s3', 3], ['s4', null], ['s5', null]]);
  assert.deepEqual(summaryForList(st), { marked: 3, absent: 1, avgMarks: 31.7, avgPct: 63.3, passPct: 66.7 });
});

test('re-test score replaces the original (Swati: 22 → 6)', () => {
  const original = [res('swati', [5, 5, 5, 5, 2]), res('ravi', [4, 4, 4, 4, 4])];   // 22, 20
  const retest = { test: { ...T50, id: 'rt1', testDateMs: 2 }, results: [res('swati', [2, 1, 1, 1, 1])] }; // 6
  const rows = applyRetests(original, T50, [retest]);
  const swati = rows.find(r => r.studentId === 'swati');
  assert.equal(swati.cancelled, true);
  assert.equal(swati.original.total, 22);
  assert.equal(swati.computed.total, 6);
  assert.equal(swati.computed.resultBand, BANDS.SUPPORT);
  assert.equal(swati.replacedByTest, 'rt1');
  const st = classStats(rows, T50);
  assert.equal(st.avgMarks, 13);         // (6 + 20) / 2
  assert.equal(st.passed, 1);
  const ranked = rankRows(rows);
  assert.equal(ranked[0].studentId, 'ravi');
  assert.equal(ranked[1].rank, 2);
});

test('later re-test wins; re-test out of a different max is scaled', () => {
  const original = [res('s1', [5, 5, 5, 5, 2])];
  const r1 = { test: { ...T50, id: 'r1', testDateMs: 1 }, results: [res('s1', [1, 1, 1, 1, 1])] };
  const r2test = { id: 'r2', testDateMs: 5, maxMarks: 25, passMarks: 9,
                   paperSections: [{ code: 'A', maxMarks: 25 }] };
  const r2 = { test: r2test, results: [{ studentId: 's1', sectionMarks: { A: 20 } }] };
  const [row] = applyRetests(original, T50, [r2, r1]);
  assert.equal(row.replacedByTest, 'r2');
  assert.equal(row.computed.total, 40);
  assert.equal(row.computed.resultBand, BANDS.EXCELLENT);
});

test('absent on a re-test does not replace the original', () => {
  const original = [res('s1', [5, 5, 5, 5, 2])];
  const rt = { test: { ...T50, id: 'r1' }, results: [res('s1', [], { absent: true })] };
  const [row] = applyRetests(original, T50, [rt]);
  assert.equal(row.cancelled, false);
  assert.equal(row.computed.total, 22);
});
