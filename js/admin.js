/* ==========================================================================
   admin.js — فضاء المشرف : بوابة، لوحة إحصاء، نتائج، تنقيط، تحرير الأسئلة
   Encapsulé dans une IIFE : évite toute collision de noms avec les autres scripts.
   ========================================================================== */

(function () {
  "use strict";

  const { Store, esc, fmtDate, fmtDuration, scoreClass, toast, pad2, gradePaper, PLACE_LIST, placeName, placeLabel } = window.App;

  /* الدخول عبر Firebase (Email/Password): لا يوجد رمز ثابت في الشيفرة.
     القفل أدناه يبقى حاجزًا تنظيميًا على المحاولات الفاشلة. */
  const LOCK_KEY = "manhaj_admin_lock_v1";
  const MAX_TRIES = 5;
  const LOCK_MINUTES = 10;

  const A = {
    rows: [],
    bank: null,
    settings: null,
    launch: null,
    sessions: [],
    dashSession: "",
    editForm: "A",
    charts: {},
    sessionTimer: null,
    lastFullSync: 0,
    finalizedSessions: {},
    finishedSeen: new Set(),
    seenResultsReady: false,
    filter: { search: "", form: "", sort: "date", place: "", session: "" }
  };

  const activeRows = () => A.rows.filter(r => r.status !== "waiting" && r.status !== "removed");
  const inProgressRows = () => {
    if (!A.launch || !A.launch.id) return [];
    return A.rows.filter(r =>
      r && r.session_id === A.launch.id && r.status === "waiting" &&
      r.started_at && !r.finished_at
    );
  };
  const waitingRows = () => {
    if (!A.launch || !A.launch.id) return [];
    return A.rows.filter(r => r.status === "waiting" && !r.started_at && r.session_id === A.launch.id);
  };

/* ------------------------------------------------------------------- auth */
/* المصادقة الحقيقية موجودة في Firebase (js/core.js). هذا الملف يتحقق
   من وجود جلسة مشرف صالحة ويعرض الواجهة المناسبة. */
function isAuthed() {
  try { return !!(window.App && window.App.isAdminAuth && window.App.isAdminAuth()); }
  catch (e) { return false; }
}
function adminEmail() {
  return String((window.MANHAJ_CONFIG && window.MANHAJ_CONFIG.adminEmail) || "").trim();
}
function fillLoginEmail() {
  const el = $("#login-email");
  if (el && !el.value) el.value = adminEmail();
}
/* ترجمة أخطاء Firebase إلى رسائل مفهومة */
function firebaseAuthMessage(err) {
  const code = String((err && (err.code || err.message)) || "");
  if (code === "NOT_ADMIN") return "هذا الحساب ليس حساب المشرف المعتمد.";
  if (code.indexOf("ADMIN_AUTH_REQUIRED") !== -1) return "انتهت جلسة المشرف. أعد تسجيل الدخول.";
  if (code.indexOf("INVALID_LOGIN_CREDENTIALS") !== -1 ||
      code.indexOf("INVALID_PASSWORD") !== -1 ||
      code.indexOf("EMAIL_NOT_FOUND") !== -1 ||
      code.indexOf("INVALID_EMAIL") !== -1) return "البريد الإلكتروني أو كلمة المرور غير صحيحة.";
  if (code.indexOf("USER_DISABLED") !== -1) return "هذا الحساب معطّل.";
  if (code.indexOf("TOO_MANY_ATTEMPTS_TRY_LATER") !== -1) return "محاولات كثيرة جدًا. حاول بعد قليل.";
  if (code.indexOf("WEAK_PASSWORD") !== -1) return "كلمة المرور الجديدة ضعيفة: 6 أحرف على الأقل.";
  if (code.indexOf("NETWORK") !== -1) return "تعذّر الاتصال بالشبكة. تحقّق من الاتصال وحاول مجددًا.";
  return "تعذّر إتمام العملية. تحقّق من الاتصال وحاول مجددًا.";
}
function lockState() {
  try { return JSON.parse(localStorage.getItem(LOCK_KEY) || "null"); } catch (e) { return null; }
}
function lockInfo() {
  const l = lockState();
  if (l && l.until && Date.now() < l.until) {
    return { locked: true, minutes: Math.ceil((l.until - Date.now()) / 60000) };
  }
  return { locked: false, count: (l && l.count) || 0 };
}
function registerFailure() {
  try {
    const now = Date.now();
    const windowMs = LOCK_MINUTES * 60 * 1000;
    let l = lockState() || {};
    /* نافذة المحاولات: تُصفَّر بعد 10 دقائق من أول محاولة فاشلة */
    if (!l.first || now - l.first > windowMs) l = { count: 0, first: now };
    const count = (l.count || 0) + 1;
    if (count >= MAX_TRIES) {
      localStorage.setItem(LOCK_KEY, JSON.stringify({
        count: 0, first: now, until: now + windowMs
      }));
      return { lockedNow: true, left: 0 };
    }
    localStorage.setItem(LOCK_KEY, JSON.stringify({ count, first: l.first, last: now }));
    return { lockedNow: false, left: MAX_TRIES - count };
  } catch (e) {
    return { lockedNow: false, left: MAX_TRIES };
  }
}
function clearLock() {
  try { localStorage.removeItem(LOCK_KEY); } catch (e) { /* ignore */ }
}

/* -------------------------------------------------------- parse des copies */
function parseAnswers(row) {
  try {
    const raw = row.answers;
    const obj = typeof raw === "string" ? JSON.parse(raw || "{}") : (raw || {});
    return obj && typeof obj === "object" ? obj : {};
  } catch (e) {
    return {};
  }
}

/* Recalcule une copie depuis sa propre empreinte (snapshot) et ses réponses */
function regrade(row) {
  const data = parseAnswers(row);
  const snap = data.snapshot || [];
  const mcq = snap.filter(q => q.type === "mcq");
  const open = snap.filter(q => q.type === "open");

  let mcqScore = 0;
  mcq.forEach(q => { if (q.given && q.given === q.correct) mcqScore += Number(q.points || 0); });

  const openDetails = data.details ? data.details.filter(d => d.type === "open") : [];
  let openScore = 0;
  open.forEach(q => {
    const d = openDetails.find(x => x.qid === q.qid);
    if (d) openScore += Number(d.earned || 0);
  });

  const mcqMax = mcq.reduce((s, q) => s + Number(q.points || 0), 0);
  const openMax = open.reduce((s, q) => s + Number(q.points || 0), 0);

  return {
    data, snap, mcq, open, mcqScore, openScore,
    mcqMax, openMax, totalMax: mcqMax + openMax,
    total: mcqScore + openScore
  };
}

/* مجموع نقط نموذج من البنك (اختيارات / تعبير / المجموع) */
function formMax(formObj) {
  const qs = (formObj && formObj.questions) || [];
  const mcq = qs.filter(q => q.type === "mcq").reduce((s, q) => s + Number(q.points || 0), 0);
  const open = qs.filter(q => q.type === "open").reduce((s, q) => s + Number(q.points || 0), 0);
  return { mcq, open, total: mcq + open };
}

/* ------------------------------------------------ متابعة التقدّم الحي */
function progressStats(row) {
  let p = null;
  try {
    p = row.progress
      ? (typeof row.progress === "string" ? JSON.parse(row.progress) : row.progress)
      : null;
  } catch (e) { p = null; }
  const formKey = row.form || (p && p.form) || "A";
  const formObj = A.bank && A.bank.forms && A.bank.forms[formKey];
  const total = Number(p && p.total) ||
    (formObj && Array.isArray(formObj.questions) ? formObj.questions.length : 0) || 12;
  const answers = (p && p.answers) || {};
  let answered = 0;
  Object.keys(answers).forEach(k => {
    const a = answers[k];
    if (!a) return;
    if (typeof a === "string") { if (a.trim()) answered++; return; }
    if (a.choice) { answered++; return; }
    if (typeof a.text === "string" && a.text.trim()) answered++;
  });
  answered = Math.min(answered, total);
  return { answered, total, pct: total ? Math.round((answered / total) * 100) : 0 };
}

function liveState(row) {
  if (A.launch && A.launch.status === "closed") {
    return { cls: "badge-neutral", text: "بانتظار الحفظ النهائي", title: "ستُجمع نتيجته تلقائيًا بعد الإغلاق" };
  }
  const at = row.progress_at ? new Date(row.progress_at).getTime() : 0;
  if (!at || isNaN(at)) {
    return { cls: "badge-neutral", text: "بدأ للتو", title: "لم يصل حفظ سحابي بعد" };
  }
  const age = Math.max(0, Math.round((Date.now() - at) / 1000));
  if (age <= 45) return { cls: "badge-ok", text: "نشط", title: `آخر حفظ منذ ${fmtDuration(age)}` };
  if (age <= 180) return { cls: "badge-warn", text: "انقطاع قصير", title: `آخر حفظ منذ ${fmtDuration(age)}` };
  return { cls: "badge-danger", text: "متوقف", title: `آخر حفظ منذ ${fmtDuration(age)} — قد يكون الاتصال منقطعًا` };
}

function finishedResultRows() {
  return A.rows.filter(r =>
    r && r.finished_at && r.status !== "waiting" && r.status !== "removed"
  );
}

/* تنبيه المشرف عند وصول نتيجة جديدة دون إزعاج عند التحميل الأول. */
function syncSeenResults(notify) {
  const list = finishedResultRows();
  if (!A.seenResultsReady) {
    A.finishedSeen = new Set(list.map(r => r.id));
    A.seenResultsReady = true;
    return;
  }
  const fresh = list.filter(r => !A.finishedSeen.has(r.id));
  A.finishedSeen = new Set(list.map(r => r.id));
  if (!notify || !fresh.length) return;
  const current = fresh.filter(r => A.launch && r.session_id === A.launch.id);
  const use = current.length ? current : fresh;
  const last = use[use.length - 1];
  const name = `${last.candidate_first || ""} ${last.candidate_last || ""}`.trim() || "مترشح";
  if (use.length === 1) {
    toast(`نتيجة جديدة: ${name} — ${Math.round(Number(last.percent) || 0)}%`);
  } else {
    toast(`وصلت ${use.length} نتائج جديدة — آخرها ${name}`);
  }
}

/* ============================================================== init / vues */
function boot() {
  bindLogin();
  bindPassword();
  bindTabs();
  bindSession();
  bindResults();
  bindDash();
  bindBank();
  bindSettings();
  bindCloudSettings();
  bindWord();
  bindCodes();

  /* إذا رفضت Firebase الجلسة (انتهت صلاحيتها أو تغيّرت الصلاحيات)
     نعيد المشرف إلى بوابة الدخول بدل تركه أمام لوحة لا يستطيع الكتابة فيها. */
  window.addEventListener("manhaj-admin-auth-required", ev => {
    stopSessionTimer();
    show("#view-login");
    fillLoginEmail();
    const msg = ev && ev.detail && ev.detail.message;
    $("#login-err").textContent = msg || "انتهت جلسة المشرف. أعد تسجيل الدخول للمتابعة.";
    $("#login-password").value = "";
    $("#login-password").focus();
  });

  fillLoginEmail();

  if (isAuthed()) {
    enterPanel();
  } else {
    show("#view-login");
    $("#login-password").focus();
  }
}

function show(sel) {
  ["#view-login", "#view-panel"].forEach(s => { const el = $(s); if (el) el.hidden = (s !== sel); });
}

function bindLogin() {
  $("#login-form").addEventListener("submit", async ev => {
    ev.preventDefault();
    const lock = lockInfo();
    if (lock.locked) {
      $("#login-err").textContent = `تم قفل الدخول مؤقتًا. حاول بعد ${lock.minutes} دقيقة.`;
      return;
    }
    const email = $("#login-email").value.trim();
    const password = $("#login-password").value;
    if (!email || !password) {
      $("#login-err").textContent = "أدخل البريد الإلكتروني وكلمة المرور.";
      return;
    }
    const btn = $("#login-submit");
    if (btn) btn.disabled = true;
    try {
      await window.App.signInAdmin(email, password);
      clearLock();
      $("#login-err").textContent = "";
      $("#login-password").value = "";
      await enterPanel();
    } catch (e) {
      const fail = registerFailure();
      $("#login-err").textContent = fail.lockedNow
        ? `تجاوزت عدد المحاولات — أُقفل الدخول لمدة ${LOCK_MINUTES} دقائق.`
        : `${firebaseAuthMessage(e)} المحاولات المتبقية قبل القفل: ${fail.left}.`;
      $("#login-password").select();
    } finally {
      if (btn) btn.disabled = false;
    }
  });

  $("#btn-logout").addEventListener("click", () => {
    window.App.signOutAdmin();
    stopSessionTimer();
    $("#login-err").textContent = "";
    $("#login-password").value = "";
    fillLoginEmail();
    show("#view-login");
    $("#login-password").focus();
    toast("تمّ الخروج");
  });

  $("#btn-reload").addEventListener("click", () => loadAll(true));
}

/* بطاقة «أمان حساب المشرف»: تغيير كلمة مرور Firebase */
function bindPassword() {
  const form = $("#password-form");
  if (!form) return;
  const emailEl = $("#account-email");
  const refreshEmail = () => {
    if (emailEl) emailEl.textContent = window.App.getAuthEmail() || adminEmail() || "—";
  };
  refreshEmail();
  form.addEventListener("submit", async ev => {
    ev.preventDefault();
    const msg = $("#password-msg");
    const current = $("#pass-current").value;
    const next = $("#pass-new").value;
    const confirm = $("#pass-confirm").value;
    const showMsg = (text, bad) => {
      if (!msg) return;
      msg.className = bad ? "err" : "hint";
      msg.style.color = bad ? "" : "var(--ok)";
      msg.textContent = text;
    };
    if (!current || !next) { showMsg("أدخل كلمة المرور الحالية والجديدة.", true); return; }
    if (next.length < 6) { showMsg("كلمة المرور الجديدة يجب أن تكون 6 أحرف على الأقل.", true); return; }
    if (next !== confirm) { showMsg("تأكيد كلمة المرور لا يطابق الكلمة الجديدة.", true); return; }
    const btn = $("#password-submit");
    if (btn) btn.disabled = true;
    try {
      await window.App.changeAdminPassword(current, next);
      form.reset();
      refreshEmail();
      showMsg("تمّ تغيير كلمة المرور بنجاح.", false);
      toast("تمّ تغيير كلمة المرور");
    } catch (e) {
      showMsg(firebaseAuthMessage(e), true);
    } finally {
      if (btn) btn.disabled = false;
    }
  });
}

async function enterPanel() {
  show("#view-panel");
  await loadAll();
  startSessionTimer();
}

function updatePanelSub() {
  if (!A.bank) return;
  const done = activeRows().length;
  const waiting = waitingRows().length;
  const live = inProgressRows().length;
  $("#panel-sub").textContent =
    `${A.bank.meta.title} · ${done} منجز · ${live} قيد الاختبار · ${waiting} في الانتظار · المرجع: ${A.bank.meta.reference}`;
}

async function loadAll(notify) {
  try {
    A.settings = await Store.getSettings();
    A.bank = await Store.getBank();
    /* تحميل كامل عند الإقلاع/بعد عمليات الحذف أو التثبيت: يضمن اختفاء
       السجلات المحذوفة فورًا. التحديث الدوري وحده يستعمل الفهرسة التدريجية. */
    A.rows = await Store.listSubmissions();
    A.lastFullSync = Date.now();
    A.launch = await Store.getLaunch();
    A.sessions = await Store.getSessions(A.rows);
    A.editForm = A.editForm || "A";
    syncSeenResults(false);

    const mode = Store.getMode();
    const badge = $("#mode-badge");
    const cloud = mode === "cloud";
    const api = mode === "api";
    badge.textContent = cloud ? "تخزين: سحابي مشترك" : api ? "تخزين: خادم محلي" : "تخزين: هذا المتصفّح فقط";
    badge.className = "badge " + (cloud || api ? "badge-ok" : "badge-warn");
    badge.title = cloud
      ? "البيانات مشتركة عبر Firebase وتظهر لكل الأجهزة"
      : api
        ? "البيانات محفوظة على خادم tables المحلي وتظهر لكل الأجهزة المتصلة به"
        : "البيانات محفوظة في هذا المتصفّح فقط؛ المترشحون على هواتف أخرى لن يروها";
    const localNote = $("#local-mode-note");
    if (localNote) localNote.hidden = cloud || api;
    renderCloudState();

    updatePanelSub();
    renderSession();
    renderDash();
    fillResultFilters();
    renderResults();
    renderQuestions();
    fillSettings();
    renderCodes();
    if (notify) toast("تمّ التحديث");
  } catch (e) {
    console.error(e);
    toast("تعذّر تحميل البيانات", true);
  }
}

/* --------------------------------------------------------------------- tabs */
function bindTabs() {
  $$(".admin-nav button").forEach(btn => {
    btn.addEventListener("click", () => {
      $$(".admin-nav button").forEach(b => b.setAttribute("aria-selected", "false"));
      btn.setAttribute("aria-selected", "true");
      ["session", "dash", "results", "questions", "settings"].forEach(t => {
        const panel = $("#tab-" + t);
        if (panel) panel.hidden = (t !== btn.dataset.tab);
      });
      if (btn.dataset.tab === "dash") {
        renderDash();
        Object.values(A.charts).forEach(c => c && c.resize());
      }
    });
  });
}

/* ================================================================== DASHBOARD */
function kpi(label, value) {
  return `<div class="kpi"><div class="k">${esc(label)}</div><div class="v">${value}</div></div>`;
}

function passMarkValue() {
  const raw = A.settings ? A.settings.passMark : undefined;
  const v = Number(raw);
  return raw != null && Number.isFinite(v) ? v : 50;
}

function dashStats(rows) {
  /* لا تُحتسب إلا النسخ التي نُشرت نقطها رسميًا */
  const scored = rows.filter(r => r && r.official);
  const scores = scored.map(r => Number(r.final_score || 0));
  const n = scores.length;
  const pm = passMarkValue();
  let sum = 0, passed = 0, best = null, worst = null;
  scores.forEach(s => {
    sum += s;
    if (s >= pm) passed += 1;
    if (best == null || s > best) best = s;
    if (worst == null || s < worst) worst = s;
  });
  return {
    n,
    avg: n ? sum / n : 0,
    passed,
    passRate: n ? (passed / n) * 100 : 0,
    best,
    worst
  };
}

function dashNum(v) {
  return v == null ? "—" : (Math.round(v * 10) / 10).toFixed(1);
}

function knownSessionIds() {
  const set = new Set();
  (A.sessions || []).forEach(s => { if (s && s.id) set.add(s.id); });
  if (A.launch && A.launch.id) set.add(A.launch.id);
  return set;
}

/* يجمع الجلسات المعروفة + الجلسات المحذوفة (نسخ باقية) + النسخ بدون جلسة */
function dashSessionInfo() {
  const known = knownSessionIds();
  const list = (A.sessions || []).filter(s => !s.deleted && !s.deletedAt).slice();
  if (A.launch && !list.some(s => s.id === A.launch.id)) list.unshift(A.launch);
  const out = list.map(s => {
    const current = !!(A.launch && A.launch.id === s.id);
    const cur = current ? A.launch : s;
    return {
      id: s.id,
      label: s.label || "جلسة",
      status: cur.status,
      current,
      synthetic: false,
      obj: cur
    };
  });
  if (A.rows.some(r => r.session_id && !known.has(r.session_id))) {
    out.push({ id: "__orphan__", label: "جلسات محذوفة", status: null, current: false, synthetic: true, obj: null });
  }
  if (A.rows.some(r => !r.session_id)) {
    out.push({ id: "__none__", label: "بدون جلسة", status: null, current: false, synthetic: true, obj: null });
  }
  return { list: out, known };
}

function dashRowsFor(id) {
  const rows = activeRows();
  if (!id) return rows;
  if (id === "__none__") return rows.filter(r => !r.session_id);
  if (id === "__orphan__") {
    const known = knownSessionIds();
    return rows.filter(r => r.session_id && !known.has(r.session_id));
  }
  return rows.filter(r => r.session_id === id);
}

function filteredDashRows() {
  return dashRowsFor(A.dashSession || "");
}

function dashScopeLabel() {
  if (!A.dashSession) return "كل الجلسات";
  const s = dashSessionInfo().list.find(x => x.id === A.dashSession);
  return s ? s.label : "كل الجلسات";
}

function fillDashSessionFilter() {
  const sel = $("#dash-session-filter");
  if (!sel) return;
  const info = dashSessionInfo();
  const sig = info.list.map(s => s.id + ":" + (s.label || "")).join("|");
  if (sel.dataset.sig !== sig) {
    sel.innerHTML = `<option value="">كل الجلسات</option>` + info.list.map(s =>
      `<option value="${esc(s.id)}">${esc(s.label || "جلسة")}</option>`).join("");
    sel.dataset.sig = sig;
  }
  if (A.dashSession && !info.list.some(s => s.id === A.dashSession)) A.dashSession = "";
  sel.value = A.dashSession;
}

function dashPlaceMeta(code) {
  const c = String(code == null ? "" : code).trim();
  const prefix = c.split(".")[0];
  const grouped = ["1", "2", "3", "4"].includes(prefix);
  return {
    code: c,
    prefix: grouped ? prefix : "__unknown__",
    groupLabel: grouped ? `المجموعة ${prefix}` : "غير محدد",
    name: placeName(c) || (c ? "محطة غير مسجّلة" : "بدون مكان")
  };
}

/* هيكل واحد يُستعمل في العرض وفي تصدير Excel: مجموعة ← محطات */
function dashBreakdown(rows) {
  const groups = ["1", "2", "3", "4"].map(g => ({
    key: g,
    label: `المجموعة ${g}`,
    rows: [],
    places: PLACE_LIST.filter(p => p.code.split(".")[0] === g)
      .map(p => ({ rawCode: p.code, code: p.code, name: p.name, rows: [] }))
  }));
  const unknown = { key: "__unknown__", label: "غير محدد", rows: [], places: [] };
  const byKey = new Map(groups.map(g => [g.key, g]));

  rows.forEach(r => {
    const meta = dashPlaceMeta(r.place_code);
    const group = byKey.get(meta.prefix) || unknown;
    group.rows.push(r);
    let place = group.places.find(p => p.rawCode === meta.code);
    if (!place) {
      place = { rawCode: meta.code, code: meta.code || "—", name: meta.name, rows: [] };
      group.places.push(place);
    }
    place.rows.push(r);
  });

  unknown.places.sort((a, b) => String(a.code).localeCompare(String(b.code), "ar"));
  const finish = g => ({
    ...g,
    stats: dashStats(g.rows),
    places: g.places.map(p => ({ ...p, stats: dashStats(p.rows) }))
  });
  const out = groups.map(finish);
  if (unknown.rows.length) out.push(finish(unknown));
  return out;
}

function renderDash() {
  if (!A.bank) return;
  fillDashSessionFilter();

  const rows = filteredDashRows();
  const st = dashStats(rows);
  const scope = dashScopeLabel();
  const scopeEl = $("#dash-scope-label");
  if (scopeEl) scopeEl.textContent = scope;
  const groupsScope = $("#dash-groups-scope");
  if (groupsScope) groupsScope.textContent = scope;

  $("#dash-kpis").innerHTML =
    kpi("عدد المترشحين", st.n) +
    kpi("المعدّل العام", `<span style="font-size:1.5rem">${st.n ? dashNum(st.avg) : "—"}</span><small>/100</small>`) +
    kpi("الناجحون", `${st.passed}<small>/${st.n}</small>`) +
    kpi("أعلى نقطة", `<span style="font-size:1.5rem">${st.best == null ? "—" : st.best}</span><small>/100</small>`) +
    kpi("أدنى نقطة", `<span style="font-size:1.5rem">${st.worst == null ? "—" : st.worst}</span><small>/100</small>`);

  renderDashSessions();
  renderDashGroups(rows);
  renderHistogram(rows.map(r => Number(r.final_score || 0)));
  renderQuestionChart(rows);
  renderTopicChart(rows);
  renderInsights(rows, st);
}

function renderDashSessions() {
  const host = $("#dash-sessions");
  if (!host) return;
  const info = dashSessionInfo();
  if (!info.list.length) {
    host.innerHTML = `<div class="table-empty">لا توجد جلسات ولا نتائج بعد — أنشئ جلسة من تبويب «الجلسة والإطلاق».</div>`;
    return;
  }

  const waitingFor = (id) => {
    if (id === "__none__") return A.rows.filter(r => r.status === "waiting" && !r.session_id);
    if (id === "__orphan__") {
      const known = knownSessionIds();
      return A.rows.filter(r => r.status === "waiting" && r.session_id && !known.has(r.session_id));
    }
    return A.rows.filter(r => r.status === "waiting" && r.session_id === id);
  };

  const trs = info.list.map(s => {
    const st = dashStats(dashRowsFor(s.id));
    const wait = waitingFor(s.id);
    const waiting = wait.filter(r => !r.started_at).length;
    const progress = wait.filter(r => !!r.started_at).length;
    const b = s.synthetic ? { text: "—", cls: "badge-neutral" } : sessionBadge(s.obj);
    const cls = A.dashSession === s.id ? "session-current" : "";
    return `<tr class="${cls}">
      <td><b>${esc(s.label)}</b>${s.current ? ' <span class="badge badge-ok">الحالية</span>' : ""}</td>
      <td><span class="badge ${b.cls}">${esc(b.text)}</span></td>
      <td class="num">${st.n}</td>
      <td class="num">${waiting}</td>
      <td class="num">${progress}</td>
      <td class="num">${st.n ? dashNum(st.avg) : "—"}</td>
      <td class="num">${st.passed}</td>
      <td class="num">${st.n ? dashNum(st.passRate) + " %" : "—"}</td>
    </tr>`;
  }).join("");

  const all = activeRows();
  const stAll = dashStats(all);
  const allWait = A.rows.filter(r => r.status === "waiting");
  const totalRow = `<tr class="dash-total-row">
    <td><b>كل الجلسات</b></td><td><span class="badge badge-neutral">—</span></td>
    <td class="num">${stAll.n}</td>
    <td class="num">${allWait.filter(r => !r.started_at).length}</td>
    <td class="num">${allWait.filter(r => !!r.started_at).length}</td>
    <td class="num">${stAll.n ? dashNum(stAll.avg) : "—"}</td>
    <td class="num">${stAll.passed}</td>
    <td class="num">${stAll.n ? dashNum(stAll.passRate) + " %" : "—"}</td>
  </tr>`;

  host.innerHTML = `<div class="table-scroll"><table class="data dash-sessions-table">
    <thead><tr>
      <th>الجلسة</th><th>الحالة</th><th class="num">منجزون</th><th class="num">منتظرون</th>
      <th class="num">قيد الإنجاز</th><th class="num">المعدّل /100</th><th class="num">الناجحون</th><th class="num">نسبة النجاح</th>
    </tr></thead><tbody>${trs}${totalRow}</tbody></table></div>`;
}

function renderDashGroups(rows) {
  const host = $("#dash-groups");
  if (!host) return;
  const breakdown = dashBreakdown(rows);
  const total = rows.length;

  const statCells = (st) => {
    const pct = st.n ? dashNum(st.passRate) + " %" : "—";
    const share = total ? dashNum((st.n / total) * 100) + " %" : "—";
    return `<td class="num">${st.n}</td>` +
      `<td class="num">${st.n ? dashNum(st.avg) : "—"}</td>` +
      `<td class="num">${st.best == null ? "—" : st.best}</td>` +
      `<td class="num">${st.worst == null ? "—" : st.worst}</td>` +
      `<td class="num">${st.passed}</td>` +
      `<td class="num">${pct}</td>` +
      `<td class="num">${share}</td>`;
  };

  const trs = breakdown.map(g => {
    const groupRow = `<tr class="dash-group-row">
      <td><b>${esc(g.label)}</b> <span class="small muted">(${g.places.length} محطات)</span></td>
      ${statCells(g.stats)}
    </tr>`;
    const placeRows = g.places.map(p => `<tr class="dash-sub-row">
      <td><span class="dash-place-code">${esc(p.code)}</span> ${esc(p.name)}</td>
      ${statCells(p.stats)}
    </tr>`).join("");
    return groupRow + placeRows;
  }).join("");

  const note = rows.length ? "" :
    `<p class="small muted" style="margin:0 0 10px">لا توجد نسخ منجزة في هذا النطاق بعد — الأعداد تظهر صفرًا إلى حين ورود النتائج.</p>`;

  host.innerHTML = note + `<div class="table-scroll"><table class="data dash-groups-table">
    <thead><tr>
      <th>المجموعة / المحطة</th><th class="num">العدد</th><th class="num">المعدّل /100</th>
      <th class="num">أعلى</th><th class="num">أدنى</th><th class="num">الناجحون</th>
      <th class="num">نسبة النجاح</th><th class="num">الحصة</th>
    </tr></thead><tbody>${trs}</tbody></table></div>`;
}

function bindDash() {
  const sel = $("#dash-session-filter");
  if (sel) sel.addEventListener("change", () => {
    A.dashSession = sel.value;
    renderDash();
  });
  const pdf = $("#btn-dash-pdf");
  if (pdf) pdf.addEventListener("click", exportDashPdf);
  const xlsx = $("#btn-dash-xlsx");
  if (xlsx) xlsx.addEventListener("click", exportDashXlsx);
}

/* ------------------------------------------------------------ بيانات التصدير */
function dashWaitingRows(id) {
  const all = A.rows.filter(r => r.status === "waiting");
  if (!id) return all;
  if (id === "__none__") return all.filter(r => !r.session_id);
  if (id === "__orphan__") {
    const known = knownSessionIds();
    return all.filter(r => r.session_id && !known.has(r.session_id));
  }
  return all.filter(r => r.session_id === id);
}

/* صفوف موحّدة لملخّص الجلسات (تُستعمل في الجدول وفي Excel) */
function dashSessionRows() {
  const info = dashSessionInfo();
  const list = info.list.map(s => {
    const rows = dashRowsFor(s.id);
    const st = dashStats(rows);
    const wait = dashWaitingRows(s.id);
    return {
      id: s.id,
      label: s.label,
      status: s.synthetic ? "—" : sessionBadge(s.obj).text,
      current: s.current,
      n: st.n,
      waiting: wait.filter(r => !r.started_at).length,
      progress: wait.filter(r => !!r.started_at).length,
      avg: st.avg,
      passed: st.passed,
      passRate: st.passRate
    };
  });
  const all = activeRows();
  const stAll = dashStats(all);
  const allWait = dashWaitingRows("");
  return {
    list,
    total: {
      label: "كل الجلسات",
      status: "—",
      n: stAll.n,
      waiting: allWait.filter(r => !r.started_at).length,
      progress: allWait.filter(r => !!r.started_at).length,
      avg: stAll.avg,
      passed: stAll.passed,
      passRate: stAll.passRate
    }
  };
}

function dashNumCell(v, suffix) {
  return v == null ? "—" : dashNum(v) + (suffix || "");
}

/* ---------------------------------------------------------------- PDF / Excel */
function exportDashPdf() {
  const rows = filteredDashRows();
  if (!rows.length) { toast("لا توجد بيانات في هذا النطاق لتصديرها", true); return; }

  const title = $("#dash-print-title");
  if (title) title.textContent = "لوحة الإحصاء — " + dashScopeLabel();
  const sub = $("#dash-print-sub");
  if (sub) {
    sub.textContent =
      `تاريخ التصدير: ${new Date().toLocaleString("ar")} · ${rows.length} نسخة منجزة · ` +
      `عتبة النجاح ${passMarkValue()}/100`;
  }

  document.body.classList.add("printing-dash");
  const done = () => {
    document.body.classList.remove("printing-dash");
    window.removeEventListener("afterprint", done);
  };
  window.addEventListener("afterprint", done);
  setTimeout(() => window.print(), 150);
  setTimeout(done, 60000); /* garde-fou si afterprint n'est pas déclenché */
}

function exportDashCsv() {
  const sessions = dashSessionRows();
  const rows = filteredDashRows();
  const breakdown = dashBreakdown(rows);
  const pm = passMarkValue();

  const lines = [];
  const push = arr => lines.push(arr.map(v => csvCell(v)).join(","));

  push(["ملخّص الجلسات — " + dashScopeLabel()]);
  push(["الجلسة", "الحالة", "منجزون", "منتظرون", "قيد الإنجاز", "المعدّل /100", "الناجحون", "نسبة النجاح %"]);
  sessions.list.forEach(s => push([s.label, s.status, s.n, s.waiting, s.progress,
    s.n ? dashNum(s.avg) : "", s.passed, s.n ? dashNum(s.passRate) : ""]));
  push([sessions.total.label, sessions.total.status, sessions.total.n, sessions.total.waiting,
    sessions.total.progress, sessions.total.n ? dashNum(sessions.total.avg) : "",
    sessions.total.passed, sessions.total.n ? dashNum(sessions.total.passRate) : ""]);
  lines.push("");

  push(["حسب المجموعات"]);
  push(["المجموعة", "العدد", "المعدّل /100", "أعلى", "أدنى", "الناجحون", "نسبة النجاح %", "الحصة %"]);
  breakdown.forEach(g => push([g.label, g.stats.n, g.stats.n ? dashNum(g.stats.avg) : "",
    g.stats.best == null ? "" : g.stats.best, g.stats.worst == null ? "" : g.stats.worst,
    g.stats.passed, g.stats.n ? dashNum(g.stats.passRate) : "",
    rows.length ? dashNum((g.stats.n / rows.length) * 100) : ""]));
  lines.push("");

  push(["حسب المحطات"]);
  push(["المجموعة", "المحطة", "العدد", "المعدّل /100", "أعلى", "أدنى", "الناجحون", "نسبة النجاح %"]);
  breakdown.forEach(g => g.places.forEach(p => push([g.label, p.code + " — " + p.name, p.stats.n,
    p.stats.n ? dashNum(p.stats.avg) : "", p.stats.best == null ? "" : p.stats.best,
    p.stats.worst == null ? "" : p.stats.worst, p.stats.passed,
    p.stats.n ? dashNum(p.stats.passRate) : ""])));
  lines.push("");
  push(["عتبة النجاح", pm + "/100", "تاريخ التصدير", new Date().toLocaleString("ar")]);

  download(new Blob(["\uFEFF" + lines.join("\r\n")], { type: "text/csv;charset=utf-8;" }),
    `لوحة-الإحصاء-${stamp()}.csv`);
  toast("تمّ تصدير CSV");
}

function exportDashXlsx() {
  const rows = filteredDashRows();
  if (!rows.length) { toast("لا توجد بيانات في هذا النطاق لتصديرها", true); return; }
  if (typeof XLSX === "undefined") {
    toast("تعذّر تحميل مكتبة Excel — سيتمّ تصدير CSV", true);
    exportDashCsv();
    return;
  }

  const sessions = dashSessionRows();
  const breakdown = dashBreakdown(rows);
  const pm = passMarkValue();
  const wb = XLSX.utils.book_new();

  /* 1) ملخّص الجلسات */
  const wsSessions = XLSX.utils.aoa_to_sheet(
    [["الجلسة", "الحالة", "منجزون", "منتظرون", "قيد الإنجاز", "المعدّل /100", "الناجحون", "نسبة النجاح %"]]
      .concat(sessions.list.map(s => [s.label, s.status, s.n, s.waiting, s.progress,
        s.n ? Number(dashNum(s.avg)) : "", s.passed, s.n ? Number(dashNum(s.passRate)) : ""]))
      .concat([[sessions.total.label, sessions.total.status, sessions.total.n, sessions.total.waiting,
        sessions.total.progress, sessions.total.n ? Number(dashNum(sessions.total.avg)) : "",
        sessions.total.passed, sessions.total.n ? Number(dashNum(sessions.total.passRate)) : ""]])
  );
  wsSessions["!cols"] = [{ wch: 30 }, { wch: 24 }, { wch: 9 }, { wch: 9 }, { wch: 11 }, { wch: 12 }, { wch: 9 }, { wch: 13 }];
  XLSX.utils.book_append_sheet(wb, wsSessions, "ملخّص الجلسات");

  /* 2) حسب المجموعات (مجموعة ← محطات) */
  const groupAoa = [["المستوى", "المجموعة / المحطة", "العدد", "المعدّل /100", "أعلى", "أدنى", "الناجحون", "نسبة النجاح %", "الحصة %"]];
  breakdown.forEach(g => {
    groupAoa.push(["مجموعة", g.label, g.stats.n,
      g.stats.n ? Number(dashNum(g.stats.avg)) : "", g.stats.best == null ? "" : g.stats.best,
      g.stats.worst == null ? "" : g.stats.worst, g.stats.passed,
      g.stats.n ? Number(dashNum(g.stats.passRate)) : "",
      rows.length ? Number(dashNum((g.stats.n / rows.length) * 100)) : ""]);
    g.places.forEach(p => {
      groupAoa.push(["محطة", p.code + " — " + p.name, p.stats.n,
        p.stats.n ? Number(dashNum(p.stats.avg)) : "", p.stats.best == null ? "" : p.stats.best,
        p.stats.worst == null ? "" : p.stats.worst, p.stats.passed,
        p.stats.n ? Number(dashNum(p.stats.passRate)) : "",
        rows.length ? Number(dashNum((p.stats.n / rows.length) * 100)) : ""]);
    });
  });
  const wsGroups = XLSX.utils.aoa_to_sheet(groupAoa);
  wsGroups["!cols"] = [{ wch: 9 }, { wch: 34 }, { wch: 8 }, { wch: 11 }, { wch: 8 }, { wch: 8 }, { wch: 9 }, { wch: 12 }, { wch: 9 }];
  XLSX.utils.book_append_sheet(wb, wsGroups, "حسب المجموعات");

  /* 3) حسب المحطات */
  const placeAoa = [["المجموعة", "رمز المحطة", "المحطة", "العدد", "المعدّل /100", "أعلى", "أدنى", "الناجحون", "نسبة النجاح %"]];
  breakdown.forEach(g => g.places.forEach(p => placeAoa.push([
    g.label, p.code, p.name, p.stats.n,
    p.stats.n ? Number(dashNum(p.stats.avg)) : "", p.stats.best == null ? "" : p.stats.best,
    p.stats.worst == null ? "" : p.stats.worst, p.stats.passed,
    p.stats.n ? Number(dashNum(p.stats.passRate)) : ""
  ])));
  const wsPlaces = XLSX.utils.aoa_to_sheet(placeAoa);
  wsPlaces["!cols"] = [{ wch: 12 }, { wch: 9 }, { wch: 30 }, { wch: 8 }, { wch: 11 }, { wch: 8 }, { wch: 8 }, { wch: 9 }, { wch: 12 }];
  XLSX.utils.book_append_sheet(wb, wsPlaces, "حسب المحطات");

  /* 4) الجلسة × المحطة (جدول تحليلي مسطّح) */
  const crossAoa = [["الجلسة", "الحالة", "المجموعة", "المحطة", "العدد", "المعدّل /100", "أعلى", "أدنى", "الناجحون", "نسبة النجاح %"]];
  sessions.list.forEach(s => {
    const bd = dashBreakdown(dashRowsFor(s.id));
    bd.forEach(g => g.places.forEach(p => crossAoa.push([
      s.label, s.status, g.label, p.code + " — " + p.name, p.stats.n,
      p.stats.n ? Number(dashNum(p.stats.avg)) : "", p.stats.best == null ? "" : p.stats.best,
      p.stats.worst == null ? "" : p.stats.worst, p.stats.passed,
      p.stats.n ? Number(dashNum(p.stats.passRate)) : ""
    ])));
  });
  const wsCross = XLSX.utils.aoa_to_sheet(crossAoa);
  wsCross["!cols"] = [{ wch: 28 }, { wch: 22 }, { wch: 12 }, { wch: 30 }, { wch: 8 }, { wch: 11 }, { wch: 8 }, { wch: 8 }, { wch: 9 }, { wch: 12 }];
  XLSX.utils.book_append_sheet(wb, wsCross, "الجلسة × المحطة");

  /* ملاحظة العتبة والتاريخ أسفل ورقة الملخّص عبر ورقة صغيرة إضافية */
  const metaWs = XLSX.utils.aoa_to_sheet([
    ["نطاق التصدير", dashScopeLabel()],
    ["عدد النسخ المنجزة", rows.length],
    ["عتبة النجاح", pm + "/100"],
    ["تاريخ التصدير", new Date().toLocaleString("ar")],
    ["المرجع", (A.bank && A.bank.meta && A.bank.meta.reference) || ""]
  ]);
  metaWs["!cols"] = [{ wch: 22 }, { wch: 48 }];
  XLSX.utils.book_append_sheet(wb, metaWs, "المؤشرات");

  XLSX.writeFile(wb, `لوحة-الإحصاء-${stamp()}.xlsx`);
  toast("تمّ تصدير لوحة الإحصاء إلى Excel");
}


function destroyChart(key) {
  if (A.charts[key]) { A.charts[key].destroy(); A.charts[key] = null; }
}

function chartFont() {
  return { family: "Cairo, Tahoma, sans-serif", size: 11 };
}

function renderHistogram(scores) {
  const bounds = [0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
  const labels = [];
  const counts = [];
  for (let i = 0; i < bounds.length - 1; i++) {
    labels.push(`${bounds[i]}–${bounds[i + 1]}`);
    counts.push(scores.filter(s => s >= bounds[i] && s < bounds[i + 1] + (i === bounds.length - 2 ? 0.01 : 0)).length);
  }

  const ctx = $("#chart-hist");
  if (!ctx) return;
  if (typeof Chart === "undefined") return;
  destroyChart("hist");
  A.charts.hist = new Chart(ctx, {
    type: "bar",
    data: {
      labels,
      datasets: [{
        label: "عدد المترشحين",
        data: counts,
        backgroundColor: counts.map((c, i) => {
          const mid = bounds[i] + 5;
          return mid >= 70 ? "rgba(28,131,101,.82)" : mid >= 50 ? "rgba(185,139,58,.82)" : "rgba(168,50,42,.7)";
        }),
        borderRadius: 6,
        maxBarThickness: 46
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: { callbacks: { label: c => `${c.parsed.y} مترشحًا` } }
      },
      scales: {
        x: { grid: { display: false }, ticks: { font: chartFont(), color: "#3d5148" } },
        y: {
          beginAtZero: true, ticks: { precision: 0, font: chartFont(), color: "#3d5148" },
          grid: { color: "rgba(0,0,0,.06)" }
        }
      }
    }
  });
}

function collectMcqStats(rows = activeRows()) {
  /* qid -> { topic, points, attempts, correct } */
  const map = new Map();
  rows.forEach(row => {
    const d = parseAnswers(row);
    (d.snapshot || []).forEach(q => {
      if (q.type !== "mcq") return;
      const key = q.qid;
      if (!map.has(key)) map.set(key, { qid: key, topic: q.topic, text: q.text, points: q.points, attempts: 0, correct: 0 });
      const rec = map.get(key);
      rec.attempts += 1;
      if (q.given && q.given === q.correct) rec.correct += 1;
    });
  });
  return Array.from(map.values()).sort((a, b) => a.qid.localeCompare(b.qid));
}

function renderQuestionChart(rows = activeRows()) {
  const stats = collectMcqStats(rows);
  const ctx = $("#chart-questions");
  if (!ctx) return;
  if (typeof Chart === "undefined") return;
  destroyChart("questions");

  if (!stats.length) {
    ctx.getContext("2d").clearRect(0, 0, ctx.width, ctx.height);
    return;
  }

  A.charts.questions = new Chart(ctx, {
    type: "bar",
    data: {
      labels: stats.map(s => s.qid),
      datasets: [{
        label: "نسبة الإجابات الصحيحة %",
        data: stats.map(s => Math.round((s.correct / Math.max(1, s.attempts)) * 100)),
        backgroundColor: stats.map(s => {
          const p = (s.correct / Math.max(1, s.attempts)) * 100;
          return p >= 70 ? "rgba(28,131,101,.82)" : p >= 40 ? "rgba(185,139,58,.82)" : "rgba(168,50,42,.7)";
        }),
        borderRadius: 6,
        maxBarThickness: 40
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            title: items => {
              const s = stats[items[0].dataIndex];
              return `${s.qid} — ${s.topic}`;
            },
            label: c => {
              const s = stats[c.dataIndex];
              return `${c.parsed.y}% صحيحة (${s.correct}/${s.attempts})`;
            }
          }
        }
      },
      scales: {
        x: { grid: { display: false }, ticks: { font: chartFont(), color: "#3d5148" } },
        y: {
          beginAtZero: true, max: 100,
          ticks: { callback: v => v + "%", font: chartFont(), color: "#3d5148" },
          grid: { color: "rgba(0,0,0,.06)" }
        }
      }
    }
  });
}

function collectTopicStats(rows = activeRows()) {
  const map = new Map();
  rows.forEach(row => {
    const d = parseAnswers(row);
    (d.snapshot || []).forEach(q => {
      const topic = q.topic || "غير مصنّف";
      if (!map.has(topic)) map.set(topic, { attempts: 0, earned: 0, max: 0 });
      const rec = map.get(topic);
      rec.attempts += 1;
      rec.max += Number(q.points || 0);
      if (q.type === "mcq") {
        if (q.given && q.given === q.correct) rec.earned += Number(q.points || 0);
      } else {
        const det = (d.details || []).find(x => x.qid === q.qid);
        rec.earned += Number(det?.earned || 0);
      }
    });
  });
  return Array.from(map.entries())
    .map(([topic, v]) => ({ topic, ...v, pct: v.max ? (v.earned / v.max) * 100 : 0 }))
    .sort((a, b) => b.pct - a.pct);
}

function renderTopicChart(rows = activeRows()) {
  const stats = collectTopicStats(rows);
  const ctx = $("#chart-topics");
  if (!ctx) return;
  if (typeof Chart === "undefined") return;
  destroyChart("topics");
  if (!stats.length) return;

  A.charts.topics = new Chart(ctx, {
    type: "bar",
    data: {
      labels: stats.map(s => s.topic),
      datasets: [{
        label: "معدّل الإتقان %",
        data: stats.map(s => Math.round(s.pct)),
        backgroundColor: stats.map(s =>
          s.pct >= 70 ? "rgba(11,74,56,.85)" : s.pct >= 40 ? "rgba(185,139,58,.85)" : "rgba(168,50,42,.72)"),
        borderRadius: 6,
        maxBarThickness: 34
      }]
    },
    options: {
      indexAxis: "y",
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: c => {
              const s = stats[c.dataIndex];
              return `${c.parsed.x}% (${Math.round(s.earned)}/${s.max} نقطة)`;
            }
          }
        }
      },
      scales: {
        x: {
          beginAtZero: true, max: 100,
          ticks: { callback: v => v + "%", font: chartFont(), color: "#3d5148" },
          grid: { color: "rgba(0,0,0,.06)" }
        },
        y: { grid: { display: false }, ticks: { font: chartFont(), color: "#12211c" } }
      }
    }
  });
}

function renderInsights(rows, st) {
  const box = $("#dash-insights");
  if (!box) return;
  if (!rows.length) {
    box.innerHTML = `<p class="muted">لا توجد نسخ منجزة بعد في هذا النطاق. افتح تبويب «الجلسة والإطلاق»، أنشئ جلسة، ثم شارك رابط <a href="index.html">الاختبار</a> مع المترشحين.</p>`;
    return;
  }

  const stats = collectMcqStats(rows);
  const hardest = stats.filter(s => s.attempts > 0)
    .map(s => ({ ...s, pct: (s.correct / s.attempts) * 100 }))
    .sort((a, b) => a.pct - b.pct)[0];
  const easiest = stats.filter(s => s.attempts > 0)
    .map(s => ({ ...s, pct: (s.correct / s.attempts) * 100 }))
    .sort((a, b) => b.pct - a.pct)[0];

  const topics = collectTopicStats(rows);
  const weakTopic = topics[topics.length - 1];

  const items = [];
  items.push(`<p><b>النطاق:</b> ${esc(dashScopeLabel())} — ${st.n} نسخة منجزة. <b>نسبة النجاح:</b> ${st.passed} من ${st.n} (${Math.round(st.passRate)}%) بعتبة ${passMarkValue()}/100. المعدّل العام ${dashNum(st.avg)}/100.</p>`);
  if (hardest) {
    items.push(`<p><b>أصعب سؤال:</b> ${esc(hardest.qid)} — «${esc(hardest.topic)}» بنسبة إصابة ${Math.round(hardest.pct)}% (${hardest.correct}/${hardest.attempts}). يُستحسن تعزيز هذا المفهوم في الحصص القادمة.</p>`);
  }
  if (easiest && easiest.qid !== hardest?.qid) {
    items.push(`<p><b>أسهل سؤال:</b> ${esc(easiest.qid)} — «${esc(easiest.topic)}» بنسبة ${Math.round(easiest.pct)}%.</p>`);
  }
  if (weakTopic) {
    items.push(`<p><b>أضعف محور:</b> «${esc(weakTopic.topic)}» بمعدّل إتقان ${Math.round(weakTopic.pct)}%.</p>`);
  }
  const pending = rows.filter(r => r.status !== "validated").length;
  if (pending) {
    items.push(`<p><b>في انتظار التثبيت:</b> ${pending} نسخة تحتوي أجوبة تعبير يُستحسن مراجعتها يدويًّا من تبويب «النتائج».</p>`);
  }
  box.innerHTML = items.join("");
}

/* ==================================================================== RÉSULTATS */
function bindResults() {
  ["#f-search", "#f-form", "#f-sort", "#f-place-filter", "#f-session-filter"].forEach(sel => {
    const el = $(sel);
    if (!el) return;
    el.addEventListener("input", () => {
      A.filter.search = $("#f-search").value.trim();
      A.filter.form = $("#f-form").value;
      A.filter.sort = $("#f-sort").value;
      A.filter.place = $("#f-place-filter") ? $("#f-place-filter").value : "";
      A.filter.session = $("#f-session-filter") ? $("#f-session-filter").value : "";
      renderResults();
    });
  });
  $("#btn-csv").addEventListener("click", exportCsv);
  $("#btn-xlsx").addEventListener("click", exportXlsx);
}

function sessionLabel(id) {
  if (!id) return "";
  if (A.launch && A.launch.id === id) return A.launch.label || "";
  const s = (A.sessions || []).find(x => x.id === id);
  return s ? s.label : "جلسة سابقة";
}

function rowPlaceText(r) {
  return placeLabel(r.place_code, r.place_name);
}

/* تعبئة مرشّحات المكان والجلسة دون إعادة بنائها في كل تحديث */
function fillResultFilters() {
  const placeSel = $("#f-place-filter");
  if (placeSel) {
    const codes = PLACE_LIST.map(p => p.code);
    activeRows().forEach(r => {
      if (r.place_code && !codes.includes(String(r.place_code))) codes.push(String(r.place_code));
    });
    const sig = codes.join("|");
    if (placeSel.dataset.sig !== sig) {
      placeSel.innerHTML = `<option value="">كل الأماكن</option>` + codes.map(c => {
        const nm = (PLACE_LIST.find(p => p.code === c) || {}).name || "";
        return `<option value="${esc(c)}">${esc(placeLabel(c, nm))}</option>`;
      }).join("");
      placeSel.dataset.sig = sig;
    }
    if (A.filter.place && !codes.includes(A.filter.place)) A.filter.place = "";
    placeSel.value = A.filter.place;
  }

  const sessSel = $("#f-session-filter");
  if (sessSel) {
    const list = (A.sessions || []).slice();
    if (A.launch && !list.some(s => s.id === A.launch.id)) list.unshift(A.launch);
    const sig = list.map(s => s.id + ":" + (s.label || "")).join("|");
    if (sessSel.dataset.sig !== sig) {
      sessSel.innerHTML = `<option value="">كل الجلسات</option>` + list.map(s =>
        `<option value="${esc(s.id)}">${esc(s.label || "جلسة")}</option>`
      ).join("");
      sessSel.dataset.sig = sig;
    }
    if (A.filter.session && !list.some(s => s.id === A.filter.session)) A.filter.session = "";
    sessSel.value = A.filter.session;
  }
}

function filteredRows() {
  let rows = activeRows().slice();
  const q = A.filter.search.toLowerCase();
  if (q) {
    rows = rows.filter(r =>
      `${r.candidate_first} ${r.candidate_last} ${rowPlaceText(r)} ${sessionLabel(r.session_id)}`.toLowerCase().includes(q));
  }
  if (A.filter.form) rows = rows.filter(r => r.form === A.filter.form);
  if (A.filter.place) rows = rows.filter(r => String(r.place_code || "") === A.filter.place);
  if (A.filter.session) rows = rows.filter(r => r.session_id === A.filter.session);

  switch (A.filter.sort) {
    case "score-desc": rows.sort((a, b) => Number(b.final_score || 0) - Number(a.final_score || 0)); break;
    case "score-asc": rows.sort((a, b) => Number(a.final_score || 0) - Number(b.final_score || 0)); break;
    case "name": rows.sort((a, b) => `${a.candidate_last}${a.candidate_first}`.localeCompare(`${b.candidate_last}${b.candidate_first}`, "ar")); break;
    default: rows.sort((a, b) => new Date(b.finished_at || 0) - new Date(a.finished_at || 0));
  }
  return rows;
}

function renderResults() {
  const host = $("#results-table");
  const rows = filteredRows();

  if (!rows.length) {
    host.innerHTML = `<div class="table-empty">لا توجد نسخ مطابقة. ${
      activeRows().length ? "جرّب مسح عوامل التصفية." : "لم يُنجز أي مترشح الاختبار بعد."
    }</div>`;
    return;
  }

  const trs = rows.map((r, i) => {
    const pct = r.percent != null ? Number(r.percent) : Number(r.final_score || 0);
    const formLabel = (A.bank.forms[r.form] || {}).label || r.form;
    const st = r.status === "validated"
      ? `<span class="badge badge-ok">مثبّتة</span>`
      : (r.official
        ? `<span class="badge badge-warn">آلية</span>`
        : `<span class="badge badge-neutral">بانتظار التصحيح</span>`);
    const scoreCell = r.official
      ? `<span class="score-pill ${scoreClass(pct)}">${Math.round(pct * 10) / 10}</span>`
      : "—";
    const codeCell = r.code_hash
      ? `<span class="small muted" title="بصمة رمز المترشح">${esc(String(r.code_hash).slice(0, 6))}</span>`
      : "";
    return `<tr>
      <td class="num">${i + 1}</td>
      <td><b>${esc(r.candidate_first)} ${esc(r.candidate_last)}</b>${codeCell ? " " + codeCell : ""}</td>
      <td class="nowrap">${esc(rowPlaceText(r))}</td>
      <td class="num">${esc(formLabel)}</td>
      <td class="num">${r.mcq_score == null ? "—" : esc(Number(r.mcq_score))}</td>
      <td class="num">${r.open_score == null ? "—" : esc(Number(r.open_score))}</td>
      <td class="num">${scoreCell}</td>
      <td class="num nowrap">${esc(fmtDate(r.finished_at))}</td>
      <td class="num">${st}</td>
      <td class="nowrap">
        <button class="btn btn-sm btn-soft" data-open="${esc(r.id)}">تفاصيل</button>
        <button class="btn btn-sm btn-danger" data-del="${esc(r.id)}" title="حذف">✕</button>
      </td>
    </tr>`;
  }).join("");

  host.innerHTML = `<div class="table-scroll"><table class="data">
    <thead><tr>
      <th class="num">#</th><th>الاسم الكامل</th><th>المكان</th><th class="num">النموذج</th>
      <th class="num">اختيارات/60</th><th class="num">تعبير/40</th><th class="num">المجموع</th>
      <th class="num">التاريخ</th><th class="num">الحالة</th><th>إجراءات</th>
    </tr></thead><tbody>${trs}</tbody></table></div>`;

  $$("[data-open]").forEach(b => b.addEventListener("click", () => openDetail(b.dataset.open)));
  $$("[data-del]").forEach(b => b.addEventListener("click", () => removeRow(b.dataset.del)));
}

async function removeRow(id) {
  const row = A.rows.find(r => r.id === id);
  if (!row) return;
  const name = `${row.candidate_first} ${row.candidate_last}`.trim();
  if (!confirm(`حذف نسخة «${name}» نهائيًّا؟ لا يمكن الرجوع في هذه العملية.`)) return;
  try {
    await Store.deleteSubmission(id);
    A.rows = A.rows.filter(r => r.id !== id);
    updatePanelSub(); renderSession(); fillResultFilters();
    renderResults(); renderDash();
    toast("حُذفت النسخة");
  } catch (e) {
    toast("تعذّر الحذف", true);
  }
}

/* ---------------------------------------------------------------- détail + notation */
function openDetail(id) {
  const row = A.rows.find(r => r.id === id);
  if (!row) return;
  const g = regrade(row);
  const fm = formMax((A.bank.forms && A.bank.forms[row.form]) || {});
  g.mcqMax = fm.mcq || g.mcqMax || 0;
  g.openMax = fm.open || g.openMax || 0;
  g.totalMax = fm.total || g.totalMax || 0;
  if (!g.totalMax) g.totalMax = (g.mcqMax || 0) + (g.openMax || 0) || 100;
  const data = g.data;
  const snap = g.snap;

  const items = snap.map((q, i) => {
    const det = (data.details || []).find(x => x.qid === q.qid) || {};
    if (q.type === "mcq") {
      const ok = q.given && q.given === q.correct;
      const givenTxt = (q.options || []).find(o => o.id === q.given)?.text || "—";
      const correctTxt = (q.options || []).find(o => o.id === q.correct)?.text || "—";
      return `<div class="review-item ${ok ? "ok" : "ko"}">
        <div class="head">
          <div><div class="small muted">${i + 1}. ${esc(q.topic)}</div><div class="qt">${esc(q.text)}</div></div>
          <span class="score-pill ${ok ? "good" : "bad"}">${ok ? q.points : 0}/${q.points}</span>
        </div>
        <div class="answer-line ${ok ? "correct" : "wrong"}"><b>جوابه:</b> ${esc(givenTxt)}</div>
        ${ok ? "" : `<div class="answer-line correct"><b>الصحيح:</b> ${esc(correctTxt)}</div>`}
      </div>`;
    }
    const rubric = (q.rubric || []).map(r => {
      const got = (det.rubric || []).find(x => x.id === r.id);
      return `<li>${esc(r.label)} — ${got ? got.earned : 0}/${r.points}</li>`;
    }).join("");
    return `<div class="review-item pend">
      <div class="head">
        <div><div class="small muted">${i + 1}. ${esc(q.topic)} — تعبير</div><div class="qt">${esc(q.text)}</div></div>
        <span class="score-pill mid">${det.earned ?? 0}/${q.points}</span>
      </div>
      <div class="answer-line given" style="white-space:pre-wrap">${esc(q.openText) || "<i>لم يُجب.</i>"}</div>
      <div class="quote-block" style="margin-top:8px"><b>الإجابة النموذجية:</b> ${esc(q.modelAnswer || "")}</div>
      ${rubric ? `<ul class="small muted" style="margin:8px 0 0;padding-inline-start:20px">${rubric}</ul>` : ""}
    </div>`;
  }).join("");

  const root = $("#modal-root");
  root.innerHTML = `<div class="modal-backdrop" id="backdrop">
    <div class="modal" role="dialog" aria-modal="true" aria-labelledby="m-title">
      <div class="modal-head">
        <div>
          <h2 id="m-title" style="margin:0;font-size:1.2rem">${esc(row.candidate_first)} ${esc(row.candidate_last)}</h2>
          <p class="small muted" style="margin:4px 0 0">
            ${esc((A.bank.forms[row.form] || {}).label || row.form)}${rowPlaceText(row) !== "—" ? " · " + esc(rowPlaceText(row)) : ""}${row.session_id ? " · " + esc(sessionLabel(row.session_id)) : ""} · ${esc(fmtDate(row.finished_at))} · المدة ${esc(fmtDuration(row.duration_sec))}
          </p>
        </div>
        <button class="modal-close" type="button" id="m-close" aria-label="إغلاق">✕</button>
      </div>

      <div class="kpi-grid" style="margin-bottom:14px">
        <div class="kpi"><div class="k">المجموع</div><div class="v">${Number(row.final_score) || 0}<small>/${g.totalMax}</small></div></div>
        <div class="kpi"><div class="k">الاختيارات</div><div class="v">${Number(row.mcq_score) || 0}<small>/${g.mcqMax}</small></div></div>
        <div class="kpi"><div class="k">التعبير</div><div class="v">${Number(row.open_score) || 0}<small>/${g.openMax}</small></div></div>
      </div>

      <form id="grade-form">
        <div class="rule-box small" style="margin-bottom:12px">
          نقطة التعبير الآلية احتياطية. عدّلها يدويًّا حسب سلّم التنقيط، ثمّ ثبّت النسخة.
        </div>
        <div class="field-row">
          <label class="field">
            <span>نقطة التعبير (من ${g.openMax})</span>
            <input type="number" id="g-open" min="0" max="${g.openMax}" step="1" value="${Number(row.open_score || 0)}">
          </label>
          <label class="field">
            <span>ملاحظة المشرف</span>
            <input type="text" id="g-note" maxlength="200" value="${esc(row.graded_note || "")}" placeholder="اختياري">
          </label>
        </div>
        <div class="btn-row" style="margin-bottom:18px">
          <button class="btn" type="submit">حفظ وتثبيت النقطة</button>
          <button class="btn btn-ghost" type="button" id="m-print">طبع / PDF</button>
        </div>
      </form>

      <h3 style="font-size:1rem">أجوبته وتصحيحها</h3>
      <div>${items}</div>
    </div>
  </div>`;

  $("#m-close").addEventListener("click", closeModal);
  $("#backdrop").addEventListener("click", ev => { if (ev.target.id === "backdrop") closeModal(); });
  $("#m-print").addEventListener("click", () => {
    document.body.classList.add("printing-detail");
    const cleanup = () => { document.body.classList.remove("printing-detail"); window.removeEventListener("afterprint", cleanup); };
    window.addEventListener("afterprint", cleanup);
    setTimeout(cleanup, 15000);
    window.print();
  });
  $("#grade-form").addEventListener("submit", async ev => {
    ev.preventDefault();
    const openMax = g.openMax || 40;
    const openScore = Math.max(0, Math.min(openMax, Number($("#g-open").value || 0)));
    const note = $("#g-note").value.trim();
    const mcq = Number(row.mcq_score || 0);
    const totalMax = g.totalMax || (mcq + openMax) || 100;
    const patch = {
      open_score: openScore,
      final_score: Math.round((mcq + openScore) * 10) / 10,
      percent: Math.round(((mcq + openScore) / totalMax) * 1000) / 10,
      status: "validated",
      graded_by: "manual",
      official: true,
      official_at: new Date().toISOString(),
      graded_note: note
    };
    try {
      await Store.updateSubmission(row.id, patch);
      A.rows = await Store.listSubmissions();
      updatePanelSub();
      renderSession();
      renderDash();
      renderResults();
      closeModal();
      toast("ثُبّتت النقطة");
    } catch (e) {
      toast("تعذّر الحفظ", true);
    }
  });
}

function closeModal() {
  $("#modal-root").innerHTML = "";
}

/* ------------------------------------------------------------------ exports */
function exportRows() {
  const rows = filteredRows();
  return rows.map((r, i) => ({
    "الرقم": i + 1,
    "الاسم العائلي": r.candidate_last || "",
    "الاسم الشخصي": r.candidate_first || "",
    "رمز المكان": r.place_code || "",
    "المكان": rowPlaceText(r) === "—" ? "" : rowPlaceText(r),
    "النموذج": (A.bank.forms[r.form] || {}).label || r.form || "",
    "الجلسة": sessionLabel(r.session_id),
    "نقطة الاختيارات /60": Number(r.mcq_score || 0),
    "نقطة التعبير /40": Number(r.open_score || 0),
    "المجموع /100": Number(r.final_score || 0),
    "النسبة %": Number(r.percent || 0),
    "المدة": fmtDuration(r.duration_sec),
    "تاريخ الإنهاء": fmtDate(r.finished_at),
    "الحالة": r.status === "validated" ? "مثبّتة" : "آلية",
    "ملاحظة": r.graded_note || ""
  }));
}

function csvCell(v) {
  let s = String(v == null ? "" : v);
  /* منع حقن صيغ Excel: تحييد الخلايا التي تبدأ بـ = + - @ أو بTab/CR */
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return '"' + s.replace(/"/g, '""') + '"';
}

function download(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

function stamp() {
  const d = new Date();
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
}

function exportCsv() {
  const rows = exportRows();
  if (!rows.length) { toast("لا توجد بيانات للتصدير", true); return; }
  const headers = Object.keys(rows[0]);
  const csv = [headers.join(",")].concat(
    rows.map(r => headers.map(h => csvCell(r[h])).join(","))
  ).join("\r\n");
  /* BOM : garantit l'affichage correct de l'arabe dans Excel */
  download(new Blob(["\uFEFF" + csv], { type: "text/csv;charset=utf-8;" }), `نتائج-الاختبار-${stamp()}.csv`);
  toast("تمّ تصدير CSV");
}

function exportXlsx() {
  const rows = exportRows();
  if (!rows.length) { toast("لا توجد بيانات للتصدير", true); return; }
  if (typeof XLSX === "undefined") {
    toast("تعذّر تحميل مكتبة Excel — سيتمّ تصدير CSV", true);
    exportCsv();
    return;
  }
  const headers = Object.keys(rows[0]);
  const aoa = [headers].concat(rows.map(r => headers.map(h => r[h])));
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  ws["!cols"] = headers.map((h, i) => ({ wch: i <= 2 ? 20 : Math.max(12, h.length + 4) }));
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "النتائج");

  /* ورقة إحصاء الأسئلة (كما في النسخة 2: تحليلي لكل سؤال) */
  const qstats = collectMcqStats();
  const ws3 = XLSX.utils.aoa_to_sheet([["السؤال", "المحور", "النقاط", "المحاولات", "صحيحة", "النسبة %"]].concat(
    qstats.map(s => [s.qid, s.topic, s.points, s.attempts, s.correct,
      s.attempts ? Math.round((s.correct / s.attempts) * 1000) / 10 : 0])
  ));
  ws3["!cols"] = [{ wch: 10 }, { wch: 28 }, { wch: 8 }, { wch: 10 }, { wch: 8 }, { wch: 10 }];
  XLSX.utils.book_append_sheet(wb, ws3, "إحصاء الأسئلة");

  /* ورقة إتقان المحاور */
  const tstats = collectTopicStats();
  const ws4 = XLSX.utils.aoa_to_sheet([["المحور", "المحاولات", "المكتسب /", "الأقصى", "الإتقان %"]].concat(
    tstats.map(t => [t.topic, t.attempts, Math.round(t.earned), t.max, Math.round(t.pct * 10) / 10])
  ));
  ws4["!cols"] = [{ wch: 30 }, { wch: 10 }, { wch: 10 }, { wch: 8 }, { wch: 12 }];
  XLSX.utils.book_append_sheet(wb, ws4, "إتقان المحاور");

  /* ورقة تحليل حسب المكان (المحطات) */
  const passMark = Number(A.settings.passMark || 50);
  const byPlace = new Map();
  rows.forEach(r => {
    const key = r["المكان"] || "غير محدد";
    const g = byPlace.get(key) || { n: 0, sum: 0, max: -Infinity, min: Infinity, pass: 0 };
    const sc = Number(r["المجموع /100"] || 0);
    g.n++;
    g.sum += sc;
    g.max = Math.max(g.max, sc);
    g.min = Math.min(g.min, sc);
    if (sc >= passMark) g.pass++;
    byPlace.set(key, g);
  });
  const placeRows = Array.from(byPlace.entries())
    .sort((a, b) => (b[1].sum / b[1].n) - (a[1].sum / a[1].n))
    .map(([name, g]) => [name, g.n, Math.round((g.sum / g.n) * 10) / 10,
      g.max, g.min, g.pass, Math.round((g.pass / g.n) * 1000) / 10]);
  const ws5 = XLSX.utils.aoa_to_sheet([["المكان", "العدد", "المعدّل /100", "أعلى نقطة", "أدنى نقطة", "الناجحون", "نسبة النجاح %"]].concat(placeRows));
  ws5["!cols"] = [{ wch: 28 }, { wch: 8 }, { wch: 12 }, { wch: 10 }, { wch: 10 }, { wch: 10 }, { wch: 14 }];
  XLSX.utils.book_append_sheet(wb, ws5, "حسب المكان");

  /* feuille de synthèse */
  const scores = rows.map(r => r["المجموع /100"]);
  const avg = scores.reduce((a, b) => a + b, 0) / scores.length;
  const summary = [
    ["ملخّص", ""],
    ["عدد المترشحين", rows.length],
    ["المعدّل العام /100", Math.round(avg * 10) / 10],
    ["أعلى نقطة", Math.max(...scores)],
    ["أدنى نقطة", Math.min(...scores)],
    ["عتبة النجاح", A.settings.passMark || 50],
    ["عدد الناجحين", scores.filter(s => s >= (A.settings.passMark || 50)).length],
    ["تاريخ التصدير", new Date().toLocaleString("ar")],
    ["المرجع", A.bank.meta.reference]
  ];
  const ws2 = XLSX.utils.aoa_to_sheet(summary);
  ws2["!cols"] = [{ wch: 24 }, { wch: 44 }];
  XLSX.utils.book_append_sheet(wb, ws2, "ملخّص");

  XLSX.writeFile(wb, `نتائج-الاختبار-${stamp()}.xlsx`);
  toast("تمّ تصدير ملف Excel");
}

/* ==================================================================== QUESTIONS */
function bindBank() {
  $("#bank-form").addEventListener("change", ev => {
    try { readEditors(); } catch (e) { /* ignore */ }
    A.editForm = ev.target.value;
    renderQuestions();
  });

  $("#btn-save-bank").addEventListener("click", saveBankFromUi);

  $("#btn-reset-bank").addEventListener("click", async () => {
    if (!confirm("استرجاع النسخة الأصلية للأسئلة؟ ستُفقد التعديلات الحالية على بنك الأسئلة (النسخ المسجّلة تُحفظ).")) return;
    A.bank = await Store.resetBank();
    renderQuestions();
    toast("استُرجعت النسخة الأصلية");
  });

  $$("[data-add]").forEach(b => b.addEventListener("click", () => addQuestion(b.dataset.add)));
}

function currentForm() {
  return A.bank.forms[A.editForm];
}

function bankTotal(formObj) {
  return formObj.questions.reduce((s, q) => s + Number(q.points || 0), 0);
}

function renderQuestions() {
  const form = currentForm();
  const total = bankTotal(form);
  $("#bank-meta").textContent = `آخر تحديث: ${A.bank.updatedAt || "—"} · ${form.questions.length} سؤالًا`;
  $("#bank-total").textContent = total;
  $("#bank-total").style.color = total === 100 ? "var(--ok)" : "var(--danger)";

  const host = $("#q-list");
  host.innerHTML = "";

  form.questions.forEach((q, qi) => {
    const det = document.createElement("details");
    det.className = "q-editor";
    det.dataset.qid = q.id;
    det.open = false;

    const summary = document.createElement("summary");
    summary.innerHTML =
      `<span>${qi + 1}. <span class="badge ${q.type === "mcq" ? "badge-neutral" : "badge-gold"}" style="margin-inline-end:6px">${
        q.type === "mcq" ? "اختيار" : "تعبير"
      }</span>${esc(q.topic)}</span>
      <span class="small muted nowrap">${q.points} نقطة</span>`;
    det.appendChild(summary);

    const body = document.createElement("div");
    body.className = "body";
    body.innerHTML = buildEditorHtml(q, qi);
    det.appendChild(body);
    host.appendChild(det);
  });

  bindEditorEvents();
}

function buildEditorHtml(q, qi) {
  let h = `
    <div class="field-row">
      <label class="field"><span>المحور / المفهوم</span>
        <input type="text" data-f="topic" value="${esc(q.topic)}"></label>
      <label class="field"><span>النقطة</span>
        <input type="number" data-f="points" min="0" max="100" step="1" value="${Number(q.points)}"></label>
    </div>
    <label class="field"><span>نصّ السؤال</span>
      <textarea data-f="text" rows="2">${esc(q.text)}</textarea></label>`;

  if (q.type === "mcq") {
    h += `<div class="field"><span style="display:block;font-size:.9rem;font-weight:600;margin-bottom:6px">
        الاختيارات (حدّد الصحيح)</span>`;
    q.options.forEach((o, oi) => {
      h += `<div class="opt-edit">
        <input type="radio" name="correct-${esc(q.id)}" data-opt="${esc(o.id)}" ${q.correct === o.id ? "checked" : ""} aria-label="الجواب الصحيح">
        <input type="text" data-opt-text="${esc(o.id)}" value="${esc(o.text)}" placeholder="نصّ الاختيار ${oi + 1}">
        <span class="lbl">${["أ", "ب", "ج", "د"][oi] || oi + 1}</span>
      </div>`;
    });
    h += `</div>
      <label class="field"><span>التوضيح بعد التصحيح</span>
        <textarea data-f="explain" rows="3">${esc(q.explain || "")}</textarea></label>`;
  } else {
    h += `<label class="field"><span>الإجابة النموذجية</span>
        <textarea data-f="modelAnswer" rows="4">${esc(q.modelAnswer || "")}</textarea></label>
      <label class="field"><span>سلّم التنقيط (سطر لكل عنصر: النقطة|الوصف|كلمات مفتاحية مفصولة بفاصلة)</span>
        <textarea data-f="rubric" rows="5" dir="ltr" style="font-family:ui-monospace,monospace;font-size:.85rem">${
          esc((q.rubric || []).map(r => `${Number(r.points) || 0}|${r.label || ""}|${(r.keywords || []).join(",")}`).join("\n"))
        }</textarea></label>`;
  }

  h += `<div class="btn-row" style="margin-top:8px">
      <button class="btn btn-sm btn-danger" type="button" data-remove="${esc(q.id)}">حذف السؤال</button>
    </div>`;
  return h;
}

function bindEditorEvents() {
  $$("[data-remove]").forEach(b => {
    b.addEventListener("click", () => {
      const qid = b.dataset.remove;
      if (!confirm("حذف هذا السؤال من النموذج؟")) return;
      const form = currentForm();
      form.questions = form.questions.filter(q => q.id !== qid);
      renderQuestions();
      toast("حُذف السؤال — لم يُحفظ بعد");
    });
  });
}

function readEditors() {
  const form = currentForm();
  $$("#q-list details.q-editor").forEach(det => {
    const qid = det.dataset.qid;
    const q = form.questions.find(x => x.id === qid);
    if (!q) return;

    const topic = det.querySelector('[data-f="topic"]');
    const points = det.querySelector('[data-f="points"]');
    const text = det.querySelector('[data-f="text"]');

    if (topic) q.topic = topic.value.trim();
    if (points) q.points = Math.max(0, Number(points.value || 0));
    if (text) q.text = text.value.trim();

    if (q.type === "mcq") {
      const explain = det.querySelector('[data-f="explain"]');
      if (explain) q.explain = explain.value.trim();

      const checked = det.querySelector('input[type="radio"]:checked');
      if (checked) q.correct = checked.dataset.opt;

      det.querySelectorAll("[data-opt-text]").forEach(inp => {
        const o = q.options.find(x => x.id === inp.dataset.optText);
        if (o) o.text = inp.value.trim();
      });
    } else {
      const ma = det.querySelector('[data-f="modelAnswer"]');
      const rb = det.querySelector('[data-f="rubric"]');
      if (ma) q.modelAnswer = ma.value.trim();
      if (rb) {
        q.rubric = rb.value.split("\n").map((line, i) => {
          const parts = line.split("|");
          if (!parts[0] && !parts[1]) return null;
          return {
            id: (q.rubric[i] && q.rubric[i].id) || `r${i + 1}`,
            points: Math.max(0, Number(parts[0] || 0)),
            label: (parts[1] || "").trim(),
            keywords: (parts[2] || "").split(",").map(s => s.trim()).filter(Boolean)
          };
        }).filter(Boolean);
      }
    }
  });
}

async function saveBankFromUi() {
  readEditors();
  const form = currentForm();
  const total = bankTotal(form);
  const problem = validateForm(form);
  if (problem) { toast(problem, true); return; }

  try {
    A.bank = await Store.saveBank(A.bank);
    renderQuestions();
    renderDash();
    toast(total === 100
      ? "حُفظ بنك الأسئلة"
      : `حُفظ، لكن المجموع ${total} بدل 100`, total !== 100);
  } catch (e) {
    toast("تعذّر الحفظ", true);
  }
}

function validateForm(form) {
  for (const q of form.questions) {
    if (!q.text || q.text.length < 5) return `السؤال «${q.topic}» بلا نصّ صحيح.`;
    if (!q.topic) return "كل سؤال يحتاج محورًا.";
    if (q.type === "mcq") {
      if (!q.correct) return `لم تحدّد الجواب الصحيح في «${q.topic}».`;
      if (q.options.some(o => !o.text)) return `اختيار فارغ في «${q.topic}».`;
    } else if (!q.modelAnswer) {
      return `السؤال التعبيري «${q.topic}» بلا إجابة نموذجية.`;
    }
  }
  return null;
}

function addQuestion(type) {
  readEditors();
  const form = currentForm();
  const n = form.questions.length + 1;
  const id = `${A.editForm}${Date.now().toString(36).slice(-4)}`;
  const base = {
    id,
    type,
    topic: type === "mcq" ? "محور جديد" : "محور جديد",
    points: type === "mcq" ? 5 : 20,
    text: ""
  };
  if (type === "mcq") {
    form.questions.push({
      ...base,
      options: [{ id: "a", text: "" }, { id: "b", text: "" }, { id: "c", text: "" }, { id: "d", text: "" }],
      correct: "a",
      explain: ""
    });
  } else {
    form.questions.push({
      ...base,
      modelAnswer: "",
      rubric: [{ id: "r1", points: 10, label: "", keywords: [] }]
    });
  }
  renderQuestions();
  const last = $("#q-list").lastElementChild;
  if (last) { last.open = true; last.scrollIntoView({ behavior: "smooth", block: "center" }); }
  toast(`أُضيف سؤال رقم ${n} — أكمل تحريره ثمّ احفظ`);
}

/* ==================================================================== SETTINGS */
function fillSettings() {
  const s = A.settings;
  $("#s-mcq").value = s.mcqSeconds;
  $("#s-open").value = s.openSeconds;
  $("#s-mode").value = s.formMode;
  $("#s-pass").value = s.passMark;
  $("#s-minwords").value = s.minWords;
  $("#s-institution").value = s.institution || "";
}

function bindSettings() {
  $("#settings-form").addEventListener("submit", async ev => {
    ev.preventDefault();
    const next = {
      mcqSeconds: Math.max(10, Number($("#s-mcq").value || 45)),
      openSeconds: Math.max(30, Number($("#s-open").value || 180)),
      formMode: $("#s-mode").value,
      passMark: Math.max(0, Math.min(100, Number($("#s-pass").value || 50))),
      minWords: Math.max(0, Number($("#s-minwords").value || 8)),
      institution: $("#s-institution").value.trim()
    };
    try {
      A.settings = await Store.saveSettings(next);
      renderDash();
      toast("حُفظت الإعدادات");
    } catch (e) {
      toast("تعذّر الحفظ", true);
    }
  });
}

/* ============================================================ CLOUD SYNC */
const CLOUD_LS_KEY = "manhaj_cloud_url_v1";

function cloudUrlFromInput() {
  const el = $("#cloud-url");
  return (el ? el.value : "").trim().replace(/\/+$/, "");
}

function renderCloudState() {
  const input = $("#cloud-url");
  if (!input) return;
  const override = localStorage.getItem("manhaj_cloud_override_v1") === "1";
  const stored = (override && localStorage.getItem(CLOUD_LS_KEY)) ||
    ((window.MANHAJ_CONFIG && window.MANHAJ_CONFIG.firebaseUrl) || "") ||
    localStorage.getItem(CLOUD_LS_KEY) || "";
  if (!input.value) input.value = stored;
  const active = Store.getMode() === "cloud";
  const badge = $("#cloud-badge");
  if (badge) {
    badge.textContent = active ? "مفعّل" : "غير مفعّل";
    badge.className = "badge " + (active ? "badge-ok" : "badge-warn");
  }
  const note = $("#cloud-note");
  if (note) {
    note.textContent = active
      ? "المزامنة مفعّلة تلقائيًا: الجلسة وقائمة الانتظار والنتائج تظهر على كل الهواتف بدون نسخ أي رابط."
      : "المزامنة غير مفعّلة: الجلسة محفوظة في هذا الهاتف فقط. تحقّق من الرابط أعلاه أو من الاتصال.";
  }
  const qr = $("#cloud-qr");
  if (qr) {
    const link = candidateLink();
    qr.src = "https://api.qrserver.com/v1/create-qr-code/?size=180x180&data=" + encodeURIComponent(link);
    qr.alt = "رمز QR لرابط المترشحين";
  }
}

function candidateLink() {
  const url = new URL("index.html", location.href);
  /* الرابط المدمج في config.js يعمل تلقائيًا؛ لا حاجة لإضافة ?db= */
  return url.href;
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch (e) {
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      ta.remove();
      return true;
    } catch (e2) {
      return false;
    }
  }
}

function bindCloudSettings() {
  const save = $("#btn-cloud-save");
  if (!save) return;

  save.addEventListener("click", () => {
    const url = cloudUrlFromInput();
    if (!/^https:\/\/[^/]+$/i.test(url)) {
      toast("رابط Firebase غير صالح — يجب أن يبدأ بـ https:// وبلا مسار", true);
      return;
    }
    try { Store.setCloudUrl(url); }
    catch (e) { toast("رابط Firebase غير صالح", true); return; }
    toast("تم حفظ الرابط لهذا الجهاز — إعادة تحميل…");
    setTimeout(() => location.reload(), 700);
  });

  $("#btn-cloud-test").addEventListener("click", async () => {
    const url = cloudUrlFromInput();
    if (!/^https:\/\/[^/]+$/i.test(url)) {
      toast("أدخل رابط Firebase صالحًا أولًا", true);
      return;
    }
    const btn = $("#btn-cloud-test");
    btn.disabled = true;
    try {
      const res = await fetch(`${url}/.json?shallow=true`, { cache: "no-store" });
      if (res.status === 401 || res.status === 403) throw new Error("accès refusé");
      if (!res.ok && res.status !== 404) throw new Error(`HTTP ${res.status}`);
      toast("الاتصال بقاعدة Firebase ناجح");
    } catch (e) {
      toast("تعذّر الاتصال: تحقّق من الرابط ومن قواعد القراءة/الكتابة", true);
    } finally {
      btn.disabled = false;
    }
  });

  $("#btn-cloud-copy").addEventListener("click", async () => {
    const link = candidateLink();
    if (await copyText(link)) toast("نُسخ رابط المترشحين — وزّعه على الهواتف");
    else prompt("انسخ رابط المترشحين:", link);
  });

  renderCloudState();
}

/* ============================================================ SESSION / LANCEMENT */
function bindSession() {
  $("#btn-create-session").addEventListener("click", createSession);
  $("#btn-launch").addEventListener("click", launchNow);
  $("#btn-close-session").addEventListener("click", closeSession);
  $("#btn-refresh-waiting").addEventListener("click", () => refreshSessionData(true, true));
}

function stopSessionTimer() {
  if (A.sessionTimer) { clearInterval(A.sessionTimer); A.sessionTimer = null; }
}

function startSessionTimer() {
  stopSessionTimer();
  /* تحديث خفيف لقائمة الانتظار والعدّادات كل 4 ثوانٍ */
  A.sessionTimer = setInterval(() => refreshSessionData(false), 4000);
}

function snapshotFromBank(formObj, graded) {
  return (formObj.questions || []).map(q => {
    const d = (graded.details || []).find(x => x.qid === q.id) || {};
    if (q.type === "mcq") {
      return {
        qid: q.id, type: "mcq", topic: q.topic, points: q.points, text: q.text,
        options: (q.options || []).map(o => ({ id: o.id, text: o.text })),
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
}

/* تصحيح تلقائي لمن بدأ الاختبار ثم أغلق هاتفه/غادر قبل الإنهاء.
   يعتمد على التقدّم الذي يحفظه المترشح في السحابة كل 12 ثانية. */
async function finalizeAbandoned(sessionId) {
  if (!sessionId) return 0;
  if (A.finalizedSessions[sessionId]) return 0;
  A.finalizedSessions[sessionId] = true;
  let done = 0;
  try {
    const rows = await Store.listSubmissions();
    const targets = rows.filter(r =>
      r && r.session_id === sessionId && r.status === "waiting" &&
      r.started_at && !r.finished_at
    );
    for (const r of targets) {
      try {
        let p = {};
        try { p = r.progress ? JSON.parse(r.progress) : {}; } catch (e) { p = {}; }
        const formKey = r.form || p.form || "A";
        const formObj = A.bank && A.bank.forms && A.bank.forms[formKey];
        if (!formObj || !Array.isArray(formObj.questions) || !formObj.questions.length) continue;
        const graded = gradePaper(formObj, p.answers || {});
        const started = p.startedAt || r.started_at;
        const finishedAt = new Date().toISOString();
        const duration = started ? Math.max(0, Math.round((Date.now() - new Date(started).getTime()) / 1000)) : 0;
        const settings = A.settings || {};
        const rec = {
          ...r,
          id: r.id,
          form: formKey,
          started_at: started,
          finished_at: finishedAt,
          duration_sec: duration,
          mcq_score: graded.mcq,
          open_score: graded.open,
          final_score: graded.total,
          percent: graded.percent,
          status: "auto",
          graded_note: p.answers
            ? "تصحيح تلقائي بعد انتهاء الجلسة"
            : "تصحيح تلقائي — لم تُحفظ أي إجابة",
          graded_by: "auto",
          official: true,
          official_at: finishedAt,
          progress: null,
          progress_at: null,
          finalized_auto: true,
          answers: JSON.stringify({
            bankVersion: A.bank.version,
            form: formKey,
            sessionId,
            deviceId: r.device_id,
            details: graded.details,
            snapshot: snapshotFromBank(formObj, graded),
            settings: { mcqSeconds: settings.mcqSeconds, openSeconds: settings.openSeconds },
            finalizedAuto: true
          })
        };
        await Store.updateSubmission(r.id, rec);
        done++;
      } catch (e) {
        console.warn("finalizeAbandoned row failed", r.id, e);
      }
    }
  } catch (e) {
    console.warn("finalizeAbandoned failed", e);
  }
  if (done) {
    try {
      A.rows = await Store.listSubmissions();
      syncSeenResults(false);
      updatePanelSub();
      fillResultFilters();
      renderSession();
      renderResults();
      renderDash();
      toast(`تمّ تصحيح ${done} نسخة تلقائيًا بعد إغلاق الجلسة`);
    } catch (e) { /* ignore */ }
  }
  return done;
}

/* ========================================================= التصحيح الرسمي
   النقط لا يكتبها المترشح إطلاقًا (قواعد Firebase تمنع ذلك).
   هنا يعيد المشرف حساب النقط من بنك الأسئلة — وهو المصدر الموثوق —
   اعتمادًا على أجوبة المترشح، ثم ينشرها في نسخته. */
function officialGrade(row) {
  const formKey = row.form || "A";
  const formObj = A.bank && A.bank.forms && A.bank.forms[formKey];
  if (!formObj || !Array.isArray(formObj.questions) || !formObj.questions.length) return null;
  const data = parseAnswers(row);
  const details = Array.isArray(data.details) ? data.details : [];
  /* نعيد بناء أجوبة المترشح من تفاصيل نسخته */
  const answers = {};
  formObj.questions.forEach(q => {
    const d = details.find(x => x.qid === q.id);
    if (!d) return;
    if (q.type === "mcq") answers[q.id] = { choice: d.given || null };
    else answers[q.id] = { text: d.openText || "" };
  });
  const graded = gradePaper(formObj, answers);
  return { formKey, formObj, graded };
}

async function publishOfficialScores() {
  const rows = A.rows || [];
  const targets = rows.filter(r =>
    r && r.finished_at && !r.official && r.status !== "removed" && r.status !== "waiting");
  if (!targets.length) return 0;
  let done = 0;
  for (const r of targets) {
    try {
      const og = officialGrade(r);
      if (!og) continue;
      const graded = og.graded;
      const settings = A.settings || {};
      await Store.updateSubmission(r.id, {
        mcq_score: graded.mcq,
        open_score: graded.open,
        final_score: graded.total,
        percent: graded.percent,
        status: "auto",
        graded_by: "auto",
        official: true,
        official_at: new Date().toISOString(),
        graded_note: "تصحيح رسمي من طرف المشرف",
        answers: JSON.stringify({
          bankVersion: A.bank.version,
          form: og.formKey,
          sessionId: r.session_id,
          deviceId: r.device_id,
          details: graded.details,
          snapshot: snapshotFromBank(og.formObj, graded),
          settings: { mcqSeconds: settings.mcqSeconds, openSeconds: settings.openSeconds }
        })
      });
      done++;
    } catch (e) {
      console.warn("تعذّر نشر التصحيح الرسمي", r.id, e);
    }
  }
  if (done) {
    try {
      A.rows = await Store.listSubmissions();
      updatePanelSub();
      fillResultFilters();
      renderSession();
      renderResults();
      const dashPanel = $("#tab-dash");
      if (dashPanel && !dashPanel.hidden) renderDash();
    } catch (e) { /* ignore */ }
  }
  return done;
}

/* ======================================================= أكواد المترشحين
   الرموز هي بيانات الدخول الحقيقية للمترشحين (Firebase Email/Password).
   تُحفظ في متصفّح المشرف فقط — لا تُرسل إلى الخادم ولا تظهر في قاعدة البيانات. */
const CODES_KEY = "manhaj_codes_v1";
const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; /* بلا I و O و 0 و 1 */

function loadCodes() {
  try {
    const raw = JSON.parse(localStorage.getItem(CODES_KEY) || "[]");
    return Array.isArray(raw) ? raw : [];
  } catch (e) { return []; }
}
function saveCodes(list) {
  try { localStorage.setItem(CODES_KEY, JSON.stringify(list)); } catch (e) { /* ignore */ }
}
function randomAccessCode() {
  let s = "";
  for (let i = 0; i < 8; i++) s += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
  return s.slice(0, 4) + "-" + s.slice(4);
}
function generateAccessCodes(n) {
  const count = Math.max(1, Math.min(200, Number(n || 30)));
  const list = loadCodes();
  const used = new Set(list.map(c => c.code));
  for (let i = 0; i < count; i++) {
    let code;
    do { code = randomAccessCode(); } while (used.has(code));
    used.add(code);
    list.push({ code, hash: "", createdAt: new Date().toISOString() });
  }
  saveCodes(list);
  renderCodes();
  toast(`تمّ توليد ${count} رمزًا`);
}
async function renderCodes() {
  const host = $("#codes-list");
  if (!host) return;
  const list = loadCodes();
  const badge = $("#codes-badge");
  if (badge) badge.textContent = String(list.length);
  if (!list.length) {
    host.innerHTML = `<div class="table-empty">لا توجد أكواد بعد — ولّد أكوادًا قبل فتح الجلسة.</div>`;
    return;
  }
  for (const c of list) {
    if (!c.hash) { try { c.hash = await Store.accessCodeHash(c.code); } catch (e) { c.hash = ""; } }
  }
  saveCodes(list);
  const usedHashes = new Set((A.rows || []).map(r => r.code_hash).filter(Boolean));
  host.innerHTML = `<div class="table-scroll"><table class="data">
    <thead><tr><th class="num">#</th><th>الرمز</th><th>البصمة</th><th>الحالة</th></tr></thead>
    <tbody>${list.map((c, i) => `<tr>
      <td class="num">${i + 1}</td>
      <td class="nowrap"><b dir="ltr">${esc(c.code)}</b></td>
      <td class="num small muted" dir="ltr">${esc(c.hash || "")}</td>
      <td>${usedHashes.has(c.hash)
        ? `<span class="badge badge-ok">مستعمل</span>`
        : `<span class="badge badge-neutral">غير مستعمل</span>`}</td>
    </tr>`).join("")}</tbody></table></div>`;
}
function bindCodes() {
  const gen = $("#btn-codes-gen");
  if (gen) gen.addEventListener("click", () => generateAccessCodes($("#codes-count").value));
  const copy = $("#btn-codes-copy");
  if (copy) copy.addEventListener("click", async () => {
    const list = loadCodes();
    if (!list.length) { toast("لا توجد أكواد", true); return; }
    const text = list.map((c, i) => `${i + 1}. ${c.code}`).join("\n");
    const ok = await copyText(text);
    toast(ok ? "نُسخت الأكواد" : "تعذّر النسخ — حدّدها يدويًّا", !ok);
  });
  const print = $("#btn-codes-print");
  if (print) print.addEventListener("click", () => {
    const list = loadCodes();
    if (!list.length) { toast("لا توجد أكواد", true); return; }
    const w = window.open("", "_blank");
    if (!w) { toast("تعذّر فتح نافذة الطباعة", true); return; }
    w.document.write(`<!DOCTYPE html><html lang="ar" dir="rtl"><head><meta charset="utf-8">
      <title>أكواد المترشحين</title><style>
      body{font-family:Cairo,Arial,sans-serif;padding:24px;color:#111}
      h1{font-size:20px;margin:0 0 4px}
      p{color:#555;margin:0 0 16px;font-size:13px}
      table{border-collapse:collapse;width:100%;font-size:14px}
      td,th{border:1px solid #ccc;padding:6px 8px}
      th{background:#f2f2f2}
      code{font-family:Consolas,monospace;letter-spacing:1px;font-size:15px}
      @media print{body{padding:0}}
      </style></head><body>
      <h1>أكواد المترشحين — رموز الدخول</h1>
      <p>يوزَّع رمز واحد لكل مترشح. يُستعمل في خانة «رمز المترشح» بصفحة الاختبار.
      الرمز سرّي: لا يُشارك ولا يُصوَّر. المدة: …………………</p>
      <table><thead><tr><th>#</th><th>الرمز</th><th>الاسم</th></tr></thead><tbody>
      ${list.map((c, i) => `<tr><td>${i + 1}</td><td><code>${c.code}</code></td><td></td></tr>`).join("")}
      </tbody></table></body></html>`);
    w.document.close();
    setTimeout(() => { try { w.print(); } catch (e) { /* ignore */ } }, 400);
  });
}

async function refreshSessionData(notify, forceFull) {
  if (!isAuthed()) { stopSessionTimer(); return; }
  try {
    const full = !!forceFull || !A.lastFullSync || (Date.now() - A.lastFullSync > 60000);
    const [rows, launch] = await Promise.all([
      full ? Store.listSubmissions() : Store.syncSubmissions(A.rows),
      Store.getLaunch()
    ]);
    if (full) A.lastFullSync = Date.now();
    A.rows = rows;
    A.launch = launch;
    A.sessions = await Store.getSessions(rows);
    /* نشر التصحيح الرسمي لكل نسخة أنهى المترشحها ولم تُنشر نقطها بعد */
    await publishOfficialScores();
    syncSeenResults(true);
    updatePanelSub();
    fillResultFilters();
    renderSession();
    renderResults();
    renderCodes();
    const dashPanel = $("#tab-dash");
    if (dashPanel && !dashPanel.hidden) renderDash();
    if (notify) toast("حُدّثت قائمة الانتظار");

    /* بعد إغلاق الجلسة: صحّح من غادر ولم يُنهِ نسخته (بعد مهلة كافية) */
    if (launch && launch.status === "closed" &&
        Date.now() - new Date(launch.closedAt || 0).getTime() > 12000 &&
        !A.finalizedSessions[launch.id]) {
      finalizeAbandoned(launch.id);
    }
  } catch (e) {
    console.warn("refreshSessionData failed", e);
  }
}

function sessionBadge(launch) {
  if (!launch) return { text: "لا توجد جلسة", cls: "badge-neutral" };
  switch (launch.status) {
    case "waiting": return { text: "بانتظار الإطلاق", cls: "badge-warn" };
    case "launched": return { text: "قيد التشغيل — الباب مفتوح", cls: "badge-ok" };
    case "closed": return { text: "منتهية — الباب مُقفل", cls: "badge-neutral" };
    default: return { text: "—", cls: "badge-neutral" };
  }
}

function renderSession() {
  const launch = A.launch;
  const badge = $("#launch-badge");
  if (badge) {
    const b = sessionBadge(launch);
    badge.textContent = b.text;
    badge.className = "badge " + b.cls;
  }

  const waiting = waitingRows();
  const live = inProgressRows();
  const done = launch ? activeRows().filter(r => r.session_id === launch.id).length : 0;
  $("#wait-waiting-count").textContent = String(waiting.length);
  const liveCount = $("#wait-live-count");
  if (liveCount) liveCount.textContent = String(live.length);
  $("#wait-done-count").textContent = String(done);

  $("#launch-state").textContent = launch ? sessionBadge(launch).text : "لم تُنشأ أي جلسة بعد";
  $("#launch-created").textContent = launch ? fmtDate(launch.createdAt) : "—";
  $("#launch-launched").textContent = launch && launch.launchedAt ? fmtDate(launch.launchedAt) : "—";
  $("#launch-closed").textContent = launch && launch.closedAt ? fmtDate(launch.closedAt) : "—";
  const labelInput = $("#launch-label");
  if (labelInput && document.activeElement !== labelInput) {
    labelInput.value = launch ? (launch.label || "") : "";
  }

  /* الأزرار حسب الحالة */
  const btnCreate = $("#btn-create-session");
  const btnLaunch = $("#btn-launch");
  const btnClose = $("#btn-close-session");
  const canCreate = !launch || launch.status === "closed";
  btnCreate.disabled = !canCreate;
  btnCreate.textContent = launch && launch.status === "closed" ? "فتح جلسة جديدة" : "إنشاء جلسة جديدة";
  btnLaunch.disabled = !(launch && launch.status === "waiting");
  btnClose.disabled = !(launch && launch.status !== "closed");
  btnClose.textContent = launch && launch.status === "waiting" ? "إلغاء الجلسة دون إطلاق" : "إنهاء الاختبار وقفل الباب";

  renderSessionHistory();
  renderLiveList();

  /* قائمة الانتظار */
  const host = $("#waiting-list");
  if (!host) return;
  if (!launch) {
    host.innerHTML = `<div class="table-empty">لا توجد جلسة بعد — أنشئ جلسة لتبدأ قائمة الانتظار.</div>`;
    return;
  }
  if (!waiting.length) {
    host.innerHTML = `<div class="table-empty">${launch.status === "waiting"
      ? "لا يوجد منتظرون الآن. شارك رابط <a href=" + '"index.html"' + ">الاختبار</a> مع المترشحين."
      : "لا يوجد منتظرون في هذه الجلسة."}</div>`;
    return;
  }
  const rowsHtml = waiting
    .slice()
    .sort((a, b) => new Date(a.joined_at || 0) - new Date(b.joined_at || 0))
    .map((r, i) => `<div class="wait-row">
        <span class="wait-rank">${i + 1}</span>
        <div class="wait-who"><b>${esc(r.candidate_last)} ${esc(r.candidate_first)}</b>
          <span class="small muted">${rowPlaceText(r) !== "—" ? esc(rowPlaceText(r)) + " · " : ""}انضم ${esc(fmtDate(r.joined_at))}</span></div>
        <button class="btn btn-sm btn-danger" type="button" data-del-waiting="${esc(r.id)}" title="إزالة من القائمة">✕</button>
      </div>`).join("");
  host.innerHTML = rowsHtml;
  host.querySelectorAll("[data-del-waiting]").forEach(b => {
    b.addEventListener("click", async () => {
      if (!confirm("إزالة هذا المترشح من قائمة الانتظار؟")) return;
      try {
        await Store.deleteSubmission(b.dataset.delWaiting);
        await refreshSessionData(false);
        toast("أُزيل من قائمة الانتظار");
      } catch (e) {
        toast("تعذّر الحذف", true);
      }
    });
  });
}

/* متابعة حية للمترشحين داخل الاختبار (تقدّمهم وآخر حفظ سحابي) */
function renderLiveList() {
  const host = $("#live-list");
  if (!host) return;
  const launch = A.launch;
  if (!launch) {
    host.innerHTML = `<div class="table-empty">لا توجد جلسة بعد — أنشئ جلسة ثم أطلقها ليظهر هنا من بدأ الاختبار.</div>`;
    return;
  }
  const live = inProgressRows()
    .slice()
    .sort((a, b) => new Date(a.started_at || 0) - new Date(b.started_at || 0));
  if (!live.length) {
    host.innerHTML = `<div class="table-empty">${launch.status === "launched"
      ? "لا أحد داخل الاختبار في هذه اللحظة. سيظهر المترشح هنا فور بدئه."
      : launch.status === "closed"
        ? "لا توجد نسخ قيد الإنجاز — الجلسة منتهية."
        : "سيظهر المترشحون هنا فور إطلاق الاختبار."}</div>`;
    return;
  }
  host.innerHTML = live.map(r => {
    const ps = progressStats(r);
    const st = liveState(r);
    const place = rowPlaceText(r);
    const startedAt = r.started_at ? new Date(r.started_at).getTime() : 0;
    const elapsed = startedAt ? Math.max(0, Math.round((Date.now() - startedAt) / 1000)) : 0;
    const lastAt = r.progress_at ? new Date(r.progress_at).getTime() : 0;
    const lastTxt = lastAt ? ` · آخر حفظ منذ ${fmtDuration((Date.now() - lastAt) / 1000)}` : "";
    return `<div class="wait-row live-row">
        <div class="live-main">
          <div class="wait-who"><b>${esc(r.candidate_last)} ${esc(r.candidate_first)}</b>
            <span class="small muted">${place !== "—" ? esc(place) + " · " : ""}بدأ منذ ${esc(fmtDuration(elapsed))}${esc(lastTxt)}</span></div>
          <div class="live-progress">
            <div class="live-bar" role="progressbar" aria-valuemin="0" aria-valuemax="100"
                 aria-valuenow="${ps.pct}" title="${ps.answered} من ${ps.total} سؤالًا">
              <i style="width:${ps.pct}%"></i>
            </div>
            <span class="small muted nowrap">${ps.answered}/${ps.total} سؤالًا · ${ps.pct}%</span>
          </div>
        </div>
        <span class="badge ${st.cls}" title="${esc(st.title)}">${esc(st.text)}</span>
      </div>`;
  }).join("");
}

/* سجل الجلسات: عرض، تعديل الاسم، حذف */
function renderSessionHistory() {
  const host = $("#sessions-list");
  if (!host) return;
  const list = (A.sessions || []).slice();
  if (!list.length) {
    host.innerHTML = `<div class="table-empty">لا توجد جلسات مسجّلة بعد — أنشئ جلسة جديدة.</div>`;
    return;
  }
  const currentId = A.launch ? A.launch.id : null;
  const trs = list.map(s => {
    const cur = s.id === currentId ? A.launch : s;
    const b = sessionBadge(cur);
    const isCurrent = s.id === currentId;
    const done = activeRows().filter(r => r.session_id === s.id).length;
    const wait = A.rows.filter(r => r.status === "waiting" && !r.started_at && r.session_id === s.id).length;
    const canDelete = !(isCurrent && cur.status === "launched");
    return `<tr class="${isCurrent ? "session-current" : ""}">
      <td><b>${esc(s.label)}</b>${isCurrent ? ` <span class="badge badge-ok">الحالية</span>` : ""}</td>
      <td><span class="badge ${b.cls}">${esc(b.text)}</span></td>
      <td class="num nowrap">${esc(fmtDate(s.createdAt))}</td>
      <td class="num">${done}</td>
      <td class="num">${wait}</td>
      <td class="nowrap">
        <button class="btn btn-sm btn-soft" type="button" data-edit-session="${esc(s.id)}">تعديل</button>
        <button class="btn btn-sm btn-danger" type="button" data-del-session="${esc(s.id)}"
                ${canDelete ? "" : `disabled title="أنهِ الجلسة الجارية أولًا ثم احذفها"`} title="حذف الجلسة">✕</button>
      </td>
    </tr>`;
  }).join("");
  host.innerHTML = `<div class="table-scroll"><table class="data sessions-table">
    <thead><tr>
      <th>الجلسة</th><th>الحالة</th><th class="num">أُنشئت</th>
      <th class="num">منجزون</th><th class="num">منتظرون</th><th>إجراءات</th>
    </tr></thead><tbody>${trs}</tbody></table></div>`;
  host.querySelectorAll("[data-edit-session]").forEach(btn =>
    btn.addEventListener("click", () => editSessionRecord(btn.dataset.editSession)));
  host.querySelectorAll("[data-del-session]").forEach(btn =>
    btn.addEventListener("click", () => removeSessionRecord(btn.dataset.delSession)));
}

async function editSessionRecord(id) {
  try {
    const list = await Store.getSessions(A.rows);
    const s = list.find(x => x.id === id);
    if (!s) { toast("الجلسة غير موجودة", true); return; }
    const value = prompt("اسم الجلسة الجديد:", s.label || "");
    if (value === null) return;
    const label = value.trim();
    if (!label) { toast("اسم الجلسة مطلوب", true); return; }
    await Store.updateSession(id, { label });
    await loadAll();
    toast("عُدّل اسم الجلسة");
  } catch (e) {
    toast("تعذّر تعديل الجلسة", true);
  }
}

async function removeSessionRecord(id) {
  try {
    const list = await Store.getSessions(A.rows);
    const s = list.find(x => x.id === id);
    if (!s) { toast("الجلسة غير موجودة", true); return; }
    const isCurrent = A.launch && A.launch.id === id;
    if (isCurrent && A.launch.status === "launched") {
      toast("أنهِ الاختبار الجاري أولًا ثم احذف الجلسة", true);
      return;
    }
    const msg = `حذف الجلسة «${s.label}» نهائيًّا؟\n` +
      (isCurrent ? "ستُزال الجلسة الحالية" : "سيُزال سجل الجلسة") +
      "، وتُحذف سجلات المنتظرين، وتبقى النسخ المنجزة في النتائج.";
    if (!confirm(msg)) return;
    const waiting = A.rows.filter(r => r.session_id === id && r.status === "waiting");
    const inProgress = waiting.filter(r => r.started_at && !r.finished_at);
    const stale = waiting.filter(r => !r.started_at || r.finished_at);
    if (inProgress.length) {
      const ok = confirm(`هناك ${inProgress.length} مترشح(ون) بدأوا الاختبار ولم يُنهوه (أو لم تُحدّث حالتهم).\nحذف الجلسة على أي حال؟ (يُحذف سجل الانتظار، وتبقى النسخ المنجزة)`);
      if (!ok) return;
    }
    for (const r of waiting) {
      try { await Store.deleteSubmission(r.id); } catch (e) { /* ignore */ }
    }
    await Store.deleteSession(id);
    await loadAll();
    toast("حُذفت الجلسة");
  } catch (e) {
    toast("تعذّر حذف الجلسة", true);
  }
}

async function createSession() {
  const label = $("#launch-label").value.trim();
  try {
    const cur = await Store.getLaunch();
    if (cur && cur.status !== "closed") {
      toast("هناك جلسة قيد التشغيل — أنهِها أو أغلقها أولًا", true);
      return;
    }
    await Store.saveLaunch({ status: "waiting", label, createdAt: new Date().toISOString() });
    await loadAll();
    toast("أُنشئت جلسة جديدة — في انتظار الإطلاق");
  } catch (e) {
    toast("تعذّر إنشاء الجلسة", true);
  }
}
async function launchNow() {
  let launch = await Store.getLaunch();
  if (!launch || launch.status !== "waiting") {
    toast("لا توجد جلسة بانتظار الإطلاق", true);
    return;
  }
  const waiting = waitingRows().length;
  if (!confirm(`إطلاق الاختبار الآن؟${waiting ? `\n${waiting} مترشحًا في قاعة الانتظار سيبدأون فورًا.` : ""}`)) return;
  try {
    launch = await Store.getLaunch();
    if (!launch || launch.status !== "waiting") { toast("تغيرت حالة الجلسة", true); return; }
    await Store.saveLaunch({ ...launch, status: "launched", launchedAt: new Date().toISOString() });
    await loadAll();
    toast("أُطلق الاختبار — انطلق الجميع!");
  } catch (e) {
    toast("تعذّر الإطلاق", true);
  }
}

async function closeSession() {
  let launch = await Store.getLaunch();
  if (!launch || launch.status === "closed") return;
  const msg = launch.status === "waiting"
    ? "إلغاء الجلسة دون إطلاق؟ يُقفل الباب ولا يدخل أحد في هذه الجلسة."
    : "إنهاء الاختبار وقفل باب الترشح نهائيًا لهذه الجلسة؟\nستظهر النتائج والتصحيح للمترشحين بعد هذا الإجراء.\nالمترشحون المنطلقون يكملون نسختهم ثم تُحفظ نتائجهم.";
  if (!confirm(msg)) return;
  try {
    await Store.saveLaunch({ ...launch, status: "closed", closedAt: new Date().toISOString() });
    /* المنتظرون الذين لم يبدأوا بعد يُزالون؛ من بدأ الاختبار يكمل نسخته */
    try {
      const rows = await Store.listSubmissions();
      const stale = rows.filter(r => r.status === "waiting" && r.session_id === launch.id && !r.started_at);
      for (const r of stale) { try { await Store.deleteSubmission(r.id); } catch (e) { /* ignore */ } }
    } catch (e) { /* ignore */ }
    await loadAll();
    toast("أُغلق باب الترشح — تُجمع النتائج تلقائيًا");
    /* ننتظر قليلًا حتى يُنهي المترشحون المتصلون نسخهم تلقائيًا، ثم نصحّح
       من غادر قبل الإنهاء اعتمادًا على التقدّم المحفوظ في السحابة. */
    setTimeout(() => { refreshSessionData(false, true); }, 9000);
    setTimeout(() => { refreshSessionData(false, true); }, 20000);
  } catch (e) {
    toast("تعذّر إنهاء الجلسة", true);
  }
}

/* ============================================================ WORD EXPORT */
function bindWord() {
  const btn = $("#btn-word");
  if (!btn) return;
  btn.addEventListener("click", () => {
    const choice = $("#word-form").value;
    const keys = choice === "AB" ? ["A", "B"] : [choice];
    if (typeof WordExport === "undefined" || !WordExport.downloadQuestionsDocx) {
      toast("تعذّر تحميل مولّد Word — تحقق من js/word.js", true);
      return;
    }
    try {
      readEditors();
      const filename = WordExport.downloadQuestionsDocx(A.bank, A.settings, keys);
      toast(`تمّ تصدير Word — ${filename}`);
    } catch (e) {
      console.error(e);
      toast("تعذّر إنشاء ملف Word", true);
    }
  });
}

/* عند عودة المشرف إلى الصفحة من الخلفية: مزامنة كاملة فورية بدل انتظار المؤقّت. */
document.addEventListener("visibilitychange", () => {
  if (document.hidden || !isAuthed() || !A.bank) return;
  refreshSessionData(false, true);
});

/* ==================================================================== démarrage */
document.addEventListener("DOMContentLoaded", boot);
document.addEventListener("keydown", ev => {
  if (ev.key === "Escape") closeModal();
});

})();
