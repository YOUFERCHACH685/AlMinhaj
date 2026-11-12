/* ==========================================================================
   exam.js — moteur du passage de l'épreuve côté candidat
   - tirage aléatoire du modèle, de l'ordre des questions et des choix
   - chronomètre par question (45 s QCM / 180 s rédaction)
   - correction automatique + récapitulatif + export PDF (impression)
   Encapsulé dans une IIFE : évite toute collision de noms avec les autres scripts.
   ========================================================================== */

(function () {
  "use strict";

  const { Store, gradePaper, esc, shuffle, uid, fmtDate, fmtClock, fmtDuration, toast, wordCount, deviceId, normalizeAr, pad2, PLACE_LIST, placeLabel } = window.App;

const KEYS = { progress: "manhaj_progress_v1", wait: "manhaj_waiting_v1", code: "manhaj_code_v1" };

const S = {
  bank: null,
  settings: null,
  formKey: "A",
  form: null,
  questions: [],
  idx: 0,
  answers: {},
  startedAt: null,
  qDeadline: 0,       /* timestamp ms de fin de la question courante */
  remaining: 0,
  tick: null,
  finished: false,
  persisting: false,
  examStarted: false,
  resumeRemaining: null,
  previousRow: null,
  candidate: { first: "", last: "" },
  submission: null,
  launch: null,          /* حالة جلسة الإطلاق الحالية */
  waitingId: null,       /* معرّف سجل الانتظار لهذه المحاولة (إن وُجد) */
  waitPoll: null,        /* مؤقّت استطلاع حالة الإطلاق */
  waitClock: null,       /* مؤقّت عرض مدة الانتظار */
  sessionPoll: null,     /* مؤقّت كشف إغلاق الجلسة أثناء الاختبار */
  progressTimer: null,   /* حفظ دوري للتقدّم في السحابة */
  progressSaving: false, /* منع تراكب طلبات الحفظ */
  lastProgressAt: 0,
  lastCloudSaveAt: 0,
  resultUnlocked: false, /* هل سُمح بعرض النتيجة بعد إنهاء الجلسة؟ */
  finishedSaved: false,  /* هل حُفظت النسخة النهائية؟ */
  finishedRec: null,     /* النسخة النهائية بانتظار إنهاء الجلسة */
  finishedGraded: null,
  accessCode: "",        /* رمز المترشح (بيانات الدخول) */
  codeHash: "",          /* بصمة الرمز (تُحفظ في النسخة) */
  unlockPoll: null,
  finishClock: null,
  finishSince: 0,
  waitSince: 0,
  countPoll: null
};

/* --------------------------------------------------------------- utilitaires */
function formTotal(formObj) {
  return formObj.questions.reduce((s, q) => s + Number(q.points || 0), 0);
}

function pickForm(bank, settings) {
  const mode = settings.formMode || "random";
  if (mode === "A" || mode === "B") return mode;
  return Math.random() < 0.5 ? "A" : "B";
}

function buildPaper(bank, settings) {
  const formKey = pickForm(bank, settings);
  const srcRaw = bank && bank.forms && bank.forms[formKey];
  if (!srcRaw || !Array.isArray(srcRaw.questions) || !srcRaw.questions.length) {
    throw new Error("لا توجد أسئلة في النموذج " + formKey + ".");
  }
  const src = JSON.parse(JSON.stringify(srcRaw));
  /* ordre des questions aléatoire */
  const questions = shuffle(src.questions).map(q => {
    if (q.type === "mcq") {
      const opts = shuffle(q.options);
      /* les identifiants sont conservés : la correction reste exacte */
      return { ...q, options: opts, correct: q.correct };
    }
    return q;
  });
  return { formKey, form: { ...src, questions } };
}

/* ------------------------------------------------------------------ timer */
function stopTick() {
  if (S.tick) { clearInterval(S.tick); S.tick = null; }
}

function allottedSeconds(q) {
  if (q.type === "open") return Number(S.settings.openSeconds || 180);
  return Number(S.settings.mcqSeconds || 45);
}

/* وصف زمني عربي مقروء: 45 ثانية / دقيقتان / 3 دقائق */
function arabicDuration(sec) {
  const s = Math.max(0, Math.round(Number(sec) || 0));
  if (s < 60) return `${s} ثانية`;
  const m = Math.floor(s / 60);
  const r = s % 60;
  const mTxt = m === 1 ? "دقيقة" : m === 2 ? "دقيقتان" : `${m} دقائق`;
  return r ? `${mTxt} و${r} ثانية` : mTxt;
}

/* يُحدِّث وصف الاختبار من الإعدادات الحالية (المدد + عدد الأسئلة + المجموع) */
function renderIntroSpecs() {
  if (!S.bank) return;
  const form = S.bank.forms.A;
  const mcq = form.questions.filter(q => q.type === "mcq").length;
  const open = form.questions.filter(q => q.type === "open").length;
  const totalQ = mcq + open;
  const totalPoints = formTotal(form);
  const mcqSec = Number(S.settings.mcqSeconds || 45);
  const openSec = Number(S.settings.openSeconds || 180);

  const eyebrow = $("#intro-eyebrow");
  if (eyebrow) eyebrow.textContent = `اختبار كتابي — ${totalQ} سؤالًا على ${totalPoints}`;

  const lead = $("#intro-lead");
  if (lead) {
    lead.innerHTML =
      `اختبار في مضامين كتاب «المنهاج النبوي: تربية وتنظيمًا وزحفًا» للإمام عبد السلام ياسين: ` +
      `عدد أسئلة الاختيار من متعدد <b>${mcq}</b>، وعدد أسئلة التعبير <b>${open}</b>، ` +
      `يُصحَّح غالبها آليًّا وتُراجع أجوبة التعبير من طرف المشرف.`;
  }

  const specs = $("#intro-specs");
  if (!specs) return;
  const numerals = ["١", "٢", "٣", "٤", "٥", "٦"];
  const items = [];
  if (mcq) items.push(`أسئلة الاختيار من متعدد: <b>${mcq}</b>، لكل سؤال <b>${arabicDuration(mcqSec)}</b>.`);
  if (open) items.push(`أسئلة التعبير: <b>${open}</b>، لكل سؤال <b>${arabicDuration(openSec)}</b>.`);
  items.push("ترتيب الأسئلة وترتيب الاختيارات <b>عشوائي لكل مترشح</b>.");
  items.push(`المجموع على <b>${totalPoints}</b>، والتنقيط موزّع بحسب أهمّية المفهوم.`);
  items.push("تُحفظ نسختك عند الإنهاء، وتظهر النتيجة مع تصحيح كل جواب بعد أن يضغط المشرف على <b>«إنهاء الاختبار»</b>، ويمكنك استخراجها <b>PDF</b>.");
  specs.innerHTML = items.map((t, i) =>
    `<li><span class="k">${numerals[i] || (i + 1)}</span><span>${t}</span></li>`).join("");
}

/* تحديث خفيف للإعدادات في الخلفية حتى تُطبَّق على الأسئلة اللاحقة */
let settingsRefresh = null;
function refreshSettingsSoon() {
  if (settingsRefresh) return;
  settingsRefresh = Store.getSettings()
    .then(s => { if (s) S.settings = s; })
    .catch(() => { /* garder le cache */ })
    .finally(() => { settingsRefresh = null; });
}

function startQuestionTimer(savedRemaining) {
  stopTick();
  const q = S.questions[S.idx];
  if (!q) return;
  const allotted = allottedSeconds(q);
  let secs = Number.isFinite(savedRemaining) ? savedRemaining : allotted;
  secs = Math.max(0, Math.min(allotted, secs));
  S.qDeadline = Date.now() + secs * 1000;
  S.remaining = secs;
  renderTimer(allotted);

  S.tick = setInterval(() => {
    const total = allottedSeconds(S.questions[S.idx]);
    S.remaining = Math.max(0, Math.ceil((S.qDeadline - Date.now()) / 1000));
    renderTimer(total);
    if (S.remaining <= 0) {
      stopTick();
      toast("انتهى وقت هذا السؤال");
      autosave();
      nextQuestion(true);
    }
  }, 250);
}

function renderTimer(total) {
  const txt = $("#time-text");
  const ring = $("#ring");
  const wrap = $("#timer");
  if (!txt) return;
  txt.textContent = fmtClock(S.remaining);
  const C = 2 * Math.PI * 18;
  const ratio = total > 0 ? S.remaining / total : 0;
  ring.setAttribute("stroke-dasharray", C.toFixed(1));
  ring.setAttribute("stroke-dashoffset", (C * (1 - ratio)).toFixed(1));
  wrap.classList.toggle("is-low", S.remaining <= Math.min(30, total * 0.4));
  wrap.classList.toggle("is-critical", S.remaining <= 10);
}

/* --------------------------------------------------------------- rendu QCM */
function renderQuestion() {
  const q = S.questions[S.idx];
  const totalQ = S.questions.length;

  $("#q-topic").textContent = q.topic || "—";
  $("#q-type").textContent = q.type === "mcq" ? "اختيار من متعدد" : "تعبير";
  $("#q-count").textContent = `السؤال ${S.idx + 1} من ${totalQ}`;
  $("#q-text").textContent = q.text;
  $("#q-points").textContent = `${q.points} نقطة`;

  const bar = $("#progress");
  const pct = Math.round((S.idx / totalQ) * 100);
  bar.setAttribute("aria-valuenow", String(pct));
  bar.querySelector("i").style.width = pct + "%";

  const opts = $("#q-opts");
  const openWrap = $("#q-open-wrap");
  const nextBtn = $("#btn-next");

  if (q.type === "mcq") {
    opts.hidden = false;
    openWrap.hidden = true;
    opts.innerHTML = "";
    const letters = ["أ", "ب", "ج", "د", "هـ", "و"];
    q.options.forEach((o, i) => {
      const li = document.createElement("li");
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "opt";
      btn.setAttribute("role", "radio");
      btn.setAttribute("aria-checked", String(S.answers[q.id]?.choice === o.id));
      btn.dataset.opt = o.id;
      btn.innerHTML =
        `<span class="key" aria-hidden="true">${letters[i] || i + 1}</span>` +
        `<span>${esc(o.text)}</span>`;
      btn.addEventListener("click", () => selectOption(q, o.id));
      li.appendChild(btn);
      opts.appendChild(li);
    });
    nextBtn.textContent = S.idx === totalQ - 1 ? "إنهاء الاختبار" : "السؤال التالي";
  } else {
    opts.hidden = true;
    opts.innerHTML = ""; /* évite tout reliquat du QCM précédent */
    openWrap.hidden = false;
    const ta = $("#q-open");
    ta.value = S.answers[q.id]?.text || "";
    $("#q-min").textContent = S.settings.minWords || 8;
    updateWords();
    ta.oninput = () => {
      S.answers[q.id] = { text: ta.value };
      updateWords();
      autosave();
    };
    ta.focus();
    nextBtn.textContent = S.idx === totalQ - 1 ? "إنهاء الاختبار" : "السؤال التالي";
  }

  const pending = S.resumeRemaining;
  S.resumeRemaining = null;
  startQuestionTimer(pending == null ? undefined : pending);
  refreshSettingsSoon();
  autosave();
}

function updateWords() {
  const ta = $("#q-open");
  const n = wordCount(ta ? ta.value : "");
  $("#q-words").textContent = `${n} كلمة`;
}

function selectOption(q, optId) {
  S.answers[q.id] = { choice: optId };
  $$("#q-opts .opt").forEach(b => {
    b.setAttribute("aria-checked", String(b.dataset.opt === optId));
  });
  autosave();
  /* petit délai : laisse voir la sélection avant de passer */
  const btn = $("#btn-next");
  btn.classList.add("btn-gold");
}

/* --------------------------------------------------------------- navigation */
function nextQuestion(auto) {
  const q = S.questions[S.idx];
  /* mémorise la rédaction en cours */
  if (q.type === "open") {
    const ta = $("#q-open");
    if (ta) S.answers[q.id] = { text: ta.value };
  }
  if (q.type === "mcq" && !auto && !S.answers[q.id]) {
    toast("لم تختر جوابًا — سيُحتسب السؤال خاطئًا إن واصلت", true);
  }

  stopTick();
  if (S.idx >= S.questions.length - 1) {
    finishExam();
    return;
  }
  S.idx++;
  $("#btn-next").classList.remove("btn-gold");
  renderQuestion();
  window.scrollTo({ top: 0, behavior: "smooth" });
}

/* --------------------------------------------------------------- persistance */
function autosave() {
  if (S.finished) return;
  try {
    localStorage.setItem(KEYS.progress, JSON.stringify({
      v: 1,
      bankVersion: S.bank.version,
      formKey: S.formKey,
      questions: S.questions,
      answers: S.answers,
      idx: S.idx,
      remaining: S.remaining,
      deadline: S.qDeadline,
      startedAt: S.startedAt,
      candidate: S.candidate,
      launch: S.launch ? { id: S.launch.id, label: S.launch.label, status: S.launch.status } : null,
      waitingId: S.waitingId,
      savedAt: Date.now()
    }));
  } catch (e) { /* quota : sans effet bloquant */ }
}

function clearProgress() {
  try { localStorage.removeItem(KEYS.progress); } catch (e) { /* ignore */ }
}

function captureOpenAnswer() {
  const q = S.questions[S.idx];
  if (q && q.type === "open") {
    const ta = $("#q-open");
    if (ta) S.answers[q.id] = { text: ta.value };
  }
}

function stopProgressTimer() {
  if (S.progressTimer) { clearInterval(S.progressTimer); S.progressTimer = null; }
}

/* نسخة مختصرة من التقدّم تُحفظ في السحابة: تسمح للمشرف بتصحيح من غادر
   قبل انتهاء الوقت، وتُستعاد النتيجة عند إعادة فتح الصفحة. */
function setSaveState(kind, text) {
  const el = document.getElementById("save-state");
  if (!el) return;
  el.dataset.state = kind;
  const labels = {
    idle: "حفظ تلقائي مفعّل",
    saving: "جارٍ الحفظ…",
    saved: "تم الحفظ",
    error: "تعذّر الحفظ — أعد المحاولة",
    offline: "لا اتصال — حفظ محلي"
  };
  const titles = {
    idle: "حفظ التقدّم تلقائيًا في السحابة",
    saving: "جارٍ إرسال تقدّمك إلى المشرف",
    saved: "تم حفظ تقدّمك بنجاح",
    error: "اضغط هنا لإعادة المحاولة الآن",
    offline: "ستُحفظ أجوبتك محليًا وتُرسل عند عودة الاتصال"
  };
  const label = document.getElementById("save-state-text");
  const msg = text || labels[kind] || labels.idle;
  if (label) label.textContent = msg; else el.textContent = msg;
  el.title = titles[kind] || titles.idle;
}

async function saveProgressNow(force) {
  if (!S.examStarted || S.finished || S.persisting || !S.waitingId || S.progressSaving) return;
  if (!force && Date.now() - S.lastProgressAt < 3000) return;
  S.lastProgressAt = Date.now();
  captureOpenAnswer();
  S.progressSaving = true;
  setSaveState("saving");
  try {
    await Store.updateSubmission(S.waitingId, {
      progress: JSON.stringify({
        v: 1,
        answers: S.answers,
        idx: S.idx,
        index: S.idx + 1,
        total: S.questions.length,
        form: S.formKey,
        startedAt: S.startedAt,
        candidate: S.candidate,
        updatedAt: new Date().toISOString()
      }),
      progress_at: new Date().toISOString()
    });
    S.lastCloudSaveAt = Date.now();
    const d = new Date(S.lastCloudSaveAt);
    const clock = `${d.getHours()}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
    setSaveState("saved", `تم الحفظ ${clock}`);
  } catch (e) {
    if (navigator.onLine === false) setSaveState("offline");
    else setSaveState("error");
  } finally {
    S.progressSaving = false;
  }
}

function startProgressTimer() {
  stopProgressTimer();
  saveProgressNow();
  S.progressTimer = setInterval(saveProgressNow, 12000);
}

function readProgress() {
  try {
    const raw = localStorage.getItem(KEYS.progress);
    if (!raw) return null;
    const p = JSON.parse(raw);
    if (!p || !p.questions || !p.questions.length) return null;
    if (Date.now() - (p.savedAt || 0) > 6 * 3600 * 1000) return null;
    return p;
  } catch (e) { return null; }
}

/* ------------------------------------------------------------------ clôture */
async function finishExam() {
  if (S.finished || S.persisting) return;
  S.persisting = true;
  S.resultUnlocked = false;
  S.finishedSaved = false;
  stopTick();
  stopSessionPoll();
  stopUnlockPoll();
  stopFinishClock();
  stopProgressTimer();
  captureOpenAnswer();

  let graded;
  try {
    graded = gradePaper(S.form, S.answers);
  } catch (e) {
    console.error(e);
    S.persisting = false;
    toast("تعذّر تصحيح النسخة. أعد المحاولة.", true);
    return;
  }

  const duration = Math.round((Date.now() - new Date(S.startedAt).getTime()) / 1000);

  const snapshot = S.form.questions.map(q => {
    const d = graded.details.find(x => x.qid === q.id) || {};
    if (q.type === "mcq") {
      return {
        qid: q.id, type: "mcq", topic: q.topic, points: q.points, text: q.text,
        options: q.options.map(o => ({ id: o.id, text: o.text })),
        correct: q.correct, explain: q.explain || "",
        given: d.given || null
      };
    }
    return {
      qid: q.id, type: "open", topic: q.topic, points: q.points, text: q.text,
      modelAnswer: q.modelAnswer || "",
      rubric: (q.rubric || []).map(r => ({ id: r.id, points: r.points, label: r.label })),
      openText: d.openText || ""
    };
  });

  const rec = {
    id: S.waitingId || uid(),
    candidate_first: S.candidate.first,
    candidate_last: S.candidate.last,
    place_code: S.candidate.placeCode || "",
    place_name: S.candidate.placeName || "",
    form: S.formKey,
    session_id: S.launch ? S.launch.id : null,
    device_id: deviceId(),
    started_at: S.startedAt,
    finished_at: new Date().toISOString(),
    duration_sec: duration,
    code_hash: S.codeHash || "",
    /* لا تُرسل النقاط ولا ملاحظات التصحيح: قواعد Firebase تمنع المترشح
       من كتابتها (المشرف وحده ينشر التصحيح الرسمي). */
    status: "submitted",
    answers: JSON.stringify({
      bankVersion: S.bank.version,
      form: S.formKey,
      sessionId: S.launch ? S.launch.id : null,
      deviceId: deviceId(),
      details: graded.details,
      snapshot,
      settings: { mcqSeconds: S.settings.mcqSeconds, openSeconds: S.settings.openSeconds }
    })
  };

  S.submission = rec;
  S.finishedRec = rec;
  S.finishedGraded = graded;
  S.finishSince = Date.now();

  /* لا تُعرض النتيجة الآن: نُظهر شاشة انتظار إلى أن يُنهي المشرف الجلسة. */
  try { showFinishWaiting(rec, { saving: true }); }
  catch (e) { console.error("showFinishWaiting failed", e); }

  let saved = false;
  for (let attempt = 0; attempt < 3 && !saved; attempt++) {
    try {
      if (S.waitingId) {
        await Store.updateSubmission(S.waitingId, { ...rec, progress: null, progress_at: null });
      } else {
        await Store.addSubmission(rec);
      }
      saved = true;
    } catch (e) {
      console.warn("Enregistrement de la copie impossible", e);
      /* قد يكون المشرف نشر التصحيح الرسمي فنُفلت النسخة (وهي مقفلة عندها).
         في هذه الحالة نعتبر النسخة محفوظة ونقرأ النسخة المنشورة. */
      if (S.waitingId) {
        try {
          const fresh = await Store.getSubmission(S.waitingId);
          if (fresh && fresh.finished_at &&
              (fresh.official || fresh.status === "submitted" || fresh.status === "auto" || fresh.status === "validated")) {
            saved = true;
            S.finishedRec = fresh;
          }
        } catch (e2) { /* ignore */ }
      }
      if (S.waitingId && attempt === 1) {
        try { await Store.addSubmission(rec); saved = true; }
        catch (e2) { console.warn("addSubmission fallback failed", e2); }
      }
    }
    if (!saved) await new Promise(r => setTimeout(r, 900 * (attempt + 1)));
  }

  if (saved) {
    rememberLocalRow(rec);
    S.finished = true;
    S.finishedSaved = true;
    clearProgress();
    markDeviceFinished(S.launch ? S.launch.id : null);
    setResultSaveNote(true);
    markFinishSaved();
    startUnlockPoll();
    checkResultUnlock();
  } else {
    S.finished = false;
    toast("لم تُسجَّل النسخة بعد. لا تغلق الصفحة؛ أعد المحاولة.", true);
    setResultSaveNote(false);
    try { autosave(); } catch (e) { /* ignore */ }
  }
  S.persisting = false;
}

function setResultSaveNote(ok) {
  const hosts = [$("#res-save"), $("#finish-save")].filter(Boolean);
  hosts.forEach(el => {
    if (ok) { el.hidden = true; el.innerHTML = ""; return; }
    el.hidden = false;
    el.className = "callout callout-warn";
    el.innerHTML = "<b>تنبيه:</b> لم تُسجَّل نسختك لدى المشرف بعد. تحقّق من الاتصال ثم " +
      "<button type=\"button\" class=\"btn btn-sm js-retry-save\">أعد المحاولة</button>";
  });
  $$(".js-retry-save").forEach(b => b.addEventListener("click", () => {
    S.finished = false;
    finishExam();
  }));
}

/* ------------------------------------------------ انتظار إنهاء الجلسة */
function stopUnlockPoll() {
  if (S.unlockPoll) { clearInterval(S.unlockPoll); S.unlockPoll = null; }
}
function stopFinishClock() {
  if (S.finishClock) { clearInterval(S.finishClock); S.finishClock = null; }
}
function updateFinishElapsed() {
  const el = $("#finish-elapsed");
  if (!el || !S.finishSince) return;
  el.textContent = fmtClock(Math.max(0, Math.floor((Date.now() - S.finishSince) / 1000)));
}
function markFinishSaved() {
  const title = $("#finish-title");
  const msg = $("#finish-msg");
  const status = $("#finish-status-text");
  if (title) title.textContent = "تمّ حفظ نسختك بنجاح";
  if (msg) msg.textContent = "ستظهر النتيجة والتصحيح بعد أن يضغط المشرف على «إنهاء الاختبار».";
  if (status) status.textContent = "في انتظار إنهاء الجلسة من المشرف…";
}
function showFinishWaiting(rec, opts) {
  const row = rec || S.finishedRec || S.submission || {};
  S.finishedRec = row;
  const name = `${row.candidate_first || (S.candidate && S.candidate.first) || ""} ${row.candidate_last || (S.candidate && S.candidate.last) || ""}`.trim();
  const nameEl = $("#finish-name");
  if (nameEl) nameEl.textContent = name || "—";
  const sessionEl = $("#finish-session");
  if (sessionEl) sessionEl.textContent = (S.launch && S.launch.label) || "—";
  const atEl = $("#finish-at");
  if (atEl) atEl.textContent = row.finished_at ? fmtDate(row.finished_at) : "—";
  const since = row.finished_at ? new Date(row.finished_at).getTime() : 0;
  if (since && !isNaN(since)) S.finishSince = since;
  else if (!S.finishSince) S.finishSince = Date.now();
  const title = $("#finish-title");
  const msg = $("#finish-msg");
  const status = $("#finish-status-text");
  if (opts && opts.saving) {
    if (title) title.textContent = "جارٍ حفظ نسختك…";
    if (msg) msg.textContent = "لا تغلق الصفحة حتى يكتمل الحفظ.";
    if (status) status.textContent = "جارٍ إرسال النسخة إلى المشرف…";
  } else if (S.finishedSaved) {
    markFinishSaved();
  }
  setMainView("#view-finished");
  updateFinishElapsed();
  stopFinishClock();
  S.finishClock = setInterval(updateFinishElapsed, 1000);
  startUnlockPoll();
}

function startUnlockPoll() {
  stopUnlockPoll();
  checkResultUnlock();
  S.unlockPoll = setInterval(checkResultUnlock, 3500);
}

async function checkResultUnlock() {
  if (S.resultUnlocked || !S.finishedSaved || !S.finishedRec) return false;
  let launch = null;
  try { launch = await Store.getLaunch(); }
  catch (e) {
    const status = $("#finish-status-text");
    if (status) status.textContent = "تعذّر التحقق من حالة الجلسة — تُعاد المحاولة تلقائيًا…";
    return false;
  }
  const ended = !launch || !S.launch || launch.id !== S.launch.id || launch.status === "closed";
  if (!ended) return false;
  await revealResult();
  return true;
}

async function revealResult() {
  if (S.resultUnlocked) return;
  S.resultUnlocked = true;
  stopUnlockPoll();
  stopFinishClock();
  let row = S.finishedRec;
  const id = row && (row.id || S.waitingId);
  if (id) {
    try {
      const fresh = await Store.getSubmission(id);
      if (fresh && fresh.finished_at) row = fresh;
    } catch (e) { /* نعرض النسخة المحلية */ }
  }
  if (!row) return;
  S.finishedRec = row;
  showResultFromRow(row);
}

/* ------------------------------------------------------------------ résultat */
function canRevealResult(row) {
  if (S.resultUnlocked) return true;
  if (!S.launch) return true;
  if (S.launch.status === "closed") return true;
  if (row && row.session_id && row.session_id !== S.launch.id) return true;
  return false;
}

function showResult(rec, graded) {
  if (!canRevealResult(rec)) {
    S.finishedRec = rec;
    S.finishedGraded = graded;
    showFinishWaiting(rec);
    return;
  }
  $("#view-intro").hidden = true;
  $("#view-exam").hidden = true;
  const waitView = $("#view-wait");
  if (waitView) waitView.hidden = true;
  const finishView = $("#view-finished");
  if (finishView) finishView.hidden = true;
  const view = $("#view-result");
  view.hidden = false;

  const maxTotal = Number(graded.maxPoints || (S.form ? formTotal(S.form) : 100) || 100);
  const maxMcq = Number(graded.mcqMax != null ? graded.mcqMax : (S.form ? S.form.questions.filter(q => q.type === "mcq").reduce((a, q) => a + Number(q.points || 0), 0) : 0));
  const maxOpen = Number(graded.openMax != null ? graded.openMax : (S.form ? S.form.questions.filter(q => q.type === "open").reduce((a, q) => a + Number(q.points || 0), 0) : 0));
  const isOfficial = !!(rec && rec.official);
  const pct = isOfficial ? Math.max(0, Math.min(100, graded.percent)) : 0;
  const pm = Number(S.settings.passMark || 50);
  const pending = $("#res-pending");
  if (pending) pending.hidden = isOfficial;
  $("#dial").style.setProperty("--pct", pct);
  $("#dial").style.setProperty("--dial",
    pct >= 70 ? "var(--green-500)" : pct >= pm ? "var(--gold)" : "var(--danger)");
  $("#res-score").textContent = isOfficial
    ? String(Math.round(graded.total * 10) / 10).replace(/\.0$/, "")
    : "—";
  const totalMaxEl = $("#res-total-max");
  if (totalMaxEl) totalMaxEl.textContent = "/" + maxTotal;
  $("#res-name").textContent = `${rec.candidate_first} ${rec.candidate_last}`;
  const formLabel = (S.bank.forms && S.bank.forms[rec.form] && S.bank.forms[rec.form].label) || rec.form || "—";
  const placeTxt = placeLabel(rec.place_code, rec.place_name);
  $("#res-meta").textContent =
    `${S.bank.meta.title} — ${formLabel}${placeTxt !== "—" ? " · " + placeTxt : ""} · ${fmtDate(rec.finished_at)} · المدة ${fmtDuration(rec.duration_sec)}`;
  $("#res-mcq").textContent = isOfficial ? String(graded.mcq) : "—";
  $("#res-open").textContent = isOfficial ? String(graded.open) : "—";
  const mcqLabel = $("#res-mcq-label");
  if (mcqLabel) mcqLabel.textContent = `الاختيارات / ${maxMcq}`;
  const openLabel = $("#res-open-label");
  if (openLabel) openLabel.textContent = `التعبير / ${maxOpen}`;
  $("#res-pct").innerHTML = isOfficial ? `${Math.round(graded.percent)}<small>%</small>` : "—";
  $("#res-eyebrow").textContent = !isOfficial
    ? "النتيجة قيد التصحيح"
    : (pct >= pm ? "نتيجة الاختبار" : "نتيجة الاختبار — دون المعدّل");

  const resSave = $("#res-save");
  if (resSave) { resSave.hidden = true; resSave.innerHTML = ""; }

  const openDetails = (graded.details || []).filter(d => d.type === "open");
  const wroteOpen = openDetails.some(d => String(d.openText || "").trim().length > 0);

  const note = $("#res-note");
  if (!isOfficial) {
    note.innerHTML =
      `<b>ملاحظة:</b> نسخةُك محفوظة لدى المشرف، والنقطة الرسمية تُنشر بعد تصحيحها. ` +
      `لا يمكن لا لأحد — بما في ذلك متصفّحك — أن يكتب نقطة في نسختك قبل ذلك.`;
  } else if (S.submission && S.submission.status === "validated") {
    note.innerHTML =
      `<b>ملاحظة:</b> ثبّت المشرف نقطة التعبير (${graded.open}/${maxOpen}) بعد مراجعتها. ` +
      `يمكنك الآن تحميل هذه الصفحة بصيغة PDF (من زر «استخراج النتيجة PDF» ثم اختيار «حفظ كـ PDF»).`;
  } else if (wroteOpen) {
    note.innerHTML =
      `<b>ملاحظة:</b> نقطة التعبير (${graded.open}/${maxOpen}) نقطة <b>احتياطية آلية</b> تُحسب من مطابقة عناصر الإجابة النموذجية؛ ` +
      `يراجعها المشرف ويُثبّت النقطة النهائية. النقطتان أعلاه محفوظتان لدى المشرف مع نسخة من أجوبتك.`;
  } else {
    note.innerHTML = `<b>ملاحظة:</b> لم تُحرّر أجوبة التعبير، لذلك لم تُحتسب نقطتها.`;
  }

  renderReview(graded, pct);
  view.scrollIntoView({ behavior: "smooth", block: "start" });
}

function renderReview(graded, pct) {
  const box = $("#review");
  const letters = ["أ", "ب", "ج", "د", "هـ", "و"];
  box.innerHTML = "";

  /* bandeau imprimable */
  const reviewMax = Number(
    graded.maxPoints ||
    (S.form && Array.isArray(S.form.questions)
      ? S.form.questions.reduce((a, q) => a + Number(q.points || 0), 0)
      : 0) || 100
  );
  const head = document.createElement("div");
  head.className = "paper-meta";
  head.style.marginBottom = "18px";
  const off = !!(S.submission && S.submission.official);
  head.innerHTML =
    `<span><b>${esc(S.candidate.first + " " + S.candidate.last)}</b></span>` +
    `<span>${esc((S.bank.forms && S.bank.forms[S.submission.form] && S.bank.forms[S.submission.form].label) || S.submission.form)}</span>` +
    `<span>${esc(placeLabel(S.submission.place_code, S.submission.place_name))}</span>` +
    `<span>${esc(fmtDate(S.submission.finished_at))}</span>` +
    `<span>النقطة: <b>${off ? Math.round(graded.total * 10) / 10 + "/" + reviewMax : "—"}</b></span>`;
  box.appendChild(head);

  S.form.questions.forEach((q, i) => {
    const d = graded.details.find(x => x.qid === q.id);
    if (!d) return;
    const el = document.createElement("div");
    el.className = "review-item " + (d.type === "mcq" ? (d.ok ? "ok" : "ko") : "pend");

    let body = "";
    if (q.type === "mcq") {
      const givenIdx = q.options.findIndex(o => o.id === d.given);
      const correctIdx = q.options.findIndex(o => o.id === q.correct);
      body += d.given
        ? `<div class="answer-line ${d.ok ? "correct" : "wrong"}">
             <b>جوابك:</b> ${givenIdx >= 0 ? letters[givenIdx] + " — " : ""}${esc(d.givenText)}
           </div>`
        : `<div class="answer-line given"><b>جوابك:</b> لم تُجب عن هذا السؤال.</div>`;
      if (!d.ok) {
        body += `<div class="answer-line correct">
                   <b>الجواب الصحيح:</b> ${correctIdx >= 0 ? letters[correctIdx] + " — " : ""}${esc(d.correctText)}
                 </div>`;
      }
      body += `<div class="quote-block" style="margin-top:8px"><b>التوضيح:</b> ${esc(q.explain || "")}</div>`;
    } else {
      body += `<div class="answer-line given" style="white-space:pre-wrap">${
        d.openText ? esc(d.openText) : "<i>لم تُجب عن هذا السؤال.</i>"
      }</div>`;
      body += `<div class="quote-block" style="margin-top:8px"><b>عناصر الإجابة النموذجية:</b> ${esc(q.modelAnswer || "")}</div>`;
      const rub = (d.rubric || []).map(r => {
        const src = (q.rubric || []).find(x => x.id === r.id) || {};
        return `<li>${esc(src.label || r.id)} — ${Number(r.earned) || 0}/${Number(r.points) || 0}</li>`;
      }).join("");
      if (rub) body += `<ul class="small muted" style="margin:8px 0 0;padding-inline-start:20px">${rub}</ul>`;
    }

    el.innerHTML =
      `<div class="head">
         <div>
           <div class="small muted">السؤال ${i + 1} — ${esc(q.topic)}</div>
           <div class="qt">${esc(q.text)}</div>
         </div>
         <span class="score-pill ${scoreClass((d.earned / q.points) * 100)}">${d.earned}/${q.points}</span>
       </div>${body}`;
    box.appendChild(el);
  });

  const foot = document.createElement("p");
  foot.className = "small muted";
  foot.style.marginTop = "18px";
  foot.textContent =
    "هذه النسخة صادرة آليًّا عن نظام الاختبار، وتُعدّ وثيقة عمل إلى حين تثبيت نقطة التعبير من طرف المشرف.";
  box.appendChild(foot);
}

/* --------------------------------------------------------------------- PDF */
function exportPdf() {
  const oldTitle = document.title;
  const name = (S.candidate.first + " " + S.candidate.last).trim();
  document.title = `نتيجة-${name || "مترشح"}-المنهاج-النبوي`;
  window.print();
  setTimeout(() => { document.title = oldTitle; }, 800);
}

/* ---------------------------------------------------- الجلسة وقاعة الانتظار */
const DONE_KEY = id => "manhaj_done_" + id;

function markDeviceFinished(sessionId) {
  try {
    if (sessionId) localStorage.setItem(DONE_KEY(sessionId), JSON.stringify({ at: Date.now() }));
    localStorage.removeItem(KEYS.wait);
  } catch (e) { /* ignore */ }
}

function localMirrorRows() {
  try {
    const rows = JSON.parse(localStorage.getItem("manhaj_submissions_v1") || "[]") || [];
    /* إصلاح سجلات قديمة خُزنت النسبة فيها ككسر */
    return rows.map(r => {
      if (r && Number(r.percent) <= 1 && Number(r.final_score) > 1) {
        return { ...r, percent: Number(r.final_score) };
      }
      return r;
    });
  } catch (e) { return []; }
}

function rememberLocalRow(row) {
  if (!row || !row.id) return;
  try {
    const all = JSON.parse(localStorage.getItem("manhaj_submissions_v1") || "[]") || [];
    const i = all.findIndex(r => r && r.id === row.id);
    if (i >= 0) all[i] = { ...all[i], ...row };
    else all.push(row);
    localStorage.setItem("manhaj_submissions_v1", JSON.stringify(all));
  } catch (e) { /* ignore */ }
}

function findFinishedForSession(sessionId) {
  const mine = deviceId();
  return localMirrorRows().find(r =>
    r && r.session_id === sessionId && r.device_id === mine &&
    (r.status !== "waiting" || r.finished_at)
  ) || null;
}

function latestLocalFinished() {
  const mine = deviceId();
  return localMirrorRows()
    .filter(r => r && r.device_id === mine && r.finished_at &&
                 r.status !== "waiting" && r.status !== "removed")
    .sort((a, b) => new Date(b.finished_at || 0) - new Date(a.finished_at || 0))[0] || null;
}

/* البحث عن نسخة المترشح في السحابة (تعمل بعد إعادة فتح الصفحة أو تبديل الهاتف) */
async function findMyResultCloud(sessionId) {
  if (!sessionId) return null;
  const dev = deviceId();
  try {
    const rows = await Store.listSummaries();
    const own = rows
      .filter(r => r && r.session_id === sessionId && r.finished_at &&
                   r.status !== "waiting" && r.status !== "removed")
      .sort((a, b) => new Date(b.finished_at || 0) - new Date(a.finished_at || 0));
    let found = own.find(r => r.device_id === dev);
    if (!found && S.candidate && (S.candidate.first || S.candidate.last)) {
      found = own.find(r => sameName(r.candidate_first, r.candidate_last,
        S.candidate.first, S.candidate.last));
    }
    if (!found) return null;
    const full = await Store.getSubmission(found.id);
    if (full) { rememberLocalRow(full); return full; }
    return found;
  } catch (e) {
    return null;
  }
}

function findWaitingForSession(sessionId) {
  const mine = deviceId();
  return localMirrorRows().find(r =>
    r && r.session_id === sessionId && r.device_id === mine &&
    r.status === "waiting" && !r.started_at && r.status !== "removed"
  ) || null;
}

const normFull = (first, last) =>
  normalizeAr(`${first || ""} ${last || ""}`).toLowerCase().replace(/\s+/g, "");

function sameName(a, b, c, d) {
  const k1 = normFull(a, b);
  const k2 = normFull(c, d);
  return k1 && (k1 === k2 || k1 === normFull(d, c));
}

/* يمنع الترشح المكرر في نفس الجلسة: نفس الجهاز (محليًا) أو نفس الاسم (طاولات/محليًا)
   أما نفس «رمز المترشح» فهو نفس الشخص: استئناف من جهاز آخر لا ترشح مكرّر. */
async function findDuplicate(sessionId, candidate) {
  const device = deviceId();
  const myHash = (candidate && candidate.codeHash) || S.codeHash || "";

  const mine = localMirrorRows().find(r => r && r.session_id === sessionId && r.device_id === device && r.status !== "removed");
  if (mine) return mine.status === "waiting" ? { kind: "device-waiting", row: mine } : { kind: "device", row: mine };

  try {
    if (localStorage.getItem(DONE_KEY(sessionId))) {
      return { kind: "device", row: null };
    }
  } catch (e) { /* ignore */ }

  try {
    const rows = await Store.listSummaries();
    /* نفس الرمز = نفس المترشح: نستأنف ولا نرفض */
    if (myHash) {
      const byCode = rows.find(r =>
        r && r.session_id === sessionId && r.code_hash === myHash && r.status !== "removed");
      if (byCode) return byCode.status === "waiting" ? { kind: "code-waiting", row: byCode } : { kind: "code", row: byCode };
    }
    const dup = rows.find(r =>
      r && r.session_id === sessionId && r.status !== "removed" &&
      (r.device_id === device ||
       sameName(r.candidate_first, r.candidate_last, candidate.first, candidate.last)));
    if (dup) return dup.status === "waiting" ? { kind: "name-waiting", row: dup } : { kind: "name", row: dup };
  } catch (e) {
    return { kind: "error", row: null };
  }
  return null;
}

function setMainView(name) {
  ["#view-intro", "#view-wait", "#view-exam", "#view-finished", "#view-result", "#view-error"].forEach(s => {
    const el = $(s);
    if (el) el.hidden = (s !== name);
  });
}

function updateWaitElapsed() {
  const el = $("#wait-elapsed");
  if (!el || !S.waitSince) return;
  el.textContent = fmtClock(Math.floor((Date.now() - S.waitSince) / 1000));
}

function stopWaitPoll() { if (S.waitPoll) { clearInterval(S.waitPoll); S.waitPoll = null; } }
function stopWaitClock() { if (S.waitClock) { clearInterval(S.waitClock); S.waitClock = null; } }
function stopSessionPoll() { if (S.sessionPoll) { clearInterval(S.sessionPoll); S.sessionPoll = null; } }

async function checkSessionEnded() {
  if (!S.examStarted || S.finished || S.persisting) return false;
  let l = null;
  try { l = await Store.getLaunch(); } catch (e) { return false; }
  const ended = !l || !S.launch || l.id !== S.launch.id || l.status === "closed";
  if (!ended) return false;
  stopSessionPoll();
  toast("انتهت الجلسة — يتم حفظ نسختك نهائيًا", true);
  await finishExam();
  return true;
}

function startSessionPoll() {
  stopSessionPoll();
  S.sessionPoll = setInterval(checkSessionEnded, 5000);
}

function startWaitPoll() {
  stopWaitPoll();
  stopWaitClock();
  S.waitSince = Date.now();
  S.waitClock = setInterval(updateWaitElapsed, 1000);
  updateWaitElapsed();
  refreshWaitingCount(true);
  S.waitPoll = setInterval(checkLaunch, 2500);
}

let lastCountCheck = 0;
async function refreshWaitingCount(force) {
  const now = Date.now();
  if (!force && now - lastCountCheck < 8000) return;
  lastCountCheck = now;
  const el = $("#wait-count");
  try {
    const rows = await Store.listSummaries();
    const n = rows.filter(r => r.status === "waiting" && !r.finished_at && r.session_id === (S.launch && S.launch.id)).length;
    if (el) el.textContent = String(n);
  } catch (e) {
    if (el) el.textContent = "—";
  }
}

function showWaiting(candidate, launch, waitingRow) {
  S.candidate = candidate;
  S.launch = launch;
  S.waitingId = waitingRow ? waitingRow.id : S.waitingId;
  try {
    localStorage.setItem(KEYS.wait, JSON.stringify({
      sessionId: launch.id, waitingId: S.waitingId,
      first: candidate.first, last: candidate.last,
      placeCode: candidate.placeCode || "", placeName: candidate.placeName || ""
    }));
  } catch (e) { /* ignore */ }
  $("#wait-name").textContent = `${candidate.first} ${candidate.last}`;
  const waitPlace = $("#wait-place");
  if (waitPlace) waitPlace.textContent = placeLabel(candidate.placeCode, candidate.placeName);
  $("#wait-session").textContent = launch.label || "—";
  $("#wait-status-text").textContent = "في انتظار إطلاق الاختبار من المشرف…";
  $("#btn-leave-wait").textContent = "انسحاب من قائمة الانتظار";
  setMainView("#view-wait");
  startWaitPoll();
}

let checkingLaunchFlag = false;
async function checkLaunch() {
  if (checkingLaunchFlag || S.examStarted) return;
  checkingLaunchFlag = true;
  try {
    let launch = null;
    try { launch = await Store.getLaunch(); } catch (e) { return; }

    if (!launch) { await closeWaitingRoom("أُلغيت جلسة الانتظار. تواصل مع المشرف."); return; }

    if (!S.launch || launch.id !== S.launch.id) {
      const oldId = S.waitingId;
      if (oldId && !S.examStarted) { try { await Store.deleteSubmission(oldId); } catch (e) { /* ignore */ } }
      S.waitingId = null;
      if (launch.status === "closed") { await closeWaitingRoom("أُغلق باب الترشح. جلسة جديدة يفتحها المشرف قريبًا."); return; }
      const c = { first: S.candidate.first, last: S.candidate.last,
        placeCode: S.candidate.placeCode || "", placeName: S.candidate.placeName || "" };
      let rec;
      try { rec = await joinWaiting(c, launch); }
      catch (e) { await closeWaitingRoom("تعذّر الانتقال إلى الجلسة الجديدة."); return; }
      S.launch = launch;
      toast("انتقلتَ تلقائيًا إلى الجلسة الجديدة");
      if (launch.status === "launched") { stopWaitPoll(); stopWaitClock(); await startExam(c, { waitingId: rec.id, launch }); return; }
      showWaiting(c, launch, rec);
      return;
    }

    if (launch.status === "launched") {
      stopWaitPoll();
      stopWaitClock();
      $("#wait-status-text").textContent = "انطلق الاختبار! يتم تجهيز الأسئلة…";
      toast("انطلق الاختبار — بالتوفيق!");
      await startExam({ first: S.candidate.first, last: S.candidate.last,
        placeCode: S.candidate.placeCode || "", placeName: S.candidate.placeName || "" },
        { waitingId: S.waitingId, launch });
      return;
    }

    if (launch.status === "closed") {
      await closeWaitingRoom("أُغلق باب الترشح لهذه الجلسة قبل انطلاقها. تواصل مع المشرف.");
      return;
    }

    const labelEl = $("#wait-session");
    if (labelEl) labelEl.textContent = launch.label || "—";

    refreshWaitingCount(false);
  } finally {
    checkingLaunchFlag = false;
  }
}

async function closeWaitingRoom(message) {
  if (S.examStarted) return;
  stopWaitPoll();
  stopWaitClock();
  if (S.waitingId) {
    try {
      const rows = await Store.listSubmissions();
      const r = rows.find(x => x.id === S.waitingId);
      if (r && r.status === "waiting" && !r.started_at) {
        await Store.deleteSubmission(S.waitingId);
      }
    } catch (e) { /* ignore */ }
  }
  S.waitingId = null;
  try { localStorage.removeItem(KEYS.wait); } catch (e) { /* ignore */ }
  const t = $("#wait-status-text");
  if (t) t.textContent = message;
  const c = $("#wait-count");
  if (c) c.textContent = "—";
  const b = $("#btn-leave-wait");
  if (b) b.textContent = "عودة إلى الصفحة الرئيسية";
}

async function leaveWaiting() {
  if (S.examStarted) return;
  stopWaitPoll();
  stopWaitClock();
  if (S.waitingId) {
    try {
      const rows = await Store.listSubmissions();
      const r = rows.find(x => x.id === S.waitingId);
      if (r && r.status === "waiting" && !r.started_at) await Store.deleteSubmission(S.waitingId);
    } catch (e) { /* ignore */ }
    S.waitingId = null;
  }
  try { localStorage.removeItem(KEYS.wait); } catch (e) { /* ignore */ }
  setMainView("#view-intro");
  const f = $("#f-first");
  if (f) f.focus();
  toast("عدتَ إلى الصفحة الرئيسية");
}

async function joinWaiting(c, launch) {
  const base = {
    candidate_first: c.first,
    candidate_last: c.last,
    place_code: c.placeCode || "",
    place_name: c.placeName || "",
    form: "—",
    session_id: launch.id,
    device_id: deviceId(),
    started_at: null,
    finished_at: null,
    duration_sec: 0,
    code_hash: c.codeHash || S.codeHash || "",
    /* النقاط لا تُرسَل من طرف المترشح (قواعد Firebase تمنع ذلك). */
    status: "waiting",
    joined_at: new Date().toISOString(),
    answers: JSON.stringify({ sessionId: launch.id, status: "waiting" })
  };
  const rec = await Store.addSubmission(base);
  if (!rec || !rec.id) throw new Error("تعذّر تسجيل الانتظار");
  return rec;
}

function showRepeatBox(row, keepForm, byCode) {
  S.previousRow = row;
  const form = $("#start-form");
  const hint = $("#start-hint");
  const box = $("#repeat-box");
  if (!keepForm) {
    if (form) form.hidden = true;
    if (hint) hint.hidden = true;
  }
  if (!box) return;
  const official = !!row.official;
  const pct = Math.round(Number(row.percent || row.final_score || 0) * 10) / 10;
  const st = row.status === "validated" ? "ثبّت المشرف نقطة التعبير" : "بانتظار تثبيت المشرف لنقطة التعبير";
  const placeTxt = placeLabel(row.place_code, row.place_name);
  const when = S.launch ? "في هذه الجلسة" : "في آخر جلسة";
  const currentOpen = S.launch && row.session_id === S.launch.id && S.launch.status !== "closed";
  const head = box.querySelector("p b");
  if (head) head.textContent = byCode
    ? `لقد أديت الاختبار بهذا الرمز ${when}.`
    : `لقد أديت الاختبار من هذا الجهاز ${when}.`;
  let totalMax = 100;
  try {
    const d = typeof row.answers === "object" && row.answers ? row.answers : JSON.parse(row.answers || "{}");
    const snap = Array.isArray(d.snapshot) ? d.snapshot : [];
    const m = snap.reduce((a, q) => a + Number(q.points || 0), 0);
    if (m > 0) totalMax = m;
  } catch (e) { /* garder 100 */ }
  if (currentOpen) {
    $("#repeat-meta").textContent =
      `${placeTxt !== "—" ? "المكان: " + placeTxt + " · " : ""}تمّ إنهاء نسختك · النتيجة تظهر بعد إنهاء المشرف للجلسة.`;
  } else if (!official) {
    $("#repeat-meta").textContent =
      `${placeTxt !== "—" ? "المكان: " + placeTxt + " · " : ""}النتيجة الرسمية ينشرها المشرف بعد تصحيح النسخة.`;
  } else {
    $("#repeat-meta").textContent =
      `${placeTxt !== "—" ? "المكان: " + placeTxt + " · " : ""}النقطة: ${Math.round(Number(row.final_score || 0) * 10) / 10}/${totalMax} (${pct}%) · ${st} · ${fmtDate(row.finished_at)}`;
  }
  const showBtn = $("#btn-show-previous");
  if (showBtn) showBtn.textContent = currentOpen ? "متابعة حالة الجلسة" : "عرض نتيجتي وتصحيحها";
  box.hidden = false;
}

/* يعيد بناء عرض النتيجة من النسخة المحفوظة على الجهاز */
function showPreviousResult(row) {
  if (!row) return;
  const currentOpen = S.launch && row.session_id === S.launch.id && S.launch.status !== "closed";
  if (currentOpen) {
    S.finished = true;
    S.finishedSaved = true;
    S.finishedRec = row;
    S.finishSince = row.finished_at ? new Date(row.finished_at).getTime() : Date.now();
    showFinishWaiting(row);
    return;
  }
  showResultFromRow(row);
}

function showResultFromRow(row) {
  let data = {};
  if (typeof row.answers === "object" && row.answers) data = row.answers;
  else { try { data = JSON.parse(row.answers || "{}") || {}; } catch (e) { data = {}; } }
  const snap = Array.isArray(data.snapshot) ? data.snapshot : [];
  let details = Array.isArray(data.details) && data.details.length
    ? data.details
    : snap.map(s => s.type === "mcq"
        ? { qid: s.qid, type: "mcq", given: s.given || null, correct: s.correct, earned: (s.given && s.given === s.correct) ? Number(s.points || 0) : 0,
            givenText: (s.options || []).find(o => o.id === s.given)?.text || "", correctText: (s.options || []).find(o => o.id === s.correct)?.text || "" }
        : { qid: s.qid, type: "open", openText: s.openText || "", earned: 0, rubric: [] });

  const questions = snap.map(s => s.type === "mcq"
    ? { id: s.qid, type: "mcq", topic: s.topic, points: s.points, text: s.text,
        options: s.options || [], correct: s.correct, explain: s.explain || "" }
    : { id: s.qid, type: "open", topic: s.topic, points: s.points, text: s.text,
        modelAnswer: s.modelAnswer || "", rubric: s.rubric || [] });

  const computedMcq = snap.filter(s => s.type === "mcq")
    .reduce((sum, s) => sum + (s.given && s.given === s.correct ? Number(s.points || 0) : 0), 0);
  /* النقطة المعروضة هي النقطة الرسمية المنشورة من طرف المشرف فقط.
     ما لم تُنشر، لا تُعرض أي نقطة (ولا تُحسب محليًا). */
  const official = !!row.official;
  const mcq = official ? (row.mcq_score != null ? Number(row.mcq_score) : computedMcq) : 0;
  const open = official ? (row.open_score != null ? Number(row.open_score) : 0) : 0;
  const total = official ? (row.final_score != null ? Number(row.final_score) : (mcq + open)) : 0;
  const maxTotal = questions.reduce((a, q) => a + Number(q.points || 0), 0) || 1;
  const percent = official
    ? (row.percent != null ? Number(row.percent) : Math.round((total / maxTotal) * 1000) / 10)
    : 0;

  const graded = {
    details, mcq, open, total, percent,
    maxPoints: maxTotal,
    mcqMax: questions.filter(q => q.type === "mcq").reduce((a, q) => a + Number(q.points || 0), 0),
    openMax: questions.filter(q => q.type === "open").reduce((a, q) => a + Number(q.points || 0), 0)
  };

  S.submission = row;
  S.candidate = {
    first: row.candidate_first || "", last: row.candidate_last || "",
    placeCode: row.place_code || "", placeName: row.place_name || ""
  };
  S.formKey = row.form || data.form || "A";
  S.form = { questions };
  S.finished = true;

  setMainView("#view-result");
  showResult(row, graded);
}

/* ------------------------------------------------------------------- démarrage */
function showError(msg) {
  $("#view-intro").hidden = true;
  $("#view-exam").hidden = true;
  const finishView = $("#view-finished");
  if (finishView) finishView.hidden = true;
  $("#view-result").hidden = true;
  $("#view-error").hidden = false;
  $("#err-msg").textContent = msg;
}

function validateForm() {
  const last = $("#f-last").value.trim();
  const first = $("#f-first").value.trim();
  const err = $("#form-err");
  if (last.length < 2 || first.length < 2) {
    err.textContent = "يجب إدخال الاسم العائلي والاسم الشخصي (حرفان على الأقل لكلٍّ منهما).";
    return null;
  }
  const sel = $("#f-place");
  const place = sel ? PLACE_LIST.find(p => p.code === sel.value) : null;
  if (!place) {
    err.textContent = "يجب اختيار المكان (المحطة) من القائمة.";
    return null;
  }
  const codeEl = $("#f-code");
  const code = window.App.normalizeAccessCode(codeEl ? codeEl.value : "");
  const needCode = !!(window.MANHAJ_CONFIG && window.MANHAJ_CONFIG.requireAccessCode) &&
    Store.getMode() === "cloud";
  if (needCode && code.length < 6) {
    err.textContent = "أدخل رمز المترشح الذي يوزّعه عليك المشرف (6 أحرف أو أرقام على الأقل).";
    return null;
  }
  err.textContent = "";
  return { last, first, placeCode: place.code, placeName: place.name, code, codeHash: "" };
}

/* رسائل أخطاء حساب المترشح (Firebase) */
function candidateAuthMessage(e) {
  const code = String((e && (e.code || e.message)) || "");
  if (code === "BAD_ACCESS_CODE") return "رمز المترشح غير صالح: 6 أحرف أو أرقام على الأقل.";
  if (code.indexOf("INVALID_LOGIN_CREDENTIALS") !== -1 ||
      code.indexOf("EMAIL_EXISTS") !== -1 ||
      code.indexOf("EMAIL_NOT_FOUND") !== -1 ||
      code.indexOf("INVALID_PASSWORD") !== -1) return "تعذّر التحقق من رمز المترشح. تأكّد من الرمز الذي وزّعه عليك المشرف.";
  if (code.indexOf("WEAK_PASSWORD") !== -1) return "الرمز قصير جدًا: 6 أحرف أو أرقام على الأقل.";
  if (code.indexOf("TOO_MANY_ATTEMPTS") !== -1) return "محاولات كثيرة. انتظر قليلًا ثم أعد المحاولة.";
  if (code.indexOf("NETWORK") !== -1) return "تعذّر الاتصال بالإنترنت. تحقّق من الشبكة ثم أعد المحاولة.";
  return "تعذّر التحقق من رمز المترشح. تحقّق من الاتصال ثم أعد المحاولة.";
}

function fillPlaceOptions() {
  const sel = $("#f-place");
  if (!sel) return;
  sel.innerHTML = `<option value="">اختر المكان…</option>` + PLACE_LIST
    .map(p => `<option value="${esc(p.code)}">${esc(p.code)} — ${esc(p.name)}</option>`)
    .join("");
}

let startingPromise = null;
async function startExam(candidate, opts) {
  if (startingPromise) return startingPromise;
  opts = opts || {};
  startingPromise = (async () => {
    /* نعيد قراءة الإعدادات وبنك الأسئلة لحظة البدء */
    try {
      const [settings, bank] = await Promise.all([Store.getSettings(), Store.getBank()]);
      if (settings) S.settings = settings;
      if (bank) S.bank = bank;
    } catch (e) { /* garder le cache local */ }

    S.launch = opts.launch || S.launch || null;
    S.waitingId = opts.waitingId != null ? opts.waitingId : S.waitingId;

    let paper;
    try {
      paper = buildPaper(S.bank, S.settings);
    } catch (e) {
      const msg = e && e.message ? e.message : "تعذّر تجهيز الأسئلة.";
      const err = $("#form-err");
      if (err) err.textContent = msg;
      toast(msg, true);
      return;
    }
    if (!paper || !paper.form || !Array.isArray(paper.form.questions) || !paper.form.questions.length) {
      const msg = "لا توجد أسئلة في هذا النموذج.";
      const err = $("#form-err");
      if (err) err.textContent = msg;
      toast(msg, true);
      return;
    }

    S.formKey = paper.formKey;
    S.form = paper.form;
    S.questions = paper.form.questions;
    S.answers = {};
    S.idx = 0;
    S.startedAt = new Date().toISOString();
    S.candidate = candidate;
    S.finished = false;
    S.persisting = false;
    S.examStarted = true;
    S.resultUnlocked = false;
    S.finishedSaved = false;
    S.finishedRec = null;
    S.finishedGraded = null;
    stopUnlockPoll();
    stopFinishClock();

    stopWaitPoll();
    stopWaitClock();

    setMainView("#view-exam");
    setSaveState(navigator.onLine === false ? "offline" : "idle");
    $("#ex-name").textContent = `${candidate.first} ${candidate.last}`;
    const placeTxt = placeLabel(candidate.placeCode, candidate.placeName);
    $("#ex-form").textContent =
      `${(S.bank.forms[S.formKey] && S.bank.forms[S.formKey].label) || S.formKey} · ${S.questions.length} أسئلة · ${formTotal(S.form)} نقطة` +
      (placeTxt !== "—" ? ` · ${placeTxt}` : "");

    /* تمييز سجل الانتظار بأن المترشح بدأ فعليًا */
    if (S.waitingId) {
      try {
        await Store.updateSubmission(S.waitingId, {
          started_at: S.startedAt,
          exam_started_at: S.startedAt,
          form: S.formKey,
          status: "waiting"
        });
      } catch (e) {
        console.warn("تعذّر تعليم بداية الاختبار", e);
      }
    }

    renderQuestion();
    window.scrollTo({ top: 0 });

    startProgressTimer();
    startSessionPoll();
  })().finally(() => { startingPromise = null; });
  return startingPromise;
}

async function handleJoin(c) {
  const err = $("#form-err");
  const btn = $("#btn-start");
  err.textContent = "";
  btn.disabled = true;
  try {
    let launch = null;
    for (let i = 0; i < 4 && !launch; i++) {
      try { launch = await Store.getLaunch(); } catch (e) { launch = null; }
      if (!launch && i < 3) await new Promise(r => setTimeout(r, 1200));
    }
    S.launch = launch;
    if (!launch) {
      if (Store.getMode() !== "cloud") {
        err.textContent = "المزامنة غير مفعّلة. أعد تحميل الصفحة (Ctrl+F5) أو افتحها في نافذة خاصة.";
      } else {
        err.textContent = "لم تُنشئ المشرف جلسة اختبار بعد، أو تعذّر الوصول إلى الخادم. انتظر قليلًا ثم حاول مجدًا.";
      }
      return;
    }

    const dup = await findDuplicate(launch.id, c);
    if (dup) {
      const mine = dup.row && dup.row.device_id === deviceId();
      const sameCode = dup.kind === "code" || dup.kind === "code-waiting";
      if (dup.kind === "error") {
        err.textContent = "تعذّر التحقق من التكرار. تحقّق من الاتصال ثم حاول مجدًا.";
        return;
      }
      if (dup.kind.endsWith("waiting")) {
        if (mine || sameCode) {
          clearProgress();
          // إعادة قراءة launch قبل البدء
          const fresh = await Store.getLaunch();
          if (!fresh || fresh.id !== launch.id || fresh.status === "closed") {
            err.textContent = "تغيرت حالة الجلسة. أعد المحاولة.";
            return;
          }
          S.launch = fresh;
          if (fresh.status === "launched") await startExam(c, { waitingId: dup.row.id, launch: fresh });
          else showWaiting(c, fresh, dup.row);
          return;
        }
        err.textContent = "هذا الاسم مسجّل في قائمة الانتظار على جهاز آخر. تواصل مع المشرف.";
        return;
      }
      if (mine || sameCode) { if (dup.row) showRepeatBox(dup.row, false, sameCode); }
      err.textContent = sameCode
        ? "لقد أديت الاختبار بهذا الرمز في هذه الجلسة."
        : "لا يمكن الترشح أكثر من مرة في الجلسة الواحدة (نفس الجهاز أو نفس الاسم).";
      return;
    }

    const freshLaunch = await Store.getLaunch();
    if (!freshLaunch || freshLaunch.id !== launch.id) {
      err.textContent = "تغيرت حالة الجلسة. أعد المحاولة.";
      return;
    }
    launch = freshLaunch;
    S.launch = launch;

    if (launch.status === "closed") {
      err.textContent = "أُغلق باب الترشح لهذه الجلسة. تواصل مع المشرف.";
      return;
    }
    if (launch.status === "waiting") {
      const rec = await joinWaiting(c, launch);
      showWaiting(c, launch, rec);
      return;
    }
    /* launched: إنشاء سجل began before start */
    const rec = await joinWaiting(c, launch);
    clearProgress();
    await startExam(c, { waitingId: rec.id, launch });
  } catch (e) {
    console.warn(e);
    err.textContent = "تعذّر الاتصال. تحقّق من الشبكة ثم حاول مجدًا.";
  } finally {
    btn.disabled = false;
  }
}

async function boot() {
  let launchNow = null;
  try {
    /* نجلب الإعدادات والبنك وحالة الجلسة معًا لتقليل زمن الإقلاع */
    const [settings, bank, launch] = await Promise.all([
      Store.getSettings(),
      Store.getBank(),
      Store.getLaunch().catch(() => null)
    ]);
    S.settings = settings;
    S.bank = bank;
    launchNow = launch;
  } catch (e) {
    showError("تعذّر تحميل بنك الأسئلة. تحقّق من الاتصال ثمّ أعد تحميل الصفحة.");
    return;
  }

  const total = formTotal(S.bank.forms.A);
  const box = $("#rules-box");
  if (box && total !== 100) {
    box.innerHTML += `<div style="margin-top:8px">⚠ مجموع نقط النموذج الحالي ${total} بدل 100 — يُرجى تصحيح التوزيع من فضاء المشرف.</div>`;
  }

  /* وصف الاختبار مبني على الإعدادات الحالية، ويُحدَّث تلقائيًا كل 15 ثانية */
  renderIntroSpecs();
  let introRefreshing = false;
  setInterval(async () => {
    if ($("#view-intro").hidden || introRefreshing) return;
    introRefreshing = true;
    try {
      const [settings, bank] = await Promise.all([Store.getSettings(), Store.getBank()]);
      if (settings) S.settings = settings;
      if (bank) S.bank = bank;
      renderIntroSpecs();
    } catch (e) { /* garder le cache */ }
    finally { introRefreshing = false; }
  }, 15000);

  fillPlaceOptions();

  /* استعادة رمز المترشح المحفوظ: يُعيد تسجيل الدخول تلقائيًا
     فيبقى المعرّف (uid) واحدًا على كل الأجهزة. */
  try {
    const savedCode = localStorage.getItem(KEYS.code);
    const codeEl = $("#f-code");
    if (savedCode) {
      S.accessCode = savedCode;
      if (codeEl && !codeEl.value) codeEl.value = savedCode;
      if (!Store.isCandidateAuth() && Store.getMode() === "cloud") {
        try { await Store.signInCandidate(savedCode); }
        catch (e) { /* سنطلب الرمز مجددًا عند التسجيل */ }
      }
    }
  } catch (e) { /* ignore */ }

  if (Store.getMode() !== "cloud") {
    const warn = document.createElement("div");
    warn.className = "callout callout-warn";
    warn.style.marginBottom = "14px";
    warn.innerHTML = "<b>تنبيه:</b> المزامنة غير مفعّلة (نسخة قديمة مخزّنة أو تعذّر الاتصال). " +
      "أعد تحميل الصفحة (Ctrl+F5) أو افتحها في نافذة خاصة.";
    const intro = $("#view-intro");
    if (intro) intro.insertBefore(warn, intro.firstChild);
  }

  /* حالة جلسة الإطلاق الحالية (جُلبت مع الإعدادات أعلاه) */
  S.launch = launchNow;
  let prev = null;
  let progressNow = readProgress();
  /* محاولة محفوظة من جلسة سابقة لا تصلح للاستئناف في الجلسة الحالية. */
  if (progressNow && launchNow && (!progressNow.launch || progressNow.launch.id !== launchNow.id)) {
    clearProgress();
    progressNow = null;
  }
  if (launchNow) {
    prev = findFinishedForSession(launchNow.id);
    if (launchNow.status === "closed") {
      const cloudPrev = await findMyResultCloud(launchNow.id);
      if (cloudPrev) prev = cloudPrev;
    }
    if (prev) {
      S.submission = prev;
      S.finishedRec = prev;
      S.finishedSaved = true;
      S.finished = true;
      S.finishSince = prev.finished_at ? new Date(prev.finished_at).getTime() : Date.now();
      clearProgress();
      try { localStorage.removeItem(KEYS.wait); } catch (e) { /* ignore */ }
      if (launchNow.status === "closed") {
        /* الجلسة منتهية: النتيجة متاحة فورًا. */
        showPreviousResult(prev);
      } else {
        /* النسخة محفوظة لكن المشرف لم يُنهِ الجلسة بعد: لا نكشف النتيجة. */
        showFinishWaiting(prev);
      }
    }
    else if (!progressNow) {
      const waiting = findWaitingForSession(launchNow.id);
      if (waiting) {
        showWaiting(
          { first: waiting.candidate_first, last: waiting.candidate_last,
            placeCode: waiting.place_code || "", placeName: waiting.place_name || "" },
          launchNow, waiting);
      } else {
        try {
          const wRaw = localStorage.getItem(KEYS.wait);
          if (wRaw) {
            const w = JSON.parse(wRaw);
            if (w && w.sessionId === launchNow.id) {
              showWaiting(
                { first: w.first || "", last: w.last || "",
                  placeCode: w.placeCode || "", placeName: w.placeName || "" },
                launchNow, { id: w.waitingId });
            }
          }
        } catch (e) { /* ignore */ }
      }
    }
  } else {
    /* لا توجد جلسة حالية: نعرض آخر نتيجة محفوظة على هذا الجهاز مع إبقاء
       نموذج الدخول ظاهرًا استعدادًا للجلسة القادمة. */
    const last = latestLocalFinished();
    if (last) showRepeatBox(last, true);
  }

  $("#start-form").addEventListener("submit", async ev => {
    ev.preventDefault();
    const c = validateForm();
    if (!c) return;
    const btn = $("#btn-start");
    const err = $("#form-err");
    if (btn) btn.disabled = true;
    try {
      if (c.code) {
        err.textContent = "جارٍ التحقق من رمز المترشح…";
        const res = await Store.signInCandidate(c.code);
        c.codeHash = await Store.accessCodeHash(c.code);
        S.accessCode = c.code;
        S.codeHash = c.codeHash;
        try { localStorage.setItem(KEYS.code, c.code); } catch (e2) { /* ignore */ }
        err.textContent = "";
      }
      await handleJoin(c);
    } catch (e) {
      console.warn(e);
      err.textContent = candidateAuthMessage(e);
    } finally {
      if (btn) btn.disabled = false;
    }
  });

  const prevBtn = $("#btn-show-previous");
  if (prevBtn) prevBtn.addEventListener("click", async () => {
    prevBtn.disabled = true;
    try {
      const l = S.launch;
      const p = readProgress();
      const sid = l ? l.id : (p && p.launch ? p.launch.id : null);
      let row = S.previousRow || (sid ? findFinishedForSession(sid) : null);
      if (!row && sid) row = await findMyResultCloud(sid);
      if (row) showPreviousResult(row);
      else toast("لم يُعثر على النتيجة. تأكّد من الاتصال ثم أعد المحاولة.", true);
    } finally {
      prevBtn.disabled = false;
    }
  });

  const leaveBtn = $("#btn-leave-wait");
  if (leaveBtn) leaveBtn.addEventListener("click", () => leaveWaiting());

  $("#btn-next").addEventListener("click", () => nextQuestion(false));
  $("#btn-pdf").addEventListener("click", exportPdf);

  const saveStateEl = $("#save-state");
  if (saveStateEl) saveStateEl.addEventListener("click", () => {
    if (saveStateEl.dataset.state === "error" || saveStateEl.dataset.state === "offline") {
      S.lastProgressAt = 0;
      saveProgressNow(true);
    }
  });

  document.addEventListener("keydown", ev => {
    if ($("#view-exam").hidden || S.finished) return;
    const q = S.questions[S.idx];
    if (!q) return;
    if (q.type === "mcq" && /^[1-4]$/.test(ev.key)) {
      const o = q.options[Number(ev.key) - 1];
      if (o) selectOption(q, o.id);
    }
    const tag = (ev.target && ev.target.tagName || "").toLowerCase();
    if (ev.key === "Enter" && tag !== "textarea" && tag !== "button" && tag !== "a" && tag !== "input" && tag !== "select") {
      ev.preventDefault();
      nextQuestion(false);
    }
  });

  window.addEventListener("beforeunload", ev => {
    const examVisible = !$("#view-exam").hidden && !S.finished;
    const waitVisible = !$("#view-wait").hidden;
    const resultUnsaved = !$("#view-result").hidden && !S.finished;
    const finishUnsaved = !$("#view-finished").hidden && !S.finishedSaved;
    if (examVisible || waitVisible || resultUnsaved || finishUnsaved || S.persisting) {
      ev.preventDefault();
      ev.returnValue = "";
    }
  });

  /* reprise éventuelle */
  const p = readProgress();
  if (p) {
    const banner = document.createElement("div");
    banner.className = "rule-box";
    banner.style.marginBottom = "16px";
    banner.innerHTML =
      `<b>لديك محاولة غير مكتملة</b> (${esc((p.candidate?.first || "") + " " + (p.candidate?.last || ""))}، ` +
      `السؤال ${p.idx + 1} من ${p.questions.length}).`;
    const row = document.createElement("div");
    row.className = "btn-row";
    row.style.marginTop = "10px";
    const bResume = document.createElement("button");
    bResume.type = "button"; bResume.className = "btn btn-sm"; bResume.textContent = "استئناف المحاولة";
    const bDrop = document.createElement("button");
    bDrop.type = "button"; bDrop.className = "btn btn-sm btn-ghost"; bDrop.textContent = "حذف المحاولة والبدء من جديد";
    bResume.addEventListener("click", () => resumeExam(p));
    bDrop.addEventListener("click", () => { clearProgress(); banner.remove(); toast("حُذفت المحاولة السابقة"); });
    row.append(bResume, bDrop);
    banner.appendChild(row);
    $("#view-intro").prepend(banner);
    $("#f-first").value = p.candidate?.first || "";
    $("#f-last").value = p.candidate?.last || "";
    const placeSel = $("#f-place");
    if (placeSel && p.candidate?.placeCode) placeSel.value = p.candidate.placeCode;
  }
}

function resumeExam(p) {
  S.formKey = p.formKey || S.formKey || "A";
  const baseForm = (S.bank.forms && S.bank.forms[S.formKey]) || (S.bank.forms && S.bank.forms.A) || { questions: [], label: S.formKey };
  S.form = { ...baseForm, questions: Array.isArray(p.questions) ? p.questions : baseForm.questions };
  S.questions = Array.isArray(p.questions) && p.questions.length ? p.questions : baseForm.questions;
  S.answers = p.answers || {};
  S.idx = Math.min(p.idx || 0, Math.max(0, S.questions.length - 1));
  S.startedAt = p.startedAt || new Date().toISOString();
  S.candidate = p.candidate || { first: "", last: "" };
  S.launch = p.launch || S.launch || null;
  S.waitingId = p.waitingId != null ? p.waitingId : S.waitingId;
  S.finished = false;
  S.persisting = false;
  S.examStarted = true;
  S.resultUnlocked = false;
  S.finishedSaved = false;
  S.finishedRec = null;
  S.finishedGraded = null;
  stopUnlockPoll();
  stopFinishClock();
  stopWaitPoll();
  stopWaitClock();

  const allotted = S.questions.length ? allottedSeconds(S.questions[S.idx]) : 0;
  let rem = allotted;
  if (p.deadline) rem = Math.ceil((p.deadline - Date.now()) / 1000);
  else if (p.remaining != null) rem = p.remaining;
  S.resumeRemaining = Math.max(0, Math.min(allotted, rem));

  setMainView("#view-exam");
  setSaveState(navigator.onLine === false ? "offline" : "idle");
  $("#ex-name").textContent = `${S.candidate.first} ${S.candidate.last}`;
  $("#ex-form").textContent = `${(S.bank.forms[S.formKey] && S.bank.forms[S.formKey].label) || S.formKey} · ${S.questions.length} أسئلة · ${formTotal(S.form)} نقطة`;
  renderQuestion();
  startProgressTimer();
  startSessionPoll();
  checkSessionEnded();
  toast("تمّ استئناف المحاولة");
}

/* عند العودة إلى الصفحة من الخلفية: نتحقّق فورًا من إطلاق الجلسة أو إغلاقها،
   لأن متصفحات الهواتف تُبطئ المؤقّتات في الخلفية. */
function wakeRefresh() {
  if (document.hidden) return;
  const waitView = $("#view-wait");
  if (waitView && !waitView.hidden && !S.examStarted) {
    checkLaunch();
    refreshWaitingCount(true);
  }
  const examView = $("#view-exam");
  if (examView && !examView.hidden && !S.finished) checkSessionEnded();
  const finishView = $("#view-finished");
  if (finishView && !finishView.hidden) checkResultUnlock();
}

document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    if (S.examStarted && !S.finished) { try { saveProgressNow(); } catch (e) { /* ignore */ } }
    return;
  }
  wakeRefresh();
  if ($("#view-exam").hidden || S.finished) return;
  const q = S.questions[S.idx];
  if (!q || !S.qDeadline) return;
  const allotted = allottedSeconds(q);
  S.remaining = Math.max(0, Math.ceil((S.qDeadline - Date.now()) / 1000));
  renderTimer(allotted);
  if (S.remaining <= 0) { stopTick(); nextQuestion(true); }
});

window.addEventListener("pageshow", ev => {
  if (ev.persisted) wakeRefresh();
});

window.addEventListener("offline", () => {
  if (S.examStarted && !S.finished) setSaveState("offline");
});

window.addEventListener("online", () => {
  if (S.finished) { if (!S.resultUnlocked) checkResultUnlock(); return; }
  if (!S.examStarted) return;
  S.lastProgressAt = 0;
  saveProgressNow(true);
  checkSessionEnded();
});

window.addEventListener("pagehide", () => {
  if (S.examStarted && !S.finished) { try { saveProgressNow(); } catch (e) { /* ignore */ } }
});

document.addEventListener("DOMContentLoaded", boot);
})();
