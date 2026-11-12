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
    .toLowerCase()
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

/* عنوان قاعدة Firebase صالح: https://host أو http://localhost:port للاختبار المحلي */
function isCloudUrl(u) {
  const s = String(u || "").trim();
  return /^https:\/\/[^/]+$/i.test(s) || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(s);
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
  const LS_CLOUD = "manhaj_cloud_url_v1";
  let mode = null;

  /* ---------------------------------------------------------- cloud mode
     Firebase Realtime Database REST : يعمل من أي هاتف دون خادم.
     نقرأ العنوان من config.js أو من ?db=... (رابط المترشحين) أو من الإعدادات. */
  const CFG = window.MANHAJ_CONFIG || {};
  const CLOUD_ROOT = String(CFG.firebaseRoot || "manhaj").replace(/^\/+|\/+$/g, "") || "manhaj";
  const LS_OVERRIDE = "manhaj_cloud_override_v1";
  const normUrl = u => String(u || "").trim().replace(/\/+$/, "");
  let CLOUD_BASE = normUrl(CFG.firebaseUrl);
  try {
    const param = new URLSearchParams(location.search).get("db");
    const saved = localStorage.getItem(LS_CLOUD);
    const override = localStorage.getItem(LS_OVERRIDE) === "1";
    if (param && isCloudUrl(param)) {
      CLOUD_BASE = normUrl(param);
      localStorage.setItem(LS_CLOUD, CLOUD_BASE);
    } else if (CLOUD_BASE && isCloudUrl(CLOUD_BASE) && !override) {
      /* config.js هو المرجع الافتراضي لكل الأجهزة (تجنّب رابط قديم محفوظ) */
    } else if (saved && isCloudUrl(saved)) {
      CLOUD_BASE = normUrl(saved);
    } else if (!isCloudUrl(CLOUD_BASE)) {
      CLOUD_BASE = "";
    }
  } catch (e) { /* ignore */ }
  const cloudOn = () => !!CLOUD_BASE;

  /* إذا وصلت الصفحة بنسخة قديمة/مخزّنة من config.js بلا عنوان،
     نقرأ الملف مباشرة (بدون cache) حتى تعمل المزامنة تلقائيًا على كل هاتف. */
  let cloudResolvePromise = null;
  async function ensureCloudBase() {
    if (CLOUD_BASE) return true;
    if (cloudResolvePromise) return cloudResolvePromise;
    cloudResolvePromise = (async () => {
      try {
        const res = await fetch(`js/config.js?fresh=${Date.now()}`, { cache: "no-store" });
        if (!res.ok) return false;
        const txt = await res.text();
        const m = txt.match(/firebaseUrl\s*:\s*["']([^"']+)["']/);
        if (m && isCloudUrl(m[1])) {
          CLOUD_BASE = normUrl(m[1]);
          try { localStorage.setItem(LS_CLOUD, CLOUD_BASE); } catch (e) { /* ignore */ }
          return true;
        }
      } catch (e) { /* ignore */ }
      return false;
    })();
    const ok = await cloudResolvePromise;
    cloudResolvePromise = null;
    return ok;
  }

  /* ---------------------------------------------------- Firebase Auth
     عند وجود firebaseApiKey نسجّل دخولًا مجهولًا تلقائيًا ونضيف
     idToken إلى كل طلب REST (?auth=...). هذا يسمح بقواعد أمان
     ترفض أي وصول غير موثّق. */
  const FIREBASE_API_KEY = String(CFG.firebaseApiKey || "").trim();
  const AUTH_KEY = "manhaj_firebase_auth_v1";
  let authToken = "";
  let authRefresh = "";
  let authExpiresAt = 0;
  let authPromise = null;

  function loadAuth() {
    if (authToken) return;
    try {
      const raw = sessionStorage.getItem(AUTH_KEY);
      if (!raw) return;
      const j = JSON.parse(raw);
      if (j && j.idToken) {
        authToken = j.idToken;
        authRefresh = j.refreshToken || "";
        authExpiresAt = Number(j.expiresAt || 0);
      }
    } catch (e) { /* ignore */ }
  }
  function saveAuth() {
    try {
      sessionStorage.setItem(AUTH_KEY, JSON.stringify({
        idToken: authToken, refreshToken: authRefresh, expiresAt: authExpiresAt
      }));
    } catch (e) { /* ignore */ }
  }
  function clearAuth() {
    authToken = "";
    authRefresh = "";
    authExpiresAt = 0;
    try { sessionStorage.removeItem(AUTH_KEY); } catch (e) { /* ignore */ }
  }
  async function authRequest(url, body) {
    const res = await fetch(url, {
      method: "POST",
      cache: "no-store",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      const code = json && json.error && json.error.message ? json.error.message : `HTTP ${res.status}`;
      const err = new Error(`تعذّر تسجيل الدخول إلى Firebase (${code}).`);
      err.status = res.status;
      throw err;
    }
    return json;
  }
  async function ensureAuth() {
    if (!FIREBASE_API_KEY) return null;
    if (authToken && Date.now() < authExpiresAt - 60000) return authToken;
    if (authPromise) return authPromise;
    authPromise = (async () => {
      loadAuth();
      if (authToken && Date.now() < authExpiresAt - 60000) return authToken;
      if (authToken && authRefresh) {
        try {
          const j = await authRequest(
            `https://securetoken.googleapis.com/v1/token?key=${encodeURIComponent(FIREBASE_API_KEY)}`,
            { grant_type: "refresh_token", refresh_token: authRefresh }
          );
          authToken = j.id_token || j.access_token || "";
          authRefresh = j.refresh_token || authRefresh;
          authExpiresAt = Date.now() + Number(j.expires_in || 3600) * 1000;
          saveAuth();
          return authToken;
        } catch (e) {
          clearAuth();
        }
      }
      const j = await authRequest(
        `https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=${encodeURIComponent(FIREBASE_API_KEY)}`,
        { returnSecureToken: true }
      );
      authToken = j.idToken;
      authRefresh = j.refreshToken || "";
      authExpiresAt = Date.now() + Number(j.expiresIn || 3600) * 1000;
      saveAuth();
      return authToken;
    })();
    try { return await authPromise; }
    finally { authPromise = null; }
  }

  let lastError = null;
  function cloudUrl(path) {
    const clean = String(path).replace(/^\/+/, "").replace(/\/+$/, "");
    const auth = authToken ? `?auth=${encodeURIComponent(authToken)}` : "";
    return `${CLOUD_BASE}/${CLOUD_ROOT}/${clean}.json${auth}`;
  }
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  async function cloudRequest(path, options) {
    const opts = options || {};
    let lastErr = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 15000);
      try {
        if (FIREBASE_API_KEY) await ensureAuth();
        const res = await fetch(cloudUrl(path), {
          method: opts.method || "GET",
          cache: "no-store",
          headers: { "Content-Type": "application/json" },
          body: opts.body,
          signal: ctrl.signal
        });
        clearTimeout(timer);
        if (res.ok) {
          lastError = null;
          const text = await res.text();
          return text ? JSON.parse(text) : null;
        }
        /* قد يكون التوكن منتهيًا: نمسحه ونعيد المحاولة مرة واحدة */
        if ((res.status === 401 || res.status === 403) && FIREBASE_API_KEY && attempt === 0) {
          clearAuth();
          lastErr = new Error("تعذّر الوصول إلى Firebase: قواعد الأمان ترفض القراءة/الكتابة (401/403).");
          lastErr.status = res.status;
          await sleep(300);
          continue;
        }
        const err = new Error(
          res.status === 401 || res.status === 403
            ? "تعذّر الوصول إلى Firebase: قواعد الأمان ترفض القراءة/الكتابة (401/403)."
            : `Firebase HTTP ${res.status}`
        );
        err.status = res.status;
        /* لا نعيد المحاولة على أخطاء 4xx غير 429 */
        if (res.status !== 429 && res.status < 500) throw err;
        lastErr = err;
      } catch (e) {
        clearTimeout(timer);
        if (e && e.status && e.status !== 429 && e.status < 500) {
          lastError = e;
          throw e;
        }
        lastErr = e;
      }
      if (attempt < 2) await sleep(500 * (attempt + 1));
    }
    lastError = lastErr || new Error("تعذّر الاتصال بقاعدة Firebase");
    throw lastError;
  }
  const cloudGet = path => cloudRequest(path);
  const cloudPut = (path, value) => cloudRequest(path, { method: "PUT", body: JSON.stringify(value) });
  const cloudPatch = (path, value) => cloudRequest(path, { method: "PATCH", body: JSON.stringify(value) });
  const cloudDelete = path => cloudRequest(path, { method: "DELETE" });

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

  let lastProbeAt = 0;
  async function probe() {
    if (mode === "cloud" || mode === "api") return mode;
    /* لا نُثبّت الوضع المحلي إلى الأبد: نعيد المحاولة كل 15 ثانية */
    if (mode && Date.now() - lastProbeAt < 15000) return mode;
    lastProbeAt = Date.now();
    if (await ensureCloudBase()) { mode = "cloud"; return mode; }
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 5000);
      const res = await fetch("tables/submissions?limit=1", { signal: ctrl.signal, cache: "no-store" });
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
    while (rows.length < total && page <= 200) {
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

  const SUMMARY_FIELDS = [
    "session_id", "device_id", "candidate_first", "candidate_last", "place_code",
    "place_name", "status", "started_at", "finished_at", "form", "mcq_score",
    "open_score", "final_score", "percent", "joined_at", "progress_at"
  ];
  function summaryOf(rec) {
    const out = { id: rec.id, updated_at: new Date().toISOString() };
    SUMMARY_FIELDS.forEach(k => { out[k] = rec[k] === undefined ? null : rec[k]; });
    return out;
  }
  function summaryPatch(patch) {
    const out = { updated_at: patch.updated_at || new Date().toISOString() };
    SUMMARY_FIELDS.forEach(k => { if (patch[k] !== undefined) out[k] = patch[k]; });
    return out;
  }
  function isResultPatch(patch) {
    return SUMMARY_FIELDS.some(k => patch[k] !== undefined);
  }

  async function listSubmissions() {
    const m = await probe();
    if (m === "cloud") {
      const obj = await cloudGet("submissions");
      const rows = obj && typeof obj === "object"
        ? Object.keys(obj).map(k => {
            const r = obj[k] || {};
            return { ...r, id: r.id || k };
          })
        : [];
      return normalizePercents(rows.sort((a, b) =>
        new Date(b.finished_at || b.created_at || 0) - new Date(a.finished_at || a.created_at || 0)));
    }
    if (m === "api") {
      try {
        const rows = await apiAll("submissions");
        return normalizePercents(rows.sort((a, b) => new Date(b.finished_at || b.created_at || 0) - new Date(a.finished_at || a.created_at || 0)));
      } catch (e) {
        console.warn("Lecture API impossible", e);
        throw e;
      }
    }
    return normalizePercents(lsRead(LS_SUB, []).sort((a, b) => new Date(b.finished_at || 0) - new Date(a.finished_at || 0)));
  }

  async function listSummaries() {
    const m = await probe();
    if (m === "cloud") {
      const obj = await cloudGet("summaries");
      let list = obj && typeof obj === "object"
        ? Object.keys(obj).map(k => ({ ...(obj[k] || {}), id: (obj[k] && obj[k].id) || k }))
        : [];
      if (!list.length) {
        /* ترحيل تلقائي: بناء الفهرس من النسخ الموجودة */
        const rows = await listSubmissions();
        list = rows.map(summaryOf);
        await Promise.allSettled(list.map(row =>
          cloudPut(`summaries/${encodeURIComponent(row.id)}`, row)
        ));
      }
      return list.filter(x => x && x.id && x.status !== "removed");
    }
    return (await listSubmissions()).map(r => ({
      ...summaryOf(r),
      updated_at: r.updated_at || r.finished_at || r.joined_at || null
    }));
  }

  async function getSubmission(id) {
    const m = await probe();
    if (m === "cloud") {
      const row = await cloudGet(`submissions/${encodeURIComponent(id)}`);
      return row && typeof row === "object" ? { ...row, id: row.id || id } : null;
    }
    const rows = await listSubmissions();
    return rows.find(r => r.id === id) || null;
  }

  /* تحديث تدريجي: نقرأ الفهرس الخفيف ثم نجلب فقط النسخ التي تغيّرت.
     يخفّف الحمل كثيرًا عند 30+ مترشحًا. */
  async function syncSubmissions(current) {
    const m = await probe();
    if (m !== "cloud") return listSubmissions();
    const base = Array.isArray(current) ? current : [];
    if (!base.length) return listSubmissions();
    const summaries = await listSummaries();
    const byId = new Map(base.map(r => [r.id, r]));
    const changed = summaries.filter(s => {
      const r = byId.get(s.id);
      if (!r) return true;
      return String(r.updated_at || "") !== String(s.updated_at || "") ||
             String(r.finished_at || "") !== String(s.finished_at || "") ||
             String(r.status || "") !== String(s.status || "");
    });
    const fetched = await Promise.all(changed.map(async s => {
      try {
        const row = await getSubmission(s.id);
        return row ? { ...row, updated_at: s.updated_at } : null;
      } catch (e) { return null; }
    }));
    /* لا نحذف صفوفًا لمجرد غيابها من الفهرس (قد يكون الفهرس قيد الترحيل).
       التنظيف الكامل يتم عند التحديث اليدوي/الدوري. */
    const merged = new Map(base.map(r => [r.id, r]));
    fetched.forEach(r => { if (r) merged.set(r.id, r); });
    return Array.from(merged.values());
  }

  function setCloudUrl(url) {
    const u = normUrl(url);
    if (!isCloudUrl(u)) throw new Error("رابط Firebase غير صالح");
    CLOUD_BASE = u;
    mode = "cloud";
    try {
      localStorage.setItem(LS_CLOUD, u);
      localStorage.setItem(LS_OVERRIDE, "1");
    } catch (e) { /* ignore */ }
    return u;
  }

  async function addSubmission(rec) {
    const m = await probe();
    if (m === "cloud") {
      const row = { ...rec, id: rec.id || uid(), created_at: rec.created_at || Date.now() };
      await cloudPut(`submissions/${encodeURIComponent(row.id)}`, row);
      try { await cloudPut(`summaries/${encodeURIComponent(row.id)}`, summaryOf(row)); }
      catch (e) { console.warn("تعذّر تحديث فهرس النسخ", e); }
      return row;
    }
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
        console.warn("Écriture API impossible", e);
        throw e;
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
    if (m === "cloud") {
      const next = { ...patch };
      if (isResultPatch(patch)) next.updated_at = new Date().toISOString();
      await cloudPatch(`submissions/${encodeURIComponent(id)}`, next);
      if (isResultPatch(patch)) {
        try { await cloudPatch(`summaries/${encodeURIComponent(id)}`, summaryPatch(next)); }
        catch (e) { console.warn("تعذّر تحديث فهرس النسخ", e); }
      }
      return { ...next, id };
    }
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
        console.warn("Mise à jour API impossible", e);
        throw e;
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
    if (m === "cloud") {
      try { await cloudDelete(`summaries/${encodeURIComponent(id)}`); }
      catch (e) { console.warn("تعذّر حذف فهرس النسخة", e); }
      await cloudDelete(`submissions/${encodeURIComponent(id)}`);
      return true;
    }
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
        console.warn("Suppression API impossible", e);
        throw e;
      }
    }
    lsWrite(LS_SUB, lsRead(LS_SUB, []).filter(r => r.id !== id));
    return true;
  }

  /* -------- config (banque de questions, réglages) -------- */
  async function allConfig() {
    const m = await probe();
    if (m === "cloud") {
      const obj = await cloudGet("config");
      if (!obj || typeof obj !== "object") return [];
      return Object.keys(obj).map(key => ({ key, value: obj[key], id: key }));
    }
    if (m === "api") {
      try {
        return await apiAll("config");
      } catch (e) {
        console.warn("Config API illisible", e);
        throw e;
      }
    }
    return lsRead(LS_CFG, []);
  }

  async function getConfig(key) {
    if ((await probe()) === "cloud") {
      return cloudGet(`config/${encodeURIComponent(key)}`);
    }
    const rows = await allConfig();
    const found = rows.find(r => r.key === key);
    return found ? found.value : null;
  }

  async function saveConfig(key, value) {
    const m = await probe();
    if (m === "cloud") {
      await cloudPut(`config/${encodeURIComponent(key)}`, value);
      return { key, value };
    }
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
        console.warn("Écriture config impossible", e);
        throw e;
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
        list = parsed.filter(s => s && s.id).map(s => ({ ...plainSession(s), deleted: !!s.deleted, deletedAt: s.deletedAt || null }));
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
    const list = await getSessions();
    const i = list.findIndex(s => s.id === id);
    if (i === -1) return true;
    list[i] = { ...list[i], deleted: true, deletedAt: new Date().toISOString() };
    await saveConfig("sessions", JSON.stringify(list));
    const launch = await getLaunch();
    if (launch && launch.id === id) await saveConfig("launch", "");
    return true;
  }

  return {
    probe, getMode, listSubmissions, listSummaries, getSubmission, syncSubmissions,
    addSubmission, updateSubmission, deleteSubmission, setCloudUrl,
    getBank, saveBank, getSettings, saveSettings, resetBank,
    getLaunch, saveLaunch, clearLaunch, getSessions, updateSession, deleteSession,
    getLastError: () => lastError
  };
})();

/* =============================================================== notation */
function autoScoreOpen(q, text) {
  const norm = normalizeAr(text);
  const words = wordCount(text);
  const rubric = (q.rubric || []).map(r => {
    const kws = Array.from(new Set((r.keywords || []).map(normalizeAr).filter(Boolean)));
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
  const mcqMax = formObj.questions.filter(q => q.type === "mcq").reduce((a, q) => a + Number(q.points || 0), 0);
  const openMax = formObj.questions.filter(q => q.type === "open").reduce((a, q) => a + Number(q.points || 0), 0);
  const maxPoints = mcqMax + openMax || 1;
  return { details, mcq, open, total, mcqMax, openMax, maxPoints, percent: Math.round((total / maxPoints) * 1000) / 10 };
}

if (typeof window !== "undefined") {
  window.App = {
    Store, autoScoreOpen, gradePaper, esc, normalizeAr, wordCount, shuffle, uid,
    fmtDate, fmtClock, fmtDuration, scoreClass, toast, pad2, deviceId, sha256hex,
    PLACE_LIST, findPlace, placeName, placeLabel
  };
}
