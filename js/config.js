/* ==========================================================================
   config.js — إعدادات النشر
   عدّل هذا الملف فقط. لا تحتاج إلى لمس بقية الملفات.
   ========================================================================== */
window.MANHAJ_CONFIG = {
  /* عنوان Firebase Realtime Database (مجاني) لمزامنة الجلسات بين الهواتف.
     مثال: "https://manhaj-12345-default-rtdb.firebaseio.com"
     اتركه فارغًا إذا كنت تستعمل التخزين المحلي أو خادم tables المحلي.
     يمكن للمشرف أيضًا لصق العنوان من «الإعدادات» داخل فضاء المشرف. */
  firebaseUrl: "https://alminhaj-test-default-rtdb.europe-west1.firebasedatabase.app",

  /* جذر البيانات داخل قاعدة Firebase (غيّره إذا أردت عزْل اختبار آخر). */
  firebaseRoot: "manhaj",

  /* مفتاح Firebase Web API (يُنسخ من Project settings → General).
     عند تعبئته يُفعَّل تسجيل دخول مجهول تلقائيًا لكل زائر، ولا تعمل
     القاعدة إلا لمن يملك توكن صالحًا (auth != null).
     اتركه فارغًا مؤقتًا إن لم تكن قد فعّلت Anonymous في Firebase. */
  firebaseApiKey: "AIzaSyCPQ1oHaVyLDA6wY9B43MJhMUNxa93EZ7s",

  /* حساب المشرف المعتمد (Firebase → Authentication → Email/Password).
     البريد يُملأ تلقائيًا في نموذج الدخول، والمعرّف (UID) هو نفسه
     المستعمل في قواعد Firebase لتقييد الكتابة على المشرف وحده.
     كلمة المرور لا تُخزَّن في هذه الملفات: غيّرها من «الإعدادات»
     ← «أمان حساب المشرف» داخل فضاء المشرف. */
  adminEmail: "admin@alminhaj.local",
  adminUid: "QafQ4Dtou0WB0VatlyJifIEwt6y2"
};
