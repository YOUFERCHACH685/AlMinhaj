/* ==========================================================================
   gate.js — قفل صفحتَي «نموذجا الاختبار» و«التصحيح والتنقيط» للمشرف فقط
   يعمل بالتزامن مع فضاء المشرف (نفس رمز SHA-256 ونفس مفتاح الجلسة ونفس القفل).
   يُحمَّل قبل سكربت الصفحة: يخفي المحتوى فورًا ويعرض بوابة الدخول.
   ملاحظة: في موقع ساكن لا يمكن إخفاء مصدر الصفحة نفسه عن من يفتح «عرض المصدر»؛
   احمِ المسارَين على مستوى الاستضافة لسرية تامة (انظر README).
   ========================================================================== */
(function () {
  "use strict";

  const SESSION_KEY = "manhaj_admin_ok_v1";
  const LOCK_KEY = "manhaj_admin_lock_v1";
  const ACCESS_CODE_SHA256 = "841a489b150f64c3d9673eda5b7360dd28a59366ec31bc61fb0174cc3171897c";
  const MAX_TRIES = 5;
  const LOCK_MINUTES = 10;

  const authed = (() => {
    try { return sessionStorage.getItem(SESSION_KEY) === "1"; } catch (e) { return false; }
  })();

  function addLockButton() {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "btn btn-sm btn-ghost noprint";
    b.textContent = "قفل الصفحة (خروج المشرف)";
    b.style.cssText = "position:fixed;bottom:14px;left:14px;z-index:60";
    b.addEventListener("click", () => {
      try { sessionStorage.removeItem(SESSION_KEY); } catch (e) { /* ignore */ }
      location.reload();
    });
    document.body.appendChild(b);
  }

  if (authed) {
    /* المحتوى يُعرض عاديًا؛ أضف زر قفل عائم فقط */
    const mount = () => addLockButton();
    if (document.body) mount();
    else document.addEventListener("DOMContentLoaded", mount);
    return;
  }

  /* ---- غير مسموح: إخفاء المحتوى وبناء البوابة ---- */
  const style = document.createElement("style");
  style.textContent = ".site-head, footer.site-foot, main.wrap { display: none !important; }";
  document.head.appendChild(style);

  function lockInfo() {
    try {
      const l = JSON.parse(localStorage.getItem(LOCK_KEY) || "null");
      if (l && l.until && Date.now() < l.until) {
        return { locked: true, minutes: Math.ceil((l.until - Date.now()) / 60000) };
      }
      return { locked: false, count: (l && l.count) || 0 };
    } catch (e) {
      return { locked: false, count: 0 };
    }
  }
  function registerFailure() {
    try {
      const l = JSON.parse(localStorage.getItem(LOCK_KEY) || "null") || { count: 0 };
      const count = (l.count || 0) + 1;
      if (count >= MAX_TRIES) {
        localStorage.setItem(LOCK_KEY, JSON.stringify({ count: 0, until: Date.now() + LOCK_MINUTES * 60 * 1000 }));
        return { lockedNow: true, left: 0 };
      }
      localStorage.setItem(LOCK_KEY, JSON.stringify({ count }));
      return { lockedNow: false, left: MAX_TRIES - count };
    } catch (e) {
      return { lockedNow: false, left: MAX_TRIES };
    }
  }

  function buildGate() {
    const host = document.createElement("div");
    host.id = "admin-gate";
    host.className = "wrap";
    host.style.paddingTop = "70px";
    host.innerHTML = `
      <div style="max-width:460px;margin:0 auto">
        <div class="card card-pad-lg">
          <p class="eyebrow">منطقة محمية — للمشرف</p>
          <h1 style="font-size:1.45rem;margin-bottom:6px">هذه الصفحة للمشرف</h1>
          <p class="small muted" style="margin-bottom:16px">
            «نموذجا الاختبار» و«التصحيح والتنقيط» خاصان بالمشرف ولا يحتاجهما المترشح.
            أدخل رمز الدخول للمتابعة.
          </p>
          <form id="gate-form" novalidate>
            <label class="field">
              <span>رمز الدخول</span>
              <input type="password" id="gate-code" autocomplete="current-password" required placeholder="••••••••">
            </label>
            <p class="err" id="gate-err" role="alert"></p>
            <button class="btn btn-block" type="submit">دخول</button>
          </form>
          <p class="hint" style="margin-top:12px"><a href="index.html">→ عودة إلى صفحة الاختبار</a></p>
        </div>
      </div>`;
    document.body.appendChild(host);

    const form = host.querySelector("#gate-form");
    const input = host.querySelector("#gate-code");
    const err = host.querySelector("#gate-err");
    input.focus();

    form.addEventListener("submit", async ev => {
      ev.preventDefault();
      const lock = lockInfo();
      if (lock.locked) {
        err.textContent = `تم قفل الدخول مؤقتًا. حاول بعد ${lock.minutes} دقيقة.`;
        return;
      }
      try {
        const code = input.value.trim();
        const hash = await window.App.sha256hex(code);
        if (hash === ACCESS_CODE_SHA256) {
          try { localStorage.removeItem(LOCK_KEY); } catch (e) { /* ignore */ }
          try { sessionStorage.setItem(SESSION_KEY, "1"); } catch (e) { /* ignore */ }
          location.reload();
          return;
        }
        const fail = registerFailure();
        err.textContent = fail.lockedNow
          ? `تجاوزت عدد المحاولات — أُقفل الدخول لمدة ${LOCK_MINUTES} دقائق.`
          : `رمز الدخول غير صحيح. المحاولات المتبقية قبل القفل: ${fail.left}.`;
        input.select();
      } catch (e) {
        err.textContent = "تعذّر التحقق. حاول مجدًا.";
      }
    });
  }

  if (document.body) buildGate();
  else document.addEventListener("DOMContentLoaded", buildGate);
})();
