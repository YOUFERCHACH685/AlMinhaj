/* ==========================================================================
   core.js — utilitaires + couche de données
   Deux magasins possibles :
     1) « api »   : tables du projet (tables/submissions, tables/config)
     2) « local » : localStorage, uniquement si l'API n'est pas joignable
   Un seul magasin est actif à la fois ; le mode est affiché dans l'espace
   superviseur pour éviter toute divergence silencieuse.
   ========================================================================== */

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

/* ------------------------------------------------------------------ texte */
function esc(v) {
  return String(v == null ? "" : v)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function normalizeAr(s) {
  return String(s || "")
    .replace(/[\u064B-\u0652\u0670\u0640]/g, "")
    .replace(/[أإآٱ]/g, "ا")
    .replace(/ى/g, "ي")
    .replace(/ؤ/g, "و")
    .replace(/ئ/g, "ي")
    .replace(/ة/g, "ه")
    .replace(/[^\u0600-\u06FF0-9a-zA-Z\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function wordCount(s) {
  const t = String(s || "").trim();
  if (!t) return 0;
  return t.split(/\s+/).length;
}

/* --------------------------------------------------------------- الأماكن */
/* قائمة الأماكن (المحطات) التي يختار منها المترشح عند التسجيل */
const PLACE_LIST = [
  { code: "1.1", name: "بني شيكر" },
  { code: "1.2", name: "فرخانة" },
  { code: "1.3", name: "بني انصار" },
  { code: "2.1", name: "براقة" },
  { code: "2.2", name: "الناظور المدينة/لعراصي" },
  { code: "3.1", name: "الجمعة" },
  { code: "3.2", name: "اصبانن/تيزيرين" },
  { code: "3.3", name: "عاريض" },
  { code: "4.1", name: "تاويمة" },
  { code: "4.2", name: "بوعرورو" }
];

function findPlace(code) {
  const key = String(code == null ? "" : code).trim();
  return PLACE_LIST.find(p => p.code === key) || null;
}

function placeName(code) {
  const p = findPlace(code);
  return p ? p.name : "";
}

/* يعيد «1.1 — بني شيكر» أو «—» عند غياب المكان */
function placeLabel(code, name) {
  const n = String(name || placeName(code) || "").trim();
  const c = String(code == null ? "" : code).trim();
  if (c && n) return `${c} — ${n}`;
  return n || c || "—";
}

/* ------------------------------------------------------------------ divers */
function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function uid() {
  if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
  return "id-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 9);
}

function pad2(n) { return String(n).padStart(2, "0"); }

/* -------------------------------------------------------------- empreinte */
/* معرف دائم لهذا الجهاز/المتصفح (يمنع تكرار الترشح من نفس الجهاز) */
function deviceId() {
  const KEY = "manhaj_device_v1";
  try {
    let id = localStorage.getItem(KEY);
    if (!id) { id = uid(); localStorage.setItem(KEY, id); }
    return id;
  } catch (e) {
    return "dev-" + Date.now().toString(36);
  }
}

/* SHA-256 (غير متزامن عندما تتوفّر SubtleCrypto، مع مرجع احتياطي خالص) */
async function sha256hex(text) {
  const data = new TextEncoder().encode(String(text));
  try {
    if (window.crypto && crypto.subtle && crypto.subtle.digest) {
      const buf = await crypto.subtle.digest("SHA-256", data);
      return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, "0")).join("");
    }
  } catch (e) { /* سقوط إلى المرجع */ }
  return sha256Sync(String(text));
}

function sha256Sync(str) {
  const bytes = Array.from(new TextEncoder().encode(str));
  const h = [
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19
  ];
  const k = [
    0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
    0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
    0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
    0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
    0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
    0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
    0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
    0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2
  ];
  const bitLen = bytes.length * 8;
  bytes.push(0x80);
  while (bytes.length % 64 !== 56) bytes.push(0);
  const hi = Math.floor(bitLen / 0x100000000), lo = bitLen >>> 0;
  [hi, lo].forEach(v => {
    bytes.push((v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255);
  });
  const w = new Array(64);
  const rotr = (x, n) => (x >>> n) | (x << (32 - n));
  for (let off = 0; off < bytes.length; off += 64) {
    for (let t = 0; t < 16; t++) {
      w[t] = (bytes[off + t * 4] << 24) | (bytes[off + t * 4 + 1] << 16) |
             (bytes[off + t * 4 + 2] << 8) | bytes[off + t * 4 + 3];
    }
    for (let t = 16; t < 64; t++) {
      const s0 = rotr(w[t - 15], 7) ^ rotr(w[t - 15], 18) ^ (w[t - 15] >>> 3);
      const s1 = rotr(w[t - 2], 17) ^ rotr(w[t - 2], 19) ^ (w[t - 2] >>> 10);
      w[t] = (w[t - 16] + s0 + w[t - 7] + s1) | 0;
    }
    let [a, b, c, d, e, f, g, hh] = h;
    for (let t = 0; t < 64; t++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (hh + S1 + ch + k[t] + w[t]) | 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) | 0;
      hh = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
    }
    h[0] = (h[0] + a) | 0; h[1] = (h[1] + b) | 0; h[2] = (h[2] + c) | 0; h[3] = (h[3] + d) | 0;
    h[4] = (h[4] + e) | 0; h[5] = (h[5] + f) | 0; h[6] = (h[6] + g) | 0; h[7] = (h[7] + hh) | 0;
  }
  return h.map(v => (v >>> 0).toString(16).padStart(8, "0")).join("");
}

function fmtDate(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "—";
  return `${d.getFullYear()}/${pad2(d.getMonth() + 1)}/${pad2(d.getDate())} — ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

function fmtClock(sec) {
  const s = Math.max(0, Math.round(sec));
  return `${pad2(Math.floor(s / 60))}:${pad2(s % 60)}`;
}

function fmtDuration(sec) {
  const s = Math.max(0, Math.round(sec || 0));
  const m = Math.floor(s / 60);
  return m > 0 ? `${m} د ${pad2(s % 60)} ث` : `${s} ث`;
}

function scoreClass(pct) {
  if (pct >= 70) return "good";
  if (pct >= 50) return "mid";
  return "bad";
}

let toastTimer = null;
function toast(msg, bad) {
  let el = $("#toast");
  if (!el) {
    el = document.createElement("div");
    el.id = "toast";
    el.className = "toast";
    el.setAttribute("role", "status");
    el.setAttribute("aria-live", "polite");
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.classList.toggle("bad", !!bad);
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), 2800);
}

/* ==================================================================== STORE */
const Store = (() => {
  const LS_SUB = "manhaj_submissions_v1";
  const LS_CFG = "manhaj_config_v1";
  let mode = null;

  function lsRead(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch (e) {
      return fallback;
    }
  }
  function lsWrite(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
      return true;
    } catch (e) {
      console.error("localStorage indisponible", e);
      return false;
    }
  }

  async function probe() {
    if (mode) return mode;
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 6000);
      const res = await fetch("tables/submissions?limit=1", { signal: ctrl.signal });
      clearTimeout(t);
      if (res.ok) {
        const json = await res.json();
        if (json && Array.isArray(json.data)) {
          mode = "api";
          return mode;
        }
      }
    } catch (e) { /* API non disponible */ }
    mode = "local";
    return mode;
  }

  function getMode() { return mode; }

  /* -------- API paginée -------- */
  async function apiAll(table) {
    const rows = [];
    let page = 1;
    let total = Infinity;
    while (rows.length < total && page <= 25) {
      const res = await fetch(`tables/${table}?page=${page}&limit=100`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      const data = json.data || [];
      rows.push(...data);
      total = typeof json.total === "number" ? json.total : rows.length;
      if (!data.length) break;
      page++;
    }
    return rows;
  }

  /* إصلاح سجلات قديمة خُزنت النسبة فيها ككسر (0.33 بدل 33) */
  function normalizePercents(rows) {
    return (rows || []).map(r => {
      if (r && Number(r.percent) <= 1 && Number(r.final_score) > 1) {
        return { ...r, percent: Number(r.final_score) };
      }
      return r;
    });
  }

  async function listSubmissions() {
    const m = await probe();
    if (m === "api") {
      try {
        const rows = await apiAll("submissions");
        return normalizePercents(rows.sort((a, b) => new Date(b.finished_at || b.created_at || 0) - new Date(a.finished_at || a.created_at || 0)));
      } catch (e) {
        console.warn("Lecture API impossible, bascule locale", e);
        mode = "local";
      }
    }
    return normalizePercents(lsRead(LS_SUB, []).sort((a, b) => new Date(b.finished_at || 0) - new Date(a.finished_at || 0)));
  }

  async function addSubmission(rec) {
    const m = await probe();
    if (m === "api") {
      try {
        const res = await fetch("tables/submissions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(rec)
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const saved = await res.json();
        /* miroir local : garde une trace si l'onglet se ferme */
        const all = lsRead(LS_SUB, []);
        all.push({ ...rec, id: saved.id || rec.id });
        lsWrite(LS_SUB, all);
        return saved;
      } catch (e) {
        console.warn("Écriture API impossible, bascule locale", e);
        mode = "local";
      }
    }
    const local = { ...rec, id: rec.id || uid(), created_at: Date.now() };
    const all = lsRead(LS_SUB, []);
    all.push(local);
    lsWrite(LS_SUB, all);
    return local;
  }

  async function updateSubmission(id, patch) {
    const m = await probe();
    if (m === "api") {
      try {
        const res = await fetch(`tables/submissions/${encodeURIComponent(id)}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(patch)
        });
        if (res.ok) {
          const saved = await res.json();
          /* مزامنة النسخة المحلية حتى تبقى نتيجة الجهاز الحالي محدّثة */
          lsWrite(LS_SUB, lsRead(LS_SUB, []).map(r => r.id === id ? { ...r, ...patch } : r));
          return saved;
        }
        if (res.status !== 404) throw new Error(`HTTP ${res.status}`);
      } catch (e) {
        console.warn("Mise à jour API impossible, bascule locale", e);
        mode = "local";
      }
    }
    const all = lsRead(LS_SUB, []);
    const i = all.findIndex(r => r.id === id);
    if (i === -1) throw new Error("السجل غير موجود");
    all[i] = { ...all[i], ...patch };
    lsWrite(LS_SUB, all);
    return all[i];
  }

  async function deleteSubmission(id) {
    const m = await probe();
    if (m === "api") {
      try {
        const res = await fetch(`tables/submissions/${encodeURIComponent(id)}`, { method: "DELETE" });
        if (res.ok || res.status === 404) {
          const all = lsRead(LS_SUB, []).filter(r => r.id !== id);
          lsWrite(LS_SUB, all);
          return true;
        }
        throw new Error(`HTTP ${res.status}`);
      } catch (e) {
        console.warn("Suppression API impossible, bascule locale", e);
        mode = "local";
      }
    }
    lsWrite(LS_SUB, lsRead(LS_SUB, []).filter(r => r.id !== id));
    return true;
  }

  /* -------- config (banque de questions, réglages) -------- */
  async function allConfig() {
    const m = await probe();
    if (m === "api") {
      try {
        return await apiAll("config");
      } catch (e) {
        console.warn("Config API illisible, bascule locale", e);
        mode = "local";
      }
    }
    return lsRead(LS_CFG, []);
  }

  async function getConfig(key) {
    const rows = await allConfig();
    const found = rows.find(r => r.key === key);
    return found ? found.value : null;
  }

  async function saveConfig(key, value) {
    const m = await probe();
    if (m === "api") {
      try {
        const rows = await apiAll("config");
        const found = rows.find(r => r.key === key);
        const body = JSON.stringify({ key, value });
        const res = found
          ? await fetch(`tables/config/${encodeURIComponent(found.id)}`, {
              method: "PATCH", headers: { "Content-Type": "application/json" }, body
            })
          : await fetch("tables/config", {
              method: "POST", headers: { "Content-Type": "application/json" }, body
            });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const saved = await res.json();
        const localRows = lsRead(LS_CFG, []).filter(r => r.key !== key);
        localRows.push({ key, value, id: saved.id || found?.id });
        lsWrite(LS_CFG, localRows);
        return saved;
      } catch (e) {
        console.warn("Écriture config impossible, bascule locale", e);
        mode = "local";
      }
    }
    const rows = lsRead(LS_CFG, []).filter(r => r.key !== key);
    rows.push({ key, value, id: uid() });
    lsWrite(LS_CFG, rows);
    return rows[rows.length - 1];
  }

  async function getBank() {
    const raw = await getConfig("bank");
    if (!raw) return JSON.parse(JSON.stringify(window.BANK_DEFAULT));
    try {
      const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
      if (parsed && parsed.forms && parsed.forms.A && parsed.forms.B) return parsed;
    } catch (e) { /* ignore, on retombe sur le défaut */ }
    return JSON.parse(JSON.stringify(window.BANK_DEFAULT));
  }

  async function saveBank(bank) {
    bank.updatedAt = new Date().toISOString().slice(0, 10);
    await saveConfig("bank", JSON.stringify(bank));
    return bank;
  }

  async function getSettings() {
    const raw = await getConfig("settings");
    const base = {
      mcqSeconds: 45,
      openSeconds: 180,
      formMode: "random",          /* random | A | B */
      passMark: 50,
      minWords: 8,
      institution: "اختبار في المنهاج النبوي"
    };
    if (!raw) return base;
    try {
      const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
      return { ...base, ...parsed };
    } catch (e) {
      return base;
    }
  }

  async function saveSettings(s) {
    await saveConfig("settings", JSON.stringify(s));
    return s;
  }

  /* Réinitialisation douce : n'efface jamais les copies des candidats. */
  async function resetBank() {
    await saveConfig("bank", JSON.stringify(window.BANK_DEFAULT));
    return JSON.parse(JSON.stringify(window.BANK_DEFAULT));
  }

  /* -------- جلسة الإطلاق : حالة الاختبار الحالي (create/launch/close) -------- */
  function plainSession(v) {
    return {
      id: v.id || uid(),
      label: String(v.label || "").trim() || ("جلسة " + fmtDate(new Date().toISOString())),
      status: v.status || "waiting",
      createdAt: v.createdAt || new Date().toISOString(),
      launchedAt: v.launchedAt || null,
      closedAt: v.closedAt || null
    };
  }

  async function getLaunch() {
    const raw = await getConfig("launch");
    if (!raw) return null;
    try {
      const p = typeof raw === "string" ? JSON.parse(raw) : raw;
      if (p && p.id && (p.status === "waiting" || p.status === "launched" || p.status === "closed")) return p;
    } catch (e) { /* سقوط إلى لا شيء */ }
    return null;
  }

  async function saveLaunch(v) {
    const rec = plainSession(v);
    await saveConfig("launch", JSON.stringify(rec));
    /* مزامنة سجل الجلسات (تاريخ الجلسات السابقة) */
    try {
      const list = await getSessions();
      const i = list.findIndex(s => s.id === rec.id);
      if (i === -1) list.push(rec);
      else list[i] = { ...list[i], ...rec };
      await saveConfig("sessions", JSON.stringify(list));
    } catch (e) {
      console.warn("تحديث سجل الجلسات تعذّر", e);
    }
    return rec;
  }

  async function clearLaunch() {
    await saveConfig("launch", "");
  }

  /* سجل الجلسات: يُستخدم في تبويب الجلسات (تعديل الاسم/الحذف) */
  async function getSessions(rows) {
    let list = [];
    try {
      const raw = await getConfig("sessions");
      const parsed = typeof raw === "string" ? JSON.parse(raw || "[]") : raw;
      if (Array.isArray(parsed)) {
        list = parsed.filter(s => s && s.id).map(plainSession);
      }
    } catch (e) { list = []; }

    let changed = false;
    const launch = await getLaunch();
    if (launch && !list.some(s => s.id === launch.id)) {
      list.push(plainSession(launch));
      changed = true;
    }

    /* ترحيل لمرة واحدة: جلسات قديمة موجودة في النسخ ولا سجل لها */
    let migrated = null;
    try { migrated = await getConfig("sessionsMigrated"); } catch (e) { /* ignore */ }
    if (!migrated && Array.isArray(rows) && rows.length) {
      rows.forEach(r => {
        if (r && r.session_id && !list.some(s => s.id === r.session_id)) {
          list.push(plainSession({
            id: r.session_id,
            label: "جلسة سابقة",
            status: "closed",
            createdAt: r.started_at || r.joined_at || r.finished_at || null,
            launchedAt: r.started_at || null,
            closedAt: null
          }));
          changed = true;
        }
      });
      await saveConfig("sessionsMigrated", "1");
    }

    if (changed) await saveConfig("sessions", JSON.stringify(list));
    const currentId = launch ? launch.id : null;
    return list.sort((a, b) => {
      if (a.id === currentId) return -1;
      if (b.id === currentId) return 1;
      return new Date(b.createdAt || 0) - new Date(a.createdAt || 0);
    });
  }

  async function updateSession(id, patch) {
    const list = await getSessions();
    const i = list.findIndex(s => s.id === id);
    if (i === -1) throw new Error("الجلسة غير موجودة");
    const label = String(patch && patch.label != null ? patch.label : list[i].label).trim();
    if (!label) throw new Error("اسم الجلسة مطلوب");
    list[i] = { ...list[i], label };
    await saveConfig("sessions", JSON.stringify(list));
    /* إن كانت الجلسة الحالية، حدّث اسمها في حالة الإطلاق أيضًا */
    const launch = await getLaunch();
    if (launch && launch.id === id) {
      await saveConfig("launch", JSON.stringify({ ...launch, label }));
    }
    return list[i];
  }

  async function deleteSession(id) {
    const list = (await getSessions()).filter(s => s.id !== id);
    await saveConfig("sessions", JSON.stringify(list));
    const launch = await getLaunch();
    if (launch && launch.id === id) await saveConfig("launch", "");
    return true;
  }

  return {
    probe, getMode, listSubmissions, addSubmission, updateSubmission,
    deleteSubmission, getBank, saveBank, getSettings, saveSettings, resetBank,
    getLaunch, saveLaunch, clearLaunch, getSessions, updateSession, deleteSession
  };
})();

/* =============================================================== notation */
function autoScoreOpen(q, text) {
  const norm = normalizeAr(text);
  const words = wordCount(text);
  const rubric = (q.rubric || []).map(r => {
    const kws = (r.keywords || []).map(normalizeAr).filter(Boolean);
    const hits = kws.filter(k => k && norm.includes(k)).length;
    let earned = 0;
    if (hits >= 2) earned = r.points;
    else if (hits === 1) earned = Math.round(r.points / 2);
    return { id: r.id, points: r.points, hits, earned };
  });
  let total = rubric.reduce((s, r) => s + r.earned, 0);
  /* une réponse trop courte ne peut pas obtenir la totalité des points */
  if (words < 6) total = Math.min(total, Math.round(q.points * 0.4));
  total = Math.min(total, q.points);
  return { total, rubric, words };
}

/* Calcule le détail d'une copie à partir des réponses brutes */
function gradePaper(formObj, answers) {
  const details = [];
  let mcq = 0;
  let open = 0;
  formObj.questions.forEach(q => {
    const a = answers[q.id] || {};
    if (q.type === "mcq") {
      const given = a.choice || null;
      const correct = q.correct;
      const ok = given === correct;
      const earned = ok ? q.points : 0;
      mcq += earned;
      details.push({
        qid: q.id, type: "mcq", topic: q.topic, maxPoints: q.points, earned,
        given, correct, ok,
        givenText: (q.options.find(o => o.id === given) || {}).text || "",
        correctText: (q.options.find(o => o.id === correct) || {}).text || ""
      });
    } else {
      const text = String(a.text || "").trim();
      const auto = autoScoreOpen(q, text);
      open += auto.total;
      details.push({
        qid: q.id, type: "open", topic: q.topic, maxPoints: q.points,
        earned: auto.total, openText: text, words: auto.words,
        rubric: auto.rubric, auto: true
      });
    }
  });
  const total = mcq + open;
  return { details, mcq, open, total, percent: Math.round((total / 100) * 1000) / 10 };
}

if (typeof window !== "undefined") {
  window.App = {
    Store, autoScoreOpen, gradePaper, esc, normalizeAr, wordCount, shuffle, uid,
    fmtDate, fmtClock, fmtDuration, scoreClass, toast, pad2, deviceId, sha256hex,
    PLACE_LIST, findPlace, placeName, placeLabel
  };
}
