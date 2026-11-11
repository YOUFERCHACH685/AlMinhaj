/* ==========================================================================
   word.js — تصدير بنك الأسئلة إلى ملف Word حقيقي (.docx) من المتصفح
   بدون أي مكتبة خارجية: ZIP (تخزين فقط) + CRC-32 + XML يدوي.
   يعمل دون اتصال بالإنترنت، ويعمل أيضًا تحت Node للاختبار.
   ========================================================================== */
(function (global) {
  "use strict";

  /* ---------------------------------------------------------- CRC-32 */
  const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      t[n] = c >>> 0;
    }
    return t;
  })();
  function crc32(bytes) {
    let c = 0xFFFFFFFF;
    for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }

  /* ---------------------------------------------------------- ZIP (stored) */
  const u16 = v => [v & 255, (v >>> 8) & 255];
  const u32 = v => [v & 255, (v >>> 8) & 255, (v >>> 16) & 255, (v >>> 24) & 255];

  function zipStore(entries) {
    const enc = new TextEncoder();
    const parts = [];
    const central = [];
    let offset = 0;

    const now = new Date();
    const dosTime = ((now.getHours() << 11) | (now.getMinutes() << 5) | Math.floor(now.getSeconds() / 2)) & 0xFFFF;
    const dosDate = ((((now.getFullYear() - 1980) & 0x7F) << 9) | ((now.getMonth() + 1) << 5) | now.getDate()) & 0xFFFF;

    for (const entry of entries) {
      const nameBytes = enc.encode(entry.name);
      const crc = crc32(entry.data);
      const local = new Uint8Array([
        ...u32(0x04034B50), ...u16(20), ...u16(0x0800), ...u16(0),
        ...u16(dosTime), ...u16(dosDate),
        ...u32(crc), ...u32(entry.data.length), ...u32(entry.data.length),
        ...u16(nameBytes.length), ...u16(0)
      ]);
      parts.push(local, nameBytes, entry.data);
      central.push({ nameBytes, crc, size: entry.data.length, offset });
      offset += local.length + nameBytes.length + entry.data.length;
    }

    const cdParts = [];
    let cdSize = 0;
    for (const c of central) {
      const rec = new Uint8Array([
        ...u32(0x02014B50), ...u16(20), ...u16(20), ...u16(0x0800), ...u16(0),
        ...u16(dosTime), ...u16(dosDate),
        ...u32(c.crc), ...u32(c.size), ...u32(c.size),
        ...u16(c.nameBytes.length), ...u16(0), ...u16(0), ...u16(0), ...u16(0),
        ...u32(0), ...u32(c.offset)
      ]);
      cdParts.push(rec, c.nameBytes);
      cdSize += rec.length + c.nameBytes.length;
    }

    const eocd = new Uint8Array([
      ...u32(0x06054B50), ...u16(0), ...u16(0),
      ...u16(central.length), ...u16(central.length),
      ...u32(cdSize), ...u32(offset), ...u16(0)
    ]);

    const type = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    if (typeof Blob !== "undefined") {
      return new Blob([...parts, ...cdParts, eocd], { type });
    }
    /* Node (اختبار) */
    const total = [...parts, ...cdParts, eocd].reduce((s, p) => s + p.length, 0);
    const out = new Uint8Array(total);
    let o = 0;
    for (const p of [...parts, ...cdParts, eocd]) { out.set(p, o); o += p.length; }
    return out;
  }

  /* ---------------------------------------------------------- XML */
  function xesc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }
  const xmlText = s => new TextEncoder().encode(s);

  /* ---------------------------------------------------------- بناء الكتل */
  const H = {
    normal: { size: 24 },          /* 12pt */
    note:   { size: 19, color: "6B5A1E", italic: true },  /* ~9.5pt */
    h1:     { size: 34, bold: true, color: "0B4A38" },    /* 17pt */
    h2:     { size: 25, bold: true, color: "0E5C45" },    /* 12.5pt */
    h3:     { size: 23, bold: true, color: "12211C" }
  };

  function runXml(r) {
    const props = [
      '<w:rFonts w:ascii="Amiri" w:hAnsi="Amiri" w:cs="Amiri" w:eastAsia="Amiri"/>',
      r.bold ? "<w:b/><w:bCs/>" : "",
      r.italic ? "<w:i/><w:iCs/>" : "",
      r.color ? `<w:color w:val="${r.color}"/>` : "",
      `<w:sz w:val="${r.size || H.normal.size}"/><w:szCs w:val="${r.size || H.normal.size}"/>`,
      "<w:rtl/>"
    ].join("");
    return `<w:r><w:rPr>${props}</w:rPr><w:t xml:space="preserve">${xesc(r.t)}</w:t></w:r>`;
  }

  /* فقرة واحدة: runs = سلسلة أو مصفوفة {t,bold,italic,color,size} */
  function paraXml(runs, o) {
    o = o || {};
    const list = Array.isArray(runs) ? runs : [{ t: runs }];
    const pPr = [
      "<w:pStyle w:val=\"Normal\"/>",
      o.keepNext ? "<w:keepNext/>" : "",
      o.pageBreakBefore ? "<w:pageBreakBefore/>" : "",
      o.borderBottom ? '<w:pBdr><w:bottom w:val="single" w:sz="8" w:space="4" w:color="B98B3A"/></w:pBdr>' : "",
      "<w:bidi/>",
      o.indent ? `<w:ind w:start="${o.indent}" w:hanging="${o.indent}"/>` : "",
      `<w:spacing w:before="${o.before || 0}" w:after="${o.after == null ? 140 : o.after}" w:line="276" w:lineRule="auto"/>`,
      o.align ? `<w:jc w:val="${o.align}"/>` : ""
    ].join("");
    return `<w:p><w:pPr>${pPr}</w:pPr>${list.map(runXml).join("")}</w:p>`;
  }

  function pageBreakXml() {
    return '<w:p><w:r><w:br w:type="page"/></w:r></w:p>';
  }

  /* جدول بإطار ذهبي خفيف — أعمدة RTL */
  function tableXml(headers, rows, widths) {
    const total = widths.reduce((a, b) => a + b, 0);
    const grid = widths.map(w => `<w:gridCol w:w="${w}"/>`).join("");
    const borders = ["top", "left", "bottom", "right", "insideH", "insideV"]
      .map(s => `<w:${s} w:val="single" w:sz="6" w:space="0" w:color="C9D6CB"/>`).join("");
    const cell = (text, w, opts) => {
      opts = opts || {};
      const shd = opts.fill ? `<w:shd w:val="clear" w:color="auto" w:fill="${opts.fill}"/>` : "";
      const runs = (Array.isArray(text) ? text : [{ t: String(text), bold: !!opts.bold, size: opts.size || H.normal.size, color: opts.color }]);
      return `<w:tc><w:tcPr><w:tcW w:w="${w}" w:type="dxa"/>${shd}</w:tcPr>` +
        `<w:p><w:pPr><w:bidi/><w:spacing w:after="40"/></w:pPr>${runs.map(runXml).join("")}</w:p></w:tc>`;
    };
    const trs = [];
    if (headers && headers.length) {
      trs.push(`<w:tr><w:trPr><w:tblHeader/></w:trPr>${headers.map((hcell, i) =>
        cell(hcell, widths[i], { fill: "E6F1EC", bold: true })).join("")}</w:tr>`);
    }
    rows.forEach(r => {
      trs.push(`<w:tr>${r.map((c, i) => cell(c, widths[i])).join("")}</w:tr>`);
    });
    return `<w:tbl><w:tblPr><w:bidiVisual/><w:tblW w:w="${total}" w:type="dxa"/>` +
      `<w:tblBorders>${borders}</w:tblBorders><w:tblLayout w:type="fixed"/>` +
      `<w:tblCellMar><w:top w:w="80" w:type="dxa"/><w:left w:w="110" w:type="dxa"/><w:bottom w:w="80" w:type="dxa"/><w:right w:w="110" w:type="dxa"/></w:tblCellMar>` +
      `<w:tblLook w:val="04A0" w:firstRow="1" w:lastRow="0" w:firstColumn="1" w:lastColumn="0" w:noHBand="0" w:noVBand="1"/></w:tblPr>` +
      `<w:tblGrid>${grid}</w:tblGrid>${trs.join("")}</w:tbl>`;
  }

  const DOCX_CONTENT_TYPES =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
    '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>' +
    '<Override PartName="/word/settings.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml"/>' +
    '</Types>';

  const RELS_ROOT =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
    '</Relationships>';

  const RELS_DOC =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>' +
    '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/settings" Target="settings.xml"/>' +
    '</Relationships>';

  const SETTINGS_XML =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<w:settings xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
    '<w:zoom w:percent="100"/><w:defaultTabStop w:val="720"/></w:settings>';

  const STYLES_XML =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
    '<w:docDefaults><w:rPrDefault><w:rPr>' +
    '<w:rFonts w:ascii="Amiri" w:hAnsi="Amiri" w:cs="Amiri" w:eastAsia="Amiri"/>' +
    '<w:sz w:val="24"/><w:szCs w:val="24"/><w:lang w:val="ar-SA" w:bidi="ar-SA"/>' +
    '</w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:bidi/></w:pPr></w:pPrDefault></w:docDefaults>' +
    '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/>' +
    '<w:qFormat/><w:pPr><w:spacing w:after="140" w:line="276" w:lineRule="auto"/><w:bidi/></w:pPr></w:style>' +
    '<w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:qFormat/>' +
    '<w:pPr><w:spacing w:before="0" w:after="160"/></w:pPr>' +
    '<w:rPr><w:b/><w:bCs/><w:color w:val="0B4A38"/><w:sz w:val="44"/><w:szCs w:val="44"/></w:rPr></w:style>' +
    '</w:styles>';

  const LETTERS = ["أ", "ب", "ج", "د", "هـ", "و"];

  function formTotal(formObj) {
    return formObj.questions.reduce((s, q) => s + Number(q.points || 0), 0);
  }

  /* ---------------------------------------------------------- محتوى الوثيقة */
  function buildDocumentXml(bank, settings, formKeys) {
    const meta = bank.meta || {};
    const blocks = [];
    const today = new Date().toLocaleDateString("ar", { year: "numeric", month: "long", day: "numeric" });

    blocks.push(paraXml([{ t: meta.title || "اختبار في المنهاج النبوي", style: "Title", bold: true, size: 44, color: "0B4A38" }], { style: "Title", after: 60, borderBottom: true }));
    blocks.push(paraXml([{ t: "بنك أسئلة الاختبار — نسخة Word", bold: true, size: 28, color: "B98B3A" }], { after: 120 }));
    blocks.push(paraXml([{ t: meta.reference || "", italic: true, color: "3D5148", size: 22 }], { after: 60 }));
    if (settings && settings.institution && settings.institution !== meta.title) {
      blocks.push(paraXml([{ t: settings.institution, color: "3D5148", size: 22 }], { after: 60 }));
    }
    blocks.push(paraXml([
      { t: `إصدار البنك: `, bold: true }, { t: `v${bank.version || 1}   ·   آخر تحديث: ${bank.updatedAt || "—"}   ·   تاريخ التصدير: ${today}` }
    ], { after: 240 }));

    /* تعليمات التصحيح */
    blocks.push(paraXml([{ t: "إرشادات عامة", bold: true, size: H.h2.size, color: H.h2.color }], { keepNext: true, before: 120, after: 80, borderBottom: true }));
    const refForm = bank.forms.A || bank.forms[Object.keys(bank.forms)[0]] || { questions: [] };
    const refMcq = refForm.questions.filter(q => q.type === "mcq");
    const refOpen = refForm.questions.filter(q => q.type === "open");
    const refMcqPts = refMcq.reduce((s, q) => s + Number(q.points || 0), 0);
    const refOpenPts = refOpen.reduce((s, q) => s + Number(q.points || 0), 0);
    const refTotal = formTotal(refForm);
    const instr = [
      `الامتحان: ${refMcq.length} أسئلة اختيار من متعدد (${refMcqPts} نقطة) + ${refOpen.length} أسئلة تعبير (${refOpenPts} نقطة) = ${refTotal} نقطة.`,
      `توقيت كل سؤال اختيار: ${(settings && settings.mcqSeconds) || meta.mcqSeconds || 45} ثانية، ولكل سؤال تعبير: ${Math.round(((settings && settings.openSeconds) || meta.openSeconds || 180) / 60)} دقائق.`,
      "الترتيب الظاهر في هذه الوثيقة هو ترتيب التخزين؛ في الاختبار الحقيقي تُخلَط الأسئلة والاختيارات لكل مترشح.",
      "المجموع موزّع بحسب أهمية المفهوم في المنهاج، لا بحسب صعوبته: المحاور المركزية (شروط التربية، النواظم الثلاث، العقبات الثلاث، الخصال العشر) = 6–7 نقاط.",
      "نقطة التعبير الآلية احتياطية؛ يراجعها المشرف ويثبّتها يدويًا من «النتائج ← تفاصيل ← حفظ وتثبيت النقطة»."
    ];
    instr.forEach(line => blocks.push(paraXml([{ t: "• " + line }], { indent: 360, after: 80 })));

    /* الأقسام لكل نموذج */
    formKeys.forEach((key, idx) => {
      const f = bank.forms[key];
      if (!f) return;
      blocks.push(pageBreakXml());
      blocks.push(paraXml([{ t: f.label, bold: true, size: H.h1.size, color: H.h1.color }], { keepNext: true, borderBottom: true, after: 60 }));
      blocks.push(paraXml([
        { t: `المجموع: `, bold: true }, { t: `${formTotal(f)} نقطة` },
        { t: `   ·   عدد الأسئلة: `, bold: true }, { t: `${f.questions.length}` }
      ], { after: 200 }));

      const letters = LETTERS;
      f.questions.forEach((q, i) => {
        const typeLabel = q.type === "mcq" ? "اختيار من متعدد" : "تعبير";
        blocks.push(paraXml([
          { t: `السؤال ${i + 1} — ${q.topic || ""}   `, bold: true, size: H.h2.size, color: H.h2.color },
          { t: `(${q.points} نقطة · ${typeLabel})`, color: "B98B3A", bold: true, size: 20 }
        ], { keepNext: true, before: 200, after: 60 }));

        blocks.push(paraXml([{ t: q.text }], { after: 100 }));

        if (q.type === "mcq") {
          (q.options || []).forEach((o, oi) => {
            blocks.push(paraXml([
              { t: `${letters[oi] || oi + 1}.  `, bold: true, color: "0E5C45" },
              { t: o.text }
            ], { indent: 360, after: 60 }));
          });
        } else {
          blocks.push(paraXml([{ t: "(الجواب في حدود سطرين إلى أربعة أسطر)", italic: true, color: "6B7280", size: 20 }], { after: 40 }));
          for (let l = 0; l < 4; l++) {
            blocks.push('<w:p><w:pPr><w:bidi/><w:pBdr><w:bottom w:val="dotted" w:sz="6" w:space="2" w:color="9CA3AF"/></w:pBdr><w:spacing w:after="360"/></w:pPr></w:p>');
          }
        }
      });
    });

    /* مفتاح الإجابات */
    blocks.push(pageBreakXml());
    blocks.push(paraXml([{ t: "مفتاح الإجابات والتصحيح", bold: true, size: H.h1.size, color: H.h1.color }], { keepNext: true, borderBottom: true, after: 60 }));
    blocks.push(paraXml([{ t: "هذا القسم خاص بالمشرف لتصحيح النسخ؛ لا يُوزَّع على المترشحين.", bold: true, color: "A8322A", size: 22 }], { after: 240 }));

    formKeys.forEach(key => {
      const f = bank.forms[key];
      if (!f) return;
      blocks.push(paraXml([{ t: f.label, bold: true, size: H.h2.size, color: H.h2.color }], { keepNext: true, before: 160, after: 100, borderBottom: true }));

      const mcq = f.questions.filter(q => q.type === "mcq");
      const open = f.questions.filter(q => q.type === "open");

      if (mcq.length) {
        blocks.push(paraXml([{ t: "أسئلة الاختيار من متعدد", bold: true, size: 22 }], { keepNext: true, after: 60 }));
        const rows = mcq.map(q => {
          const ci = (q.options || []).findIndex(o => o.id === q.correct);
          const correctText = ci >= 0 ? `${LETTERS[ci] || ci + 1} — ${(q.options[ci] || {}).text || ""}` : "";
          return [String(f.questions.indexOf(q) + 1), String(q.points), correctText, q.explain || ""];
        });
        blocks.push(tableXml(
          ["#", "النقطة", "الجواب الصحيح", "التوضيح (المرجع)"],
          rows,
          [640, 900, 3400, 4698]
        ));
        blocks.push(paraXml([{ t: "" }], { after: 160 }));
      }

      open.forEach(q => {
        const qi = f.questions.indexOf(q) + 1;
        blocks.push(paraXml([
          { t: `السؤال ${qi} — ${q.topic || ""}   `, bold: true, size: 22, color: H.h3.color },
          { t: "(تعبير)", color: "B98B3A", bold: true, size: 20 }
        ], { keepNext: true, before: 160, after: 60 }));
        blocks.push(paraXml([{ t: "الإجابة النموذجية: ", bold: true }, { t: q.modelAnswer || "—" }], { after: 80 }));
        const rub = q.rubric || [];
        if (rub.length) {
          const rows = rub.map(r => [r.label || "", String(r.points), (r.keywords || []).join("، ")]);
          blocks.push(tableXml(["عنصر التنقيط", "النقاط", "كلمات مفتاحية (الكشف الآلي)"], rows, [3400, 900, 5338]));
          blocks.push(paraXml([{ t: "" }], { after: 120 }));
        }
      });
    });

    blocks.push(paraXml([{ t: `أُنشئت هذه الوثيقة آليًا من فضاء المشرف بتاريخ ${today}.`, italic: true, color: "6B7280", size: 18 }], { before: 240 }));

    return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" ' +
      'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
      '<w:body>' + blocks.join("") +
      '<w:sectPr><w:pgSz w:w="11906" w:h="16838" w:orient="portrait"/>' +
      '<w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134" w:header="567" w:footer="567" w:gutter="0"/>' +
      '<w:bidi/></w:sectPr></w:body></w:document>';
  }

  function buildDocxBlob(bank, settings, formKeys) {
    const documentXml = buildDocumentXml(bank, settings, formKeys);
    const entries = [
      { name: "[Content_Types].xml", data: xmlText(DOCX_CONTENT_TYPES) },
      { name: "_rels/.rels", data: xmlText(RELS_ROOT) },
      { name: "word/document.xml", data: xmlText(documentXml) },
      { name: "word/_rels/document.xml.rels", data: xmlText(RELS_DOC) },
      { name: "word/styles.xml", data: xmlText(STYLES_XML) },
      { name: "word/settings.xml", data: xmlText(SETTINGS_XML) }
    ];
    return zipStore(entries);
  }

  function stamp() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  }

  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  }

  /* الدالة الرئيسية: formKeys = ["A"] أو ["B"] أو ["A","B"] */
  function downloadQuestionsDocx(bank, settings, formKeys) {
    const keys = (formKeys && formKeys.length ? formKeys : ["A"]).filter(k => bank.forms && bank.forms[k]);
    const safeKeys = keys.length ? keys : ["A"];
    const blob = buildDocxBlob(bank, settings, safeKeys);
    const tag = safeKeys.length > 1 ? "AB" : safeKeys[0];
    const filename = `بنك-الأسئلة-${tag}-${stamp()}.docx`;
    downloadBlob(blob, filename);
    return filename;
  }

  global.WordExport = {
    downloadQuestionsDocx,
    buildDocxBlob,   /* للاختبار */
    _internals: { crc32, zipStore, xesc }
  };
})(typeof window !== "undefined" ? window : globalThis);
