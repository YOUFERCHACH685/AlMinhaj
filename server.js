#!/usr/bin/env node
"use strict";

/* ==========================================================================
   server.js — خادم محلي بسيط (بدون أي مكتبة خارجية)
   - يقدّم ملفات الموقع الساكنة.
   - يوفّر واجهة `tables/submissions` و`tables/config` (GET/POST/PATCH/DELETE)
     لكي يتشارك المشرف والمترشحون نفس البيانات على الشبكة المحلية.
   - يحفظ البيانات في data/db.json.
   التشغيل:  node server.js   أو   start-server.bat
   ========================================================================== */

const http = require("http");
const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const os = require("os");
const crypto = require("crypto");

const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, "data");
const DB_FILE = path.join(DATA_DIR, "db.json");
const PORT = Number(process.env.PORT) || 8766;
const HOST = process.env.HOST || "0.0.0.0";
const MAX_BODY = 8 * 1024 * 1024;
const TABLES = new Set(["submissions", "config"]);

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".pdf": "application/pdf",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
};

let db = { submissions: [], config: [] };
let writeQueue = Promise.resolve();

/* ------------------------------------------------------------------ data */

function normalizeDb(raw) {
  const safe = raw && typeof raw === "object" ? raw : {};
  return {
    submissions: Array.isArray(safe.submissions) ? safe.submissions : [],
    config: Array.isArray(safe.config) ? safe.config : []
  };
}

async function loadDb() {
  try {
    const raw = await fsp.readFile(DB_FILE, "utf8");
    db = normalizeDb(JSON.parse(raw));
  } catch (e) {
    if (e.code !== "ENOENT") {
      console.warn("⚠ تعذّر قراءة قاعدة البيانات، سيتم إنشاء ملف جديد:", e.message);
    }
    await persist();
  }
}

/* كتابة ذرّية + طابور لتفادي تلف الملف عند الطلبات المتزامنة */
function persist() {
  const snapshot = JSON.stringify(db, null, 2);
  writeQueue = writeQueue
    .then(async () => {
      await fsp.mkdir(DATA_DIR, { recursive: true });
      const tmp = `${DB_FILE}.${process.pid}.tmp`;
      await fsp.writeFile(tmp, snapshot, "utf8");
      await fsp.rename(tmp, DB_FILE);
    })
    .catch(err => console.error("⚠ تعذّر حفظ قاعدة البيانات:", err.message));
  return writeQueue;
}

/* ------------------------------------------------------------------ http */

function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Max-Age", "86400");
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  cors(res);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff"
  });
  res.end(body);
}

function sendText(res, status, text) {
  cors(res);
  res.writeHead(status, {
    "Content-Type": "text/plain; charset=utf-8",
    "Content-Length": Buffer.byteLength(text),
    "X-Content-Type-Options": "nosniff"
  });
  res.end(text);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", chunk => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(Object.assign(new Error("request body too large"), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch (e) {
        reject(Object.assign(new Error("invalid JSON body"), { status: 400 }));
      }
    });
    req.on("error", reject);
  });
}

async function handleApi(req, res, table, id) {
  const rows = db[table];
  if (!rows) return sendJson(res, 404, { error: "unknown table" });

  if (req.method === "GET" && !id) {
    const url = new URL(req.url, "http://localhost");
    const page = Math.max(1, parseInt(url.searchParams.get("page") || "1", 10) || 1);
    const limit = Math.min(1000, Math.max(1, parseInt(url.searchParams.get("limit") || "100", 10) || 100));
    const start = (page - 1) * limit;
    return sendJson(res, 200, {
      data: rows.slice(start, start + limit),
      total: rows.length,
      page,
      limit
    });
  }

  if (req.method === "POST" && !id) {
    const body = await readBody(req);
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return sendJson(res, 400, { error: "JSON object expected" });
    }
    /* منع تكرار مفاتيح الإعدادات: نحدّث السجل الموجود بدل إنشاء نسخة ثانية */
    if (table === "config" && body.key) {
      const existing = rows.find(r => r && r.key === body.key);
      if (existing) {
        Object.assign(existing, body, { id: existing.id });
        await persist();
        return sendJson(res, 200, existing);
      }
    }
    const row = { ...body, id: body.id || crypto.randomUUID() };
    rows.push(row);
    await persist();
    return sendJson(res, 201, row);
  }

  const index = id ? rows.findIndex(r => r && r.id === id) : -1;
  if (id && index === -1) return sendJson(res, 404, { error: "not found" });

  if (req.method === "PATCH" && id) {
    const body = await readBody(req);
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return sendJson(res, 400, { error: "JSON object expected" });
    }
    rows[index] = { ...rows[index], ...body, id: rows[index].id };
    await persist();
    return sendJson(res, 200, rows[index]);
  }

  if (req.method === "DELETE" && id) {
    const [removed] = rows.splice(index, 1);
    await persist();
    return sendJson(res, 200, removed || { ok: true });
  }

  return sendJson(res, 405, { error: "method not allowed" });
}

/* منع تقديم ملفات حساسة: .git (يحوي عنوان الريموت)، data، ملفات التشغيل */
function isBlockedPath(pathname) {
  const p = pathname.replace(/\\/g, "/");
  return (
    /^\/\./.test(p) ||
    /^\/data(\/|$)/.test(p) ||
    /^\/server\.js$/.test(p) ||
    /^\/package(-lock)?\.json$/.test(p) ||
    /^\/start-server\.bat$/i.test(p)
  );
}

async function serveStatic(req, res, pathname) {
  if (req.method !== "GET" && req.method !== "HEAD") {
    return sendText(res, 405, "Method not allowed");
  }
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch (e) {
    return sendText(res, 400, "Bad request");
  }
  if (isBlockedPath(decoded)) return sendText(res, 404, "Not found");

  let rel = decoded === "/" ? "/index.html" : decoded;
  let file = path.resolve(ROOT, "." + rel);
  if (file !== ROOT && !file.startsWith(ROOT + path.sep)) return sendText(res, 403, "Forbidden");

  let stat;
  try {
    stat = await fsp.stat(file);
  } catch (e) {
    return sendText(res, 404, "Not found");
  }
  if (stat.isDirectory()) {
    file = path.join(file, "index.html");
    try {
      stat = await fsp.stat(file);
    } catch (e) {
      return sendText(res, 404, "Not found");
    }
  }

  const ext = path.extname(file).toLowerCase();
  cors(res);
  res.writeHead(200, {
    "Content-Type": MIME[ext] || "application/octet-stream",
    "Content-Length": stat.size,
    "Cache-Control": "no-cache",
    "X-Content-Type-Options": "nosniff"
  });
  if (req.method === "HEAD") return res.end();
  fs.createReadStream(file).on("error", () => res.destroy()).pipe(res);
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    if (req.method === "OPTIONS") {
      cors(res);
      res.writeHead(204);
      return res.end();
    }
    const pathname = url.pathname;
    if (pathname === "/tables" || pathname === "/tables/") {
      return sendJson(res, 200, { tables: [...TABLES] });
    }
    if (pathname.startsWith("/tables/")) {
      const parts = pathname.split("/").filter(Boolean);
      if (parts.length < 2 || parts.length > 3 || !TABLES.has(parts[1])) {
        return sendJson(res, 404, { error: "unknown table" });
      }
      const id = parts[2] ? decodeURIComponent(parts[2]) : null;
      return await handleApi(req, res, parts[1], id);
    }
    return await serveStatic(req, res, pathname);
  } catch (e) {
    const status = e.status || 500;
    if (status >= 500) console.error("⚠", e);
    if (!res.headersSent) sendJson(res, status, { error: e.message || "server error" });
    else res.destroy();
  }
});

/* ---------------------------------------------------------------- launch */

function lanUrls() {
  const urls = [];
  const ifaces = os.networkInterfaces();
  Object.keys(ifaces).forEach(name => {
    (ifaces[name] || []).forEach(addr => {
      if (addr && addr.family === "IPv4" && !addr.internal) {
        urls.push(`http://${addr.address}:${PORT}/`);
      }
    });
  });
  return [...new Set(urls)];
}

(async () => {
  await loadDb();
  server.listen(PORT, HOST, () => {
    const urls = lanUrls();
    console.log("");
    console.log("  اختبار المنهاج النبوي — الخادم المحلي يعمل");
    console.log("  ------------------------------------------------");
    console.log(`  على هذا الجهاز :  http://localhost:${PORT}/`);
    urls.forEach(u => console.log(`  على الشبكة     :  ${u}`));
    if (!urls.length) {
      console.log("  ⚠ لم يُعثر على عنوان شبكة محلية — تحقّق من اتصال Wi-Fi.");
    }
    console.log("");
    console.log("  افتح فضاء المشرف من عنوان الشبكة أعلاه، ثم وزّع نفس");
    console.log("  العنوان على المترشحين (هاتف/حاسوب متصل بنفس Wi-Fi).");
    console.log("  للإيقاف: Ctrl+C");
    console.log("");
  });
})();

async function shutdown() {
  console.log("\n  إيقاف الخادم...");
  server.close(() => {});
  await writeQueue;
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
