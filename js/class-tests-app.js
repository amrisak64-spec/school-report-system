// Class Tests — page logic (list, create/edit test, marks entry).
// All maths lives in ./class-tests-calc.js.
import { auth, db } from '../firebase-config.js';
import { onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";
import { collection, doc, getDoc, getDocs, query, where, addDoc, updateDoc, writeBatch,
         serverTimestamp, Timestamp }
  from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";
import {
  COMPETENCIES, FLAG_TYPES, BANDS, DEFAULT_PAPER_SECTIONS, round1, defaultPassMarks,
  istYmdToMillis, millisToIstYmd, millisToIstDmy, isFutureYmd, validateTest, checkMark,
  computeResult, applyRetests, classStats, summaryForList, sectionTotalsFromQuestions
} from './class-tests-calc.js';

// Same lists as admin.html — keep in step if those change.
const SUBJECTS = ['Hindi','English','Maths','Science','SST','Sanskrit','Computer','Drawing','GK'];
const SUBJECT_ALIASES = { 'Science/E.V.S.':'Science', 'S.S.T.':'SST', 'G.K.':'GK' };
const VALID_CLASSES = ['II','III','IV','V','VI','VII','VIII'];
const JUNIOR_CLASSES = ['II','III','IV','V'];
const subjectsForClass = cls => JUNIOR_CLASSES.includes(cls)
  ? SUBJECTS.filter(s => s !== 'SST' && s !== 'Sanskrit') : SUBJECTS;
const CURRENT_SESSION = '2026-27';

const AUTOSAVE_MS = 2000;
const STUDENTS_PER_BATCH = 4;   // keeps each batch well inside Firestore's rules document-read limit

let currentUser = null;         // { uid, role, name, subject, assignedClasses }
let allTests = [];              // list cache
let editState = null;           // test being edited
let marks = null;               // marks-entry state
let pendingRetest = null;       // preset for the re-test form (#new-retest)

const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
const isAdmin = () => currentUser?.role === 'admin';
const canonSubject = s => SUBJECT_ALIASES[s] || s;

function showMsg(id, text, type = 'info') {
  $(id).innerHTML = text ? `<div class="msg msg-${type}">${text}</div>` : '';
}

function ctConfirm(title, msg, okLabel = 'OK', danger = true) {
  return new Promise(resolve => {
    $('confirm-title').textContent = title;
    $('confirm-msg').textContent = msg;
    const ok = $('confirm-ok');
    ok.textContent = okLabel;
    ok.className = 'btn ' + (danger ? 'btn-danger' : 'btn-primary');
    $('confirm-modal').classList.add('open');
    const done = v => { $('confirm-modal').classList.remove('open'); ok.onclick = null; $('confirm-cancel').onclick = null; resolve(v); };
    ok.onclick = () => done(true);
    $('confirm-cancel').onclick = () => done(false);
  });
}

// ---------- Access ----------

function allowedClasses() {
  return isAdmin() ? VALID_CLASSES : VALID_CLASSES.filter(c => (currentUser.assignedClasses || []).includes(c));
}
function allowedSubjects(cls) {
  const subs = cls ? subjectsForClass(cls) : SUBJECTS;
  if (isAdmin() || currentUser.subject === 'All Subjects') return subs;
  return subs.filter(s => s === canonSubject(currentUser.subject));
}
function ownsTest(t) {
  if (isAdmin()) return true;
  return (currentUser.assignedClasses || []).includes(t.class)
    && (currentUser.subject === 'All Subjects' || canonSubject(currentUser.subject) === t.subject);
}
function canEditMarks(t) {
  return t.status !== 'final' && ownsTest(t);
}

// ---------- Firestore helpers ----------

function testFromDoc(d) {
  const t = { id: d.id, ...d.data() };
  t.testDateMs = t.testDate?.toMillis ? t.testDate.toMillis() : null;
  t.testDateYmd = t.testDateMs ? millisToIstYmd(t.testDateMs) : '';
  return t;
}

async function loadTest(id) {
  const snap = await getDoc(doc(db, 'classTests', id));
  if (!snap.exists()) throw new Error('Test not found.');
  return testFromDoc(snap);
}

async function loadResults(testId) {
  const snap = await getDocs(collection(db, 'classTests', testId, 'results'));
  return snap.docs.map(d => ({ studentId: d.id, ...d.data() }));
}

async function loadRetests(testId) {
  const snap = await getDocs(query(collection(db, 'classTests'), where('retestOf', '==', testId)));
  const tests = snap.docs.map(testFromDoc);
  return Promise.all(tests.map(async t => ({ test: t, results: await loadResults(t.id) })));
}

async function loadClassStudents(t) {
  const snap = await getDocs(query(collection(db, 'students'), where('class', '==', t.class)));
  let list = snap.docs.map(d => ({ id: d.id, ...d.data() }))
    .filter(s => !s.left && !s.passedOut && (!s.session || s.session === t.session));
  if (t.classSection && t.classSection !== 'All') list = list.filter(s => (s.section || '') === t.classSection);
  return list.sort((a, b) => (Number(a.rollNo) || 0) - (Number(b.rollNo) || 0) || String(a.name).localeCompare(b.name));
}

// ---------- Auth ----------

onAuthStateChanged(auth, async user => {
  if (!user) { window.location.href = 'index.html'; return; }
  const snap = await getDoc(doc(db, 'users', user.uid));
  if (!snap.exists() || !['admin', 'teacher'].includes(snap.data().role)) { window.location.href = 'index.html'; return; }
  const d = snap.data();
  currentUser = { uid: user.uid, role: d.role, name: d.name || user.email,
                  subject: d.subject || '', assignedClasses: d.assignedClasses || [] };
  $('user-info').textContent = isAdmin()
    ? `${currentUser.name} | ADMIN`
    : `${currentUser.name} | ${canonSubject(currentUser.subject) || '—'} | Classes: ${currentUser.assignedClasses.join(', ') || '—'}`;
  $('loading').style.display = 'none';
  initListFilters();
  window.addEventListener('hashchange', route);
  route();
});

window.goBack = () => { window.location.href = isAdmin() ? 'admin.html' : 'teacher.html'; };
window.logout = () => signOut(auth).then(() => window.location.href = 'index.html');

window.addEventListener('beforeunload', e => {
  if (marks && (marks.dirty.size || marks.saving)) { e.preventDefault(); e.returnValue = ''; }
});

// ---------- Router ----------

async function route() {
  if (marks && marks.dirty.size) await flushSave();
  const h = location.hash || '#list';
  showMsg('global-msg', '');
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  try {
    if (h === '#list') { $('view-list').classList.add('active'); marks = null; await loadList(); }
    else if (h === '#new') { $('view-edit').classList.add('active'); marks = null; await openEditor(null); }
    else if (h === '#new-retest' && pendingRetest) { $('view-edit').classList.add('active'); marks = null; await openEditor(null, pendingRetest); }
    else if (h.startsWith('#edit/')) { $('view-edit').classList.add('active'); marks = null; await openEditor(h.slice(6)); }
    else if (h.startsWith('#marks/')) { $('view-marks').classList.add('active'); await openMarks(h.slice(7)); }
    else location.hash = '#list';
  } catch (err) {
    console.error(err);
    showMsg('global-msg', '❌ ' + esc(err.message || err), 'error');
  }
  window.scrollTo(0, 0);
}

// =====================================================================
// LIST
// =====================================================================

function fillSelect(sel, values, allLabel) {
  const prev = sel.value;
  sel.innerHTML = (allLabel ? `<option value="">${allLabel}</option>` : '') +
    values.map(v => `<option value="${esc(v)}">${esc(v)}</option>`).join('');
  if (values.includes(prev)) sel.value = prev;
}

function initListFilters() {
  $('list-session').textContent = `Session ${CURRENT_SESSION}`;
  fillSelect($('f-class'), allowedClasses(), 'All classes');
  fillSelect($('f-subject'), allowedSubjects(null), 'All subjects');
  ['f-class', 'f-subject', 'f-from', 'f-to'].forEach(id => $(id).addEventListener('change', renderList));
}

window.clearFilters = () => {
  ['f-class', 'f-subject', 'f-from', 'f-to'].forEach(id => { $(id).value = ''; });
  renderList();
};

async function loadList() {
  $('list-body').innerHTML = `<tr><td colspan="9" class="empty">Loading…</td></tr>`;
  const snap = await getDocs(query(collection(db, 'classTests'), where('session', '==', CURRENT_SESSION)));
  allTests = snap.docs.map(testFromDoc).filter(ownsTest);
  renderList();
}

function renderList() {
  const cls = $('f-class').value, sub = $('f-subject').value, from = $('f-from').value, to = $('f-to').value;
  const rows = allTests
    .filter(t => (!cls || t.class === cls) && (!sub || t.subject === sub)
      && (!from || t.testDateYmd >= from) && (!to || t.testDateYmd <= to))
    .sort((a, b) => (b.testDateMs || 0) - (a.testDateMs || 0) || String(a.testName).localeCompare(b.testName));
  if (!rows.length) {
    $('list-body').innerHTML = `<tr><td colspan="9" class="empty">No tests yet. Click <b>New Test</b> to add one.</td></tr>`;
    return;
  }
  $('list-body').innerHTML = rows.map(t => {
    const s = t.summary || {};
    const avg = s.avgMarks == null ? '—' : `${s.avgMarks} <small style="color:#888;">(${s.avgPct}%)</small>`;
    return `<tr>
      <td style="white-space:nowrap;">${t.testDateMs ? millisToIstDmy(t.testDateMs) : '—'}</td>
      <td><b>${esc(t.testName)}</b>${t.set ? ` <small>Set ${esc(t.set)}</small>` : ''}
        ${t.isRetest ? ' <span class="badge badge-retest">Re-test</span>' : ''}
        <span class="badge badge-${t.status === 'final' ? 'final' : 'draft'}">${t.status === 'final' ? 'Final' : 'Draft'}</span></td>
      <td>${esc(t.class)}${t.classSection && t.classSection !== 'All' ? '-' + esc(t.classSection) : ''}</td>
      <td>${esc(t.subject)}</td>
      <td class="num">${esc(t.maxMarks)}</td>
      <td class="num">${s.marked ?? 0}${s.absent ? ` <small style="color:#888;">+${s.absent} AB</small>` : ''}</td>
      <td class="num">${avg}</td>
      <td class="num">${s.passPct == null ? '—' : s.passPct + '%'}</td>
      <td style="white-space:nowrap;">
        <button class="btn btn-primary btn-sm" onclick="location.hash='#marks/${t.id}'">Open</button>
        <button class="btn btn-light btn-sm" onclick="location.hash='#edit/${t.id}'">Edit</button>
      </td></tr>`;
  }).join('');
}

// =====================================================================
// CREATE / EDIT TEST
// =====================================================================

async function openEditor(id, preset = null) {
  showMsg('edit-msg', '');
  $('edit-retest-info').innerHTML = '';
  if (id) {
    const t = await loadTest(id);
    if (!ownsTest(t)) throw new Error('This test is not in your classes / subject.');
    editState = { ...t, questions: t.questions || [], paperSections: t.paperSections || [], chapters: t.chapters || [] };
  } else {
    editState = preset || {
      id: null, session: CURRENT_SESSION, class: '', classSection: 'All', subject: '', testName: '', set: 'A',
      testDateYmd: '', maxMarks: '', passMarks: '', passTouched: false, chapters: [],
      paperSections: DEFAULT_PAPER_SECTIONS.map(s => ({ ...s })), questions: [], status: 'draft'
    };
  }
  const t = editState;
  const locked = t.status === 'final' && !isAdmin();
  $('edit-title').textContent = t.id ? `Edit: ${t.testName}` : (t.isRetest ? 'New Re-test' : 'New Test');

  fillSelect($('t-class'), allowedClasses(), '-- Select class --');
  $('t-class').value = t.class;
  refreshSubjectOptions();
  $('t-subject').value = t.subject;
  $('t-classSection').value = t.classSection || 'All';
  $('t-testName').value = t.testName || '';
  $('t-set').value = t.set || '';
  $('t-testDate').value = t.testDateYmd || '';
  $('t-maxMarks').value = t.maxMarks ?? '';
  $('t-passMarks').value = t.passMarks ?? '';
  $('t-chapters').value = (t.chapters || []).join('\n');
  t.passTouched = !!t.id;

  $('t-class').onchange = () => { refreshSubjectOptions(); if (t.isRetest) renderRetestStudents(); };
  $('t-classSection').onchange = () => { if (t.isRetest) renderRetestStudents(); };
  $('t-maxMarks').oninput = () => {
    if (!t.passTouched) $('t-passMarks').value = defaultPassMarks($('t-maxMarks').value) || '';
    renderSectionSum();
  };
  $('t-passMarks').oninput = () => { t.passTouched = true; };
  $('t-chapters').oninput = refreshChapterList;

  renderSections();
  renderQuestions();
  refreshChapterList();

  // Re-test details
  if (t.isRetest) {
    const orig = t.retestOf ? await getDoc(doc(db, 'classTests', t.retestOf)) : null;
    const o = orig?.exists() ? testFromDoc(orig) : null;
    $('edit-retest-info').innerHTML = `<div class="msg msg-info">🔁 Re-test of <b>${esc(o ? `${o.testName} (${millisToIstDmy(o.testDateMs)})` : t.retestOf)}</b>.
      These scores replace the original scores of the students below.</div>`;
    $('retest-students-wrap').style.display = '';
    await renderRetestStudents();
  } else {
    $('retest-students-wrap').style.display = 'none';
  }

  // Lock everything on a finalised test (teachers); class / subject are fixed on a re-test.
  document.querySelectorAll('#view-edit input, #view-edit select, #view-edit textarea, #view-edit .builder button, #view-edit .btn-sm')
    .forEach(el => { el.disabled = locked; });
  if (t.isRetest) ['t-class', 't-subject', 't-classSection'].forEach(i => { $(i).disabled = true; });
  $('btn-save-test').disabled = locked;
  $('btn-save-open').disabled = locked;
  $('btn-create-retest').style.display = t.id && !t.isRetest ? '' : 'none';
  $('btn-delete-test').style.display = t.id && (t.status !== 'final' || isAdmin()) ? '' : 'none';
  if (locked) showMsg('edit-msg', '🔒 This test is finalised. Only an admin can change it.', 'warn');
}

function refreshSubjectOptions() {
  fillSelect($('t-subject'), allowedSubjects($('t-class').value), '-- Select subject --');
}

function refreshChapterList() {
  const chs = $('t-chapters').value.split('\n').map(s => s.trim()).filter(Boolean);
  $('chapter-list').innerHTML = chs.map(c => `<option value="${esc(c)}">`).join('');
}

// ----- Paper sections -----

function readSections() {
  return Array.from($('sections-body').querySelectorAll('tr')).map(tr => ({
    code: tr.querySelector('.s-code').value.trim().toUpperCase(),
    title: tr.querySelector('.s-title').value.trim(),
    maxMarks: Number(tr.querySelector('.s-max').value) || 0
  }));
}

function renderSections() {
  $('sections-body').innerHTML = editState.paperSections.map((s, i) => `<tr>
    <td style="width:80px;"><input class="s-code" value="${esc(s.code)}" maxlength="3" aria-label="Section code"/></td>
    <td><input class="s-title" value="${esc(s.title)}" aria-label="Section title"/></td>
    <td style="width:110px;"><input class="s-max" type="number" min="0" step="0.5" inputmode="decimal" value="${s.maxMarks || ''}" aria-label="Section max marks"/></td>
    <td style="width:40px;"><button class="btn btn-light btn-sm" onclick="removeSectionRow(${i})" title="Remove">✕</button></td>
  </tr>`).join('');
  $('sections-body').querySelectorAll('input').forEach(el => el.addEventListener('input', () => {
    editState.paperSections = readSections();
    renderSectionSum();
    refreshQuestionSectionOptions();
  }));
  renderSectionSum();
  refreshQuestionSectionOptions();
}

function renderSectionSum() {
  const sum = readSections().reduce((a, s) => a + s.maxMarks, 0);
  const max = Number($('t-maxMarks').value) || 0;
  const ok = max > 0 && Math.abs(sum - max) < 1e-9;
  $('sections-sum').innerHTML = `Sections total: <span class="${ok ? 'sum-ok' : 'sum-bad'}">${sum} / ${max || '?'}</span>`;
  renderQuestionSum();
}

window.addSectionRow = () => {
  editState.paperSections = readSections();
  const used = new Set(editState.paperSections.map(s => s.code));
  const next = 'ABCDEFGHIJ'.split('').find(c => !used.has(c)) || '';
  editState.paperSections.push({ code: next, title: '', maxMarks: 0 });
  renderSections();
};
window.removeSectionRow = i => {
  editState.paperSections = readSections();
  editState.paperSections.splice(i, 1);
  renderSections();
};

// ----- Questions -----

function readQuestions() {
  return Array.from($('questions-body').querySelectorAll('tr')).map(tr => ({
    qNo: tr.querySelector('.q-no').value.trim(),
    paperSection: tr.querySelector('.q-sec').value,
    maxMarks: Number(tr.querySelector('.q-max').value) || 0,
    topic: tr.querySelector('.q-topic').value.trim(),
    chapter: tr.querySelector('.q-ch').value.trim(),
    competency: tr.querySelector('.q-comp').value,
    correctAnswer: tr.querySelector('.q-ans').value.trim()
  }));
}

function sectionOptions(selected) {
  return readSections().map(s => `<option value="${esc(s.code)}"${s.code === selected ? ' selected' : ''}>${esc(s.code)}</option>`).join('');
}

function refreshQuestionSectionOptions() {
  $('qa-section').innerHTML = sectionOptions($('qa-section').value);
  $('questions-body').querySelectorAll('.q-sec').forEach(sel => { sel.innerHTML = sectionOptions(sel.value); });
}

function renderQuestions() {
  $('questions-body').innerHTML = editState.questions.map((q, i) => `<tr>
    <td style="min-width:70px;"><input class="q-no" value="${esc(q.qNo)}" aria-label="Question number"/></td>
    <td style="min-width:70px;"><select class="q-sec" aria-label="Section">${sectionOptions(q.paperSection)}</select></td>
    <td style="min-width:70px;"><input class="q-max" type="number" min="0" step="0.5" value="${q.maxMarks || ''}" aria-label="Max"/></td>
    <td style="min-width:140px;"><input class="q-topic" value="${esc(q.topic)}" aria-label="Topic"/></td>
    <td style="min-width:130px;"><input class="q-ch" list="chapter-list" value="${esc(q.chapter)}" aria-label="Chapter"/></td>
    <td style="min-width:140px;"><select class="q-comp" aria-label="Competency"><option value="">—</option>${
      COMPETENCIES.map(c => `<option${c === q.competency ? ' selected' : ''}>${c}</option>`).join('')}</select></td>
    <td style="min-width:80px;"><input class="q-ans" value="${esc(q.correctAnswer)}" aria-label="Answer"/></td>
    <td><button class="btn btn-light btn-sm" onclick="removeQuestionRow(${i})" title="Remove">✕</button></td>
  </tr>`).join('');
  $('questions-body').querySelectorAll('input, select').forEach(el => el.addEventListener('input', renderQuestionSum));
  renderQuestionSum();
}

function renderQuestionSum() {
  const qs = readQuestions();
  if (!qs.length) { $('questions-sum').textContent = 'No questions — marks are entered per section.'; return; }
  const per = {};
  qs.forEach(q => { per[q.paperSection] = (per[q.paperSection] || 0) + q.maxMarks; });
  $('questions-sum').innerHTML = readSections().map(s => {
    const ok = Math.abs((per[s.code] || 0) - s.maxMarks) < 1e-9;
    return `<span class="${ok ? 'sum-ok' : 'sum-bad'}">${esc(s.code)}: ${per[s.code] || 0}/${s.maxMarks}</span>`;
  }).join(' &nbsp; ');
}

window.addQuestionRow = () => {
  editState.questions = readQuestions();
  const sec = readSections()[0]?.code || '';
  editState.questions.push({ qNo: nextQNo(sec), paperSection: sec, maxMarks: 1, topic: '', chapter: '', competency: '', correctAnswer: '' });
  renderQuestions();
};
window.removeQuestionRow = i => {
  editState.questions = readQuestions();
  editState.questions.splice(i, 1);
  renderQuestions();
};
function nextQNo(sec) {
  const n = editState.questions.filter(q => q.paperSection === sec).length;
  return `${sec}${n + 1}`;
}
window.quickAddQuestions = () => {
  editState.questions = readQuestions();
  const count = Math.min(Number($('qa-count').value) || 0, 100);
  const sec = $('qa-section').value;
  const mk = Number($('qa-marks').value) || 1;
  if (!sec || count < 1) return;
  for (let i = 0; i < count; i++) {
    editState.questions.push({ qNo: nextQNo(sec), paperSection: sec, maxMarks: mk, topic: '', chapter: '', competency: '', correctAnswer: '' });
  }
  renderQuestions();
};

// ----- Re-test student picker -----

async function renderRetestStudents() {
  const t = editState;
  const students = await loadClassStudents({ class: t.class, classSection: t.classSection, session: t.session });
  const chosen = new Set(t.retestStudents || []);
  $('retest-students').innerHTML = students.length ? students.map(s => `
    <label><input type="checkbox" value="${esc(s.id)}"${chosen.has(s.id) ? ' checked' : ''}/>
      ${esc(s.rollNo)}. ${esc(s.name)}</label>`).join('') : '<div class="empty">No students found.</div>';
}

window.startRetest = async () => {
  const o = editState;
  const results = await loadResults(o.id);
  const flagged = results.filter(r => (r.flags || []).some(f => f.type === 'copying')).map(r => r.studentId);
  const setNext = o.set && /^[A-Y]$/i.test(o.set) ? String.fromCharCode(o.set.toUpperCase().charCodeAt(0) + 1) : 'B';
  pendingRetest = {
    id: null, session: o.session, class: o.class, classSection: o.classSection || 'All', subject: o.subject,
    testName: `${o.testName} – Re-test`, set: setNext, testDateYmd: '', maxMarks: o.maxMarks, passMarks: o.passMarks,
    chapters: [...(o.chapters || [])], paperSections: o.paperSections.map(s => ({ ...s })),
    questions: (o.questions || []).map(q => ({ ...q })), status: 'draft',
    isRetest: true, retestOf: o.id, retestStudents: flagged
  };
  location.hash = '#new-retest';
};

// ----- Save / delete -----

function readEditor() {
  const t = editState;
  return {
    session: t.session || CURRENT_SESSION,
    class: $('t-class').value,
    classSection: $('t-classSection').value || 'All',
    subject: $('t-subject').value,
    testName: $('t-testName').value.trim(),
    set: $('t-set').value.trim().toUpperCase(),
    testDateYmd: $('t-testDate').value,
    maxMarks: Number($('t-maxMarks').value),
    passMarks: $('t-passMarks').value === '' ? defaultPassMarks($('t-maxMarks').value) : Number($('t-passMarks').value),
    chapters: $('t-chapters').value.split('\n').map(s => s.trim()).filter(Boolean),
    paperSections: readSections(),
    questions: readQuestions()
  };
}

window.saveTest = async (openMarksAfter = false) => {
  const t = editState;
  const v = readEditor();
  const errors = validateTest(v);
  if (t.isRetest) {
    v.retestStudents = Array.from($('retest-students').querySelectorAll('input:checked')).map(i => i.value);
    if (!v.retestStudents.length) errors.push('Pick at least one student for the re-test.');
  }
  if (!ownsTest(v)) errors.push('You can only create tests for your own classes and subject.');
  if (errors.length) {
    showMsg('edit-msg', `<b>Please fix:</b><ul>${errors.map(e => `<li>${esc(e)}</li>`).join('')}</ul>`, 'error');
    window.scrollTo(0, 0);
    return;
  }

  // Warn if sections or questions with saved marks are being removed.
  if (t.id) {
    const removedSecs = (t.paperSections || []).map(s => s.code).filter(c => !v.paperSections.some(s => s.code === c));
    const removedQs = (t.questions || []).map(q => q.qNo).filter(q => !v.questions.some(x => x.qNo === q));
    if ((removedSecs.length || removedQs.length) && (t.summary?.marked || 0) > 0) {
      const ok = await ctConfirm('Remove sections / questions?',
        `Marks already entered for ${[...removedSecs.map(c => 'section ' + c), ...removedQs.map(q => 'question ' + q)].join(', ')} will no longer count.`,
        'Save anyway');
      if (!ok) return;
    }
  }

  const data = {
    session: v.session, class: v.class, classSection: v.classSection, subject: v.subject,
    testName: v.testName, set: v.set,
    testDate: Timestamp.fromMillis(istYmdToMillis(v.testDateYmd)),
    maxMarks: v.maxMarks, passMarks: v.passMarks, chapters: v.chapters,
    paperSections: v.paperSections,
    questions: v.questions.map(q => ({ ...q, competency: q.competency || '' })),
    updatedAt: serverTimestamp()
  };
  if (t.isRetest) Object.assign(data, { isRetest: true, retestOf: t.retestOf, retestStudents: v.retestStudents });

  $('btn-save-test').disabled = $('btn-save-open').disabled = true;
  try {
    let id = t.id;
    if (id) {
      await updateDoc(doc(db, 'classTests', id), data);
    } else {
      const ref = await addDoc(collection(db, 'classTests'), {
        ...data, isRetest: !!t.isRetest, retestOf: t.retestOf || null,
        status: 'draft', createdBy: currentUser.uid, createdByName: currentUser.name, createdAt: serverTimestamp(),
        summary: { marked: 0, absent: 0, avgMarks: null, avgPct: null, passPct: null },
        recommendedAction: '', questionNotes: {}
      });
      id = ref.id;
    }
    location.hash = openMarksAfter ? `#marks/${id}` : '#list';
    if (!openMarksAfter) setTimeout(() => showMsg('global-msg', `✅ Test "${esc(v.testName)}" saved.`, 'success'), 50);
  } catch (err) {
    console.error(err);
    showMsg('edit-msg', '❌ Could not save: ' + esc(err.message), 'error');
  } finally {
    $('btn-save-test').disabled = $('btn-save-open').disabled = false;
  }
};

window.deleteTest = async () => {
  const t = editState;
  const ok = await ctConfirm('Delete this test?',
    `"${t.testName}" (${t.class} ${t.subject}) and all its marks will be deleted. This cannot be undone.`, 'Delete');
  if (!ok) return;
  try {
    const resSnap = await getDocs(collection(db, 'classTests', t.id, 'results'));
    const refs = [];
    for (const r of resSnap.docs) {
      if (isAdmin()) {
        const h = await getDocs(collection(db, 'classTests', t.id, 'results', r.id, 'history'));
        h.docs.forEach(d => refs.push(d.ref));   // teachers can't delete the change log; it stays as an audit trail
      }
      refs.push(r.ref);
    }
    for (let i = 0; i < refs.length; i += 8) {
      const b = writeBatch(db);
      refs.slice(i, i + 8).forEach(r => b.delete(r));
      await b.commit();
    }
    const b = writeBatch(db);
    b.delete(doc(db, 'classTests', t.id));
    await b.commit();
    location.hash = '#list';
    setTimeout(() => showMsg('global-msg', `🗑️ Test "${esc(t.testName)}" deleted.`, 'success'), 50);
  } catch (err) {
    console.error(err);
    showMsg('edit-msg', '❌ Could not delete: ' + esc(err.message), 'error');
  }
};

// =====================================================================
// MARKS ENTRY
// =====================================================================

const BAND_CLASS = {
  [BANDS.EXCELLENT]: 'band-excellent', [BANDS.GOOD]: 'band-good',
  [BANDS.PASS]: 'band-pass', [BANDS.SUPPORT]: 'band-support'
};

async function openMarks(id) {
  $('marks-table').innerHTML = `<tr><td class="empty">Loading…</td></tr>`;
  showMsg('marks-msg', '');
  const t = await loadTest(id);
  if (!ownsTest(t)) throw new Error('This test is not in your classes / subject.');
  const [students, results, retests] = await Promise.all([loadClassStudents(t), loadResults(id), loadRetests(id)]);

  let list = students;
  if (t.isRetest) list = students.filter(s => (t.retestStudents || []).includes(s.id));
  const byId = Object.fromEntries(results.map(r => [r.studentId, r]));
  // Students with saved results who have since left the class still show, at the end.
  const missing = results.filter(r => !list.some(s => s.id === r.studentId))
    .map(r => ({ id: r.studentId, rollNo: r.rollNo, name: r.name, _gone: true }));

  const hasQuestions = (t.questions || []).length > 0;
  marks = {
    test: t,
    retests,
    rows: [...list, ...missing].map(s => {
      const r = byId[s.id];
      return {
        studentId: s.id, rollNo: Number(s.rollNo) || 0, name: s.name || '', gone: !!s._gone,
        saved: r ? snapshotRow(r) : null,
        sectionMarks: { ...(r?.sectionMarks || {}) },
        questionMarks: { ...(r?.questionMarks || {}) },
        absent: !!r?.absent, flags: (r?.flags || []).map(f => ({ ...f })),
        copyingConfirmed: !!r?.copyingConfirmed, remarks: r?.remarks || '',
        errors: new Set()
      };
    }),
    mode: hasQuestions && results.some(r => r.questionMarks && Object.keys(r.questionMarks).length) ? 'question' : 'section',
    dirty: new Set(), saving: false, timer: null
  };
  renderMarksHeader();
  renderGrid();
}

function snapshotRow(r) {
  return JSON.stringify({
    sectionMarks: r.sectionMarks || {}, questionMarks: r.questionMarks || {}, absent: !!r.absent,
    flags: r.flags || [], copyingConfirmed: !!r.copyingConfirmed, remarks: r.remarks || ''
  });
}

function renderMarksHeader() {
  const t = marks.test;
  const editable = canEditMarks(t);
  $('marks-title').innerHTML = `${esc(t.testName)}${t.set ? ` <small style="font-weight:400;">Set ${esc(t.set)}</small>` : ''}
    <span class="badge badge-${t.status === 'final' ? 'final' : 'draft'}">${t.status === 'final' ? 'Final' : 'Draft'}</span>
    ${t.isRetest ? '<span class="badge badge-retest">Re-test</span>' : ''}`;
  $('marks-head').innerHTML = `
    <span>Class: <b>${esc(t.class)}${t.classSection && t.classSection !== 'All' ? '-' + esc(t.classSection) : ''}</b></span>
    <span>Subject: <b>${esc(t.subject)}</b></span>
    <span>Date: <b>${t.testDateMs ? millisToIstDmy(t.testDateMs) : '—'}</b></span>
    <span>Max: <b>${esc(t.maxMarks)}</b></span>
    <span>Pass: <b>${esc(t.passMarks)}</b></span>
    <span>Sections: <b>${t.paperSections.map(s => `${esc(s.code)} /${esc(s.maxMarks)}`).join(', ')}</b></span>`;
  $('btn-edit-test').onclick = () => { location.hash = `#edit/${t.id}`; };
  const hasQ = (t.questions || []).length > 0;
  $('btn-toggle-mode').style.display = hasQ ? '' : 'none';
  $('btn-toggle-mode').textContent = marks.mode === 'question' ? '🔢 Switch to section-wise' : '❓ Switch to question-wise';
  $('btn-save-now').style.display = editable ? '' : 'none';
  $('btn-finalise').style.display = editable ? '' : 'none';
  $('btn-unfinalise').style.display = t.status === 'final' && isAdmin() ? '' : 'none';
  if (t.status === 'final') {
    showMsg('marks-msg', `🔒 Finalised${isAdmin() ? '. Use “Back to draft” to change marks.' : '. Only an admin can change these marks.'}`, 'info');
  } else if (!ownsTest(t)) {
    showMsg('marks-msg', 'View only.', 'info');
  }
  setSaveStatus(editable ? 'All changes saved' : '');
}

window.toggleMode = () => {
  const q = marks.mode !== 'question';
  if (!q && marks.rows.some(r => Object.keys(r.questionMarks).length)) {
    // Going back to section-wise: section totals are kept from the question marks.
    marks.rows.forEach(r => {
      if (Object.keys(r.questionMarks).length) r.sectionMarks = sectionTotalsFromQuestions(r.questionMarks, marks.test.questions);
    });
  }
  marks.mode = q ? 'question' : 'section';
  renderMarksHeader();
  renderGrid();
};

function columns() {
  const t = marks.test;
  return marks.mode === 'question'
    ? t.questions.map(q => ({ key: q.qNo, label: q.qNo, sub: `/${q.maxMarks}`, max: q.maxMarks, kind: 'q' }))
    : t.paperSections.map(s => ({ key: s.code, label: s.code, sub: `/${s.maxMarks}`, max: s.maxMarks, kind: 's' }));
}

function rowResult(row) {
  const t = marks.test;
  const r = { absent: row.absent, sectionMarks: row.sectionMarks };
  if (marks.mode === 'question' || Object.keys(row.questionMarks).length) r.questionMarks = row.questionMarks;
  return computeResult(r, t);
}

function retestNote(row) {
  const applied = applyRetests([{ studentId: row.studentId, ...rowAsResult(row) }], marks.test, marks.retests)[0];
  if (!applied.cancelled) return '';
  return `<span class="rt-note">Re-test: ${round1(applied.computed.total)} (this score cancelled)</span>`;
}

function rowAsResult(row) {
  const r = { absent: row.absent, sectionMarks: row.sectionMarks };
  if (Object.keys(row.questionMarks).length) r.questionMarks = row.questionMarks;
  return r;
}

function renderGrid() {
  const t = marks.test;
  const editable = canEditMarks(t);
  const cols = columns();
  const ro = !editable ? ' disabled' : '';
  const head = `<thead><tr>
    <th class="sticky1">Roll</th><th class="sticky2">Name</th>
    ${cols.map(c => `<th class="sec">${esc(c.label)}<small>${esc(c.sub)}</small></th>`).join('')}
    <th class="num">Total<small>/${esc(t.maxMarks)}</small></th><th class="num">%</th><th>Result</th>
    <th class="center">Absent</th><th>Flags</th><th>Remarks</th></tr></thead>`;
  const body = marks.rows.map((row, ri) => {
    const sectionLocked = marks.mode === 'section' && Object.keys(row.questionMarks).length > 0;
    const cells = cols.map((c, ci) => {
      const src = c.kind === 'q' ? row.questionMarks : row.sectionMarks;
      const val = src[c.key] ?? '';
      const dis = ro || row.absent || sectionLocked ? ' disabled' : '';
      const title = sectionLocked ? ' title="Calculated from question-wise marks"' : '';
      return `<td class="center"><input class="mk" type="number" inputmode="decimal" min="0" max="${c.max}" step="0.5"
        data-r="${ri}" data-c="${ci}" data-key="${esc(c.key)}" data-kind="${c.kind}" data-max="${c.max}"
        value="${esc(val)}"${dis}${title} aria-label="${esc(row.name)} ${esc(c.label)}"/></td>`;
    }).join('');
    return `<tr id="mrow-${ri}" class="${row.absent ? 'absent' : ''}">
      <td class="sticky1">${esc(row.rollNo || '—')}</td>
      <td class="sticky2" title="${esc(row.name)}">${esc(row.name)}${row.gone ? ' <small style="color:#c0392b;">(left class)</small>' : ''}</td>
      ${cells}
      <td class="num" id="tot-${ri}"></td><td class="num" id="pct-${ri}"></td><td id="band-${ri}"></td>
      <td class="center"><input type="checkbox" data-absent="${ri}"${row.absent ? ' checked' : ''}${ro} aria-label="Absent"/></td>
      <td><button class="flag-btn" id="flagbtn-${ri}" onclick="openFlags(${ri})"${ro}></button></td>
      <td><input class="rm" data-remark="${ri}" value="${esc(row.remarks)}"${ro} aria-label="Remarks"/></td>
    </tr>`;
  }).join('');
  $('marks-table').innerHTML = head + `<tbody>${body || '<tr><td colspan="20" class="empty">No students found for this class.</td></tr>'}</tbody>`;
  marks.rows.forEach((_, ri) => refreshRow(ri));

  const tbl = $('marks-table');
  tbl.querySelectorAll('input.mk').forEach(inp => {
    inp.addEventListener('input', onMarkInput);
    inp.addEventListener('keydown', onMarkKey);
  });
  tbl.querySelectorAll('input[data-absent]').forEach(cb => cb.addEventListener('change', e => {
    const ri = Number(e.target.dataset.absent);
    marks.rows[ri].absent = e.target.checked;
    $(`mrow-${ri}`).classList.toggle('absent', e.target.checked);
    $(`mrow-${ri}`).querySelectorAll('input.mk').forEach(i => {
      i.disabled = e.target.checked || (marks.mode === 'section' && Object.keys(marks.rows[ri].questionMarks).length > 0);
    });
    touch(ri);
  }));
  tbl.querySelectorAll('input[data-remark]').forEach(inp => inp.addEventListener('input', e => {
    const ri = Number(e.target.dataset.remark);
    marks.rows[ri].remarks = e.target.value;
    touch(ri);
  }));
}

function onMarkInput(e) {
  const inp = e.target;
  const ri = Number(inp.dataset.r);
  const row = marks.rows[ri];
  const key = inp.dataset.key;
  const err = checkMark(inp.value, inp.dataset.max);
  inp.classList.toggle('bad', !!err);
  inp.title = err || '';
  const errKey = `${inp.dataset.kind}:${key}`;
  if (err) row.errors.add(errKey); else row.errors.delete(errKey);
  const target = inp.dataset.kind === 'q' ? row.questionMarks : row.sectionMarks;
  if (inp.value === '') delete target[key];
  else if (!err) target[key] = Number(inp.value);
  if (inp.dataset.kind === 'q') row.sectionMarks = sectionTotalsFromQuestions(row.questionMarks, marks.test.questions);
  touch(ri);
}

function onMarkKey(e) {
  if (e.key !== 'Enter') return;
  e.preventDefault();
  const r = Number(e.target.dataset.r), c = e.target.dataset.c;
  for (let i = r + 1; i < marks.rows.length; i++) {
    const next = $('marks-table').querySelector(`input.mk[data-r="${i}"][data-c="${c}"]`);
    if (next && !next.disabled) { next.focus(); next.select(); return; }
  }
}

function refreshRow(ri) {
  const row = marks.rows[ri];
  const c = rowResult(row);
  const note = retestNote(row);
  const tr = $(`mrow-${ri}`);
  if (row.absent) {
    $(`tot-${ri}`).innerHTML = 'AB' + note;
    $(`pct-${ri}`).textContent = '';
    $(`band-${ri}`).innerHTML = '<span class="band">Absent</span>';
  } else if (!c.entered) {
    $(`tot-${ri}`).innerHTML = '—' + note;
    $(`pct-${ri}`).textContent = '';
    $(`band-${ri}`).textContent = '';
  } else {
    $(`tot-${ri}`).innerHTML = `<b class="${note ? 'cancelled' : ''}">${round1(c.total)}</b>${note}`;
    $(`pct-${ri}`).textContent = round1(c.percentage) + '%';
    $(`band-${ri}`).innerHTML = `<span class="band ${BAND_CLASS[c.resultBand] || ''}">${esc(c.resultBand)}</span>`;
  }
  const n = row.flags.length;
  $(`flagbtn-${ri}`).textContent = n ? `🚩 ${n}${row.copyingConfirmed ? ' ✔' : ''}` : '＋ Flag';
  $(`flagbtn-${ri}`).classList.toggle('has', n > 0);
  tr.classList.toggle('err', row.errors.size > 0);
}

function touch(ri) {
  marks.dirty.add(ri);
  $(`mrow-${ri}`).classList.add('dirty');
  refreshRow(ri);
  setSaveStatus('Unsaved changes…');
  clearTimeout(marks.timer);
  marks.timer = setTimeout(() => flushSave(), AUTOSAVE_MS);
}

function setSaveStatus(text, cls = '') {
  const el = $('save-status');
  el.textContent = text;
  el.className = 'save-status' + (cls ? ' ' + cls : '');
}

function buildResultDoc(row) {
  const t = marks.test;
  const c = rowResult(row);
  const useQ = Object.keys(row.questionMarks).length > 0;
  return {
    studentId: row.studentId, rollNo: row.rollNo, name: row.name,
    class: t.class, subject: t.subject, session: t.session, testDate: t.testDate,
    sectionMarks: useQ ? sectionTotalsFromQuestions(row.questionMarks, t.questions) : row.sectionMarks,
    questionMarks: useQ ? row.questionMarks : {},
    total: c.entered ? round1(c.total) : null,
    percentage: c.entered ? round1(c.percentage) : null,
    resultBand: row.absent ? 'Absent' : (c.entered ? c.resultBand : null),
    absent: row.absent,
    isRetest: !!t.isRetest, retestOf: t.retestOf || null,
    flags: row.flags, copyingConfirmed: row.copyingConfirmed, remarks: row.remarks.trim(),
    enteredBy: currentUser.uid, enteredByName: currentUser.name, updatedAt: serverTimestamp()
  };
}

async function flushSave() {
  if (!marks) return;
  clearTimeout(marks.timer);
  if (marks.saving) { marks.timer = setTimeout(() => flushSave(), 500); return; }
  const t = marks.test;
  if (!canEditMarks(t)) return;
  const ready = [...marks.dirty].filter(ri => marks.rows[ri].errors.size === 0);
  const blocked = marks.dirty.size - ready.length;
  if (!ready.length) {
    if (blocked) setSaveStatus(`${blocked} row(s) not saved — fix the red cells`, 'error');
    return;
  }
  marks.saving = true;
  setSaveStatus('Saving…', 'saving');
  try {
    for (let i = 0; i < ready.length; i += STUDENTS_PER_BATCH) {
      const chunk = ready.slice(i, i + STUDENTS_PER_BATCH);
      const batch = writeBatch(db);
      const written = [];
      for (const ri of chunk) {
        const row = marks.rows[ri];
        const data = buildResultDoc(row);
        const after = snapshotRow(data);
        if (after === row.saved) { written.push([ri, after]); continue; }   // nothing actually changed
        const ref = doc(db, 'classTests', t.id, 'results', row.studentId);
        batch.set(ref, data);
        batch.set(doc(collection(ref, 'history')), {
          before: row.saved ? JSON.parse(row.saved) : null,
          after: JSON.parse(after),
          changedBy: currentUser.uid, changedByName: currentUser.name, changedAt: serverTimestamp()
        });
        written.push([ri, after]);
      }
      await batch.commit();
      for (const [ri, after] of written) {
        const row = marks.rows[ri];
        row.saved = after;
        // Keep the row dirty if it was edited again while saving.
        if (snapshotRow(buildResultDoc(row)) === after) {
          marks.dirty.delete(ri);
          $(`mrow-${ri}`)?.classList.remove('dirty');
        }
      }
    }
    await updateSummary();
    const left = marks.dirty.size;
    const time = new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });
    if (blocked) setSaveStatus(`Saved ${time} · ${blocked} row(s) not saved — fix the red cells`, 'error');
    else setSaveStatus(left ? 'Unsaved changes…' : `All changes saved · ${time}`);
    if (left && !blocked) marks.timer = setTimeout(() => flushSave(), AUTOSAVE_MS);
  } catch (err) {
    console.error(err);
    setSaveStatus('Save failed — ' + err.message, 'error');
  } finally {
    marks.saving = false;
  }
}
window.flushSave = flushSave;

function currentStats() {
  const rows = marks.rows.map(r => ({ studentId: r.studentId, ...rowAsResult(r) }));
  const applied = applyRetests(rows, marks.test, marks.retests);
  return classStats(applied, marks.test);
}

async function updateSummary() {
  const summary = summaryForList(currentStats());
  await updateDoc(doc(db, 'classTests', marks.test.id), { summary, updatedAt: serverTimestamp() });
  marks.test.summary = summary;
  // A re-test changes its original's numbers; refresh the original's list summary too.
  if (marks.test.isRetest && marks.test.retestOf) await refreshOriginalSummary(marks.test.retestOf);
}

async function refreshOriginalSummary(origId) {
  try {
    const [orig, results, retests] = await Promise.all([loadTest(origId), loadResults(origId), loadRetests(origId)]);
    if (!ownsTest(orig)) return;
    const stats = classStats(applyRetests(results, orig, retests), orig);
    await updateDoc(doc(db, 'classTests', origId), { summary: summaryForList(stats), updatedAt: serverTimestamp() });
  } catch (err) {
    console.warn('Could not refresh original test summary', err);
  }
}

window.finaliseTest = async () => {
  await flushSave();
  const t = marks.test;
  if (marks.dirty.size) { showMsg('marks-msg', '❌ Some rows are not saved yet. Fix the red cells first.', 'error'); return; }
  if (isFutureYmd(t.testDateYmd)) {
    showMsg('marks-msg', `❌ The test date (${millisToIstDmy(t.testDateMs)}) is in the future. You can finalise after the test is held.`, 'error');
    return;
  }
  const pending = marks.rows.filter(r => !r.absent && !rowResult(r).entered && !r.gone).length;
  const msg = (pending ? `${pending} student(s) have no marks and are not marked absent.\n\n` : '') +
    'After finalising, marks are locked. Only an admin can unlock them.';
  if (!await ctConfirm('Finalise this test?', msg, 'Finalise', false)) return;
  try {
    await updateDoc(doc(db, 'classTests', t.id), {
      status: 'final', finalisedBy: currentUser.uid, finalisedAt: serverTimestamp(), updatedAt: serverTimestamp()
    });
    marks.test.status = 'final';
    renderMarksHeader();
    renderGrid();
    showMsg('marks-msg', '✅ Test finalised.', 'success');
  } catch (err) {
    showMsg('marks-msg', '❌ Could not finalise: ' + esc(err.message), 'error');
  }
};

window.unfinaliseTest = async () => {
  if (!isAdmin()) return;
  if (!await ctConfirm('Move back to draft?', 'Teachers will be able to change the marks again.', 'Back to draft', false)) return;
  await updateDoc(doc(db, 'classTests', marks.test.id), { status: 'draft', updatedAt: serverTimestamp() });
  marks.test.status = 'draft';
  renderMarksHeader();
  renderGrid();
};

// ----- Flags modal -----

let flagRow = null;
let flagDraft = [];

window.openFlags = ri => {
  flagRow = ri;
  const row = marks.rows[ri];
  flagDraft = row.flags.map(f => ({ ...f }));
  if (!flagDraft.length) flagDraft.push({ type: 'copying', groupId: '', note: '' });
  $('flags-title').textContent = `Flags — ${row.rollNo}. ${row.name}`;
  $('flags-confirmed').checked = row.copyingConfirmed;
  renderFlagRows();
  $('flags-modal').classList.add('open');
};

function renderFlagRows() {
  $('flags-rows').innerHTML = flagDraft.map((f, i) => `<div class="flag-row">
    <select data-f="${i}" data-k="type" aria-label="Flag type">${FLAG_TYPES.map(x => `<option${x === f.type ? ' selected' : ''}>${x}</option>`).join('')}</select>
    <input data-f="${i}" data-k="groupId" placeholder="Group (G1)" value="${esc(f.groupId)}" aria-label="Group"/>
    <input data-f="${i}" data-k="note" placeholder="Note" value="${esc(f.note)}" aria-label="Note"/>
    <button class="btn btn-light btn-sm" onclick="removeFlagRow(${i})" title="Remove">✕</button>
  </div>`).join('') || '<p class="hint">No flags.</p>';
  $('flags-rows').querySelectorAll('[data-f]').forEach(el => el.addEventListener('input', e => {
    flagDraft[Number(e.target.dataset.f)][e.target.dataset.k] = e.target.value;
  }));
}

window.addFlagRow = () => { flagDraft.push({ type: 'copying', groupId: '', note: '' }); renderFlagRows(); };
window.removeFlagRow = i => { flagDraft.splice(i, 1); renderFlagRows(); };
window.closeFlags = () => { $('flags-modal').classList.remove('open'); flagRow = null; };
window.applyFlags = () => {
  const row = marks.rows[flagRow];
  row.flags = flagDraft
    .map(f => ({ type: f.type, groupId: String(f.groupId || '').trim().toUpperCase(), note: String(f.note || '').trim() }))
    .filter(f => f.type);
  row.copyingConfirmed = $('flags-confirmed').checked;
  const ri = flagRow;
  closeFlags();
  touch(ri);
};
