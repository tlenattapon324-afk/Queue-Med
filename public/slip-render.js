/**
 * Shared slip renderer — settings preview, browser print (queue.html / settings.html)
 * and barcode/QR image generation for direct print.
 * Layout/styling rules must match slip-print.js (server / Print Agent).
 * Needs /vendor/jsbarcode.min.js (CODE128) and /vendor/qrcode.js (QR) loaded first.
 */
(function () {
  const DEFAULT_ORDER = ['header','patientName','hnQn','pttype','queueType','queueNum','barcode','dateTime','footer'];

  // Default per-section style — matches the original fixed look
  const STYLE_DEFAULTS = {
    header:      { align:'center', bold:true,  color:'black' },
    patientName: { align:'center', bold:true,  color:'black' },
    hnQn:        { align:'center', bold:false, color:'gray'  },
    pttype:      { align:'center', bold:false, color:'black' },
    queueType:   { align:'center', bold:false, color:'black' },
    queueNum:    { align:'center', bold:true,  color:'black' },
    dateTime:    { align:'center', bold:false, color:'gray'  },
    footer:      { align:'center', bold:false, color:'gray'  },
    logo:        { align:'center' },
    barcode:     { align:'center' },
  };

  const MM_PER_PX = 0.2; // barcode: 2px per module → 0.4mm module width on paper

  const esc = s => String(s == null ? '' : s)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  const val = (x, d) => x !== undefined && x !== null && x !== '' ? x : d;

  function style(cfg, id) {
    return Object.assign({}, STYLE_DEFAULTS[id] || { align:'center', bold:false, color:'black' },
                         (cfg.sectionStyles || {})[id] || {});
  }

  // {queue} {type} {hn} {qn} {name} {pttype} {date} {time} {hospital}
  function fill(text, d) {
    return String(text || '').replace(/\{(queue|type|hn|qn|name|pttype|date|time|hospital)\}/g, (_, k) => ({
      queue: d.display, type: d.typeName, hn: d.hn, qn: d.qn, name: d.patientName, pttype: d.pttypeName,
      date: d.date, time: d.issuedAt, hospital: d.sysName,
    }[k] || ''));
  }

  const colorCss = c => c === 'gray' ? '#555' : '#000';
  const textCss  = (st, fs, extra = '') =>
    `text-align:${st.align};font-size:${fs}pt;font-weight:${st.bold ? 800 : 400};color:${colorCss(st.color)};${extra}`;

  // Barcode / QR as PNG — the same image is shown in preview and sent to the printer
  function codeImage(cfg, d) {
    if (!cfg.showBarcode) return null;
    const value = cfg.barcodeSource === 'hn' ? d.hn : (d.qn || d.display);
    if (!value) return null;
    const showText = cfg.barcodeShowText !== false;
    const canvas = document.createElement('canvas');
    const g = canvas.getContext('2d');
    try {
      if (cfg.barcodeType === 'qr') {
        if (typeof qrcode === 'undefined') return null;
        const qr = qrcode(0, 'M');
        qr.addData(String(value)); qr.make();
        const n = qr.getModuleCount(), cell = 8, pad = cell * 2;
        const side = n * cell + pad * 2, textH = showText ? 44 : 0;
        canvas.width = side; canvas.height = side + textH;
        g.fillStyle = '#fff'; g.fillRect(0, 0, canvas.width, canvas.height);
        g.fillStyle = '#000';
        for (let r = 0; r < n; r++)
          for (let c = 0; c < n; c++)
            if (qr.isDark(r, c)) g.fillRect(pad + c * cell, pad + r * cell, cell, cell);
        if (showText) {
          g.font = 'bold 30px monospace'; g.textAlign = 'center'; g.textBaseline = 'middle';
          g.fillText(String(value), side / 2, side + textH / 2 - 4);
        }
        const wmm = Number(cfg.qrSize) || 25;
        return { dataUrl: canvas.toDataURL('image/png'), wmm, hmm: wmm * canvas.height / canvas.width };
      }
      if (typeof JsBarcode === 'undefined') return null;
      JsBarcode(canvas, String(value), {
        format:'CODE128', width:2, height: Math.round((Number(cfg.barcodeHeight) || 10) / MM_PER_PX),
        displayValue: showText, fontSize: 22, margin: 8, background:'#ffffff', lineColor:'#000000',
      });
      return { dataUrl: canvas.toDataURL('image/png'), wmm: canvas.width * MM_PER_PX, hmm: canvas.height * MM_PER_PX };
    } catch (e) {
      return null;
    }
  }

  function numBoxCss(box) {
    if (box === 'none')    return 'border:none;';
    if (box === 'thin')    return 'border:1px solid #000;';
    if (box === 'inverse') return 'border:3px solid #000;background:#000;color:#fff;-webkit-print-color-adjust:exact;print-color-adjust:exact;';
    return 'border:3px solid #000;';
  }

  function dividerHtml(styleName) {
    if (styleName === 'double') return `<div style="border-top:3px double #000;margin:5px 0"></div>`;
    if (styleName === 'solid')  return `<div style="border-top:1px solid #000;margin:5px 0"></div>`;
    if (styleName === 'dotted') return `<div style="border-top:2px dotted #888;margin:5px 0"></div>`;
    return `<div style="border-top:1px dashed #888;margin:5px 0"></div>`;
  }

  const imgHtml = (src, wmm, align) =>
    `<div style="text-align:${align};margin:4px 0;line-height:0"><img src="${src}" style="width:${wmm}mm;max-width:100%;height:auto"/></div>`;

  function html(cfg, d) {
    const box = val(cfg.numBoxStyle, 'thick');
    const builders = {
      logo: () => {
        if (!cfg.showLogo || !cfg.logoData) return '';
        return imgHtml(cfg.logoData, Number(cfg.logoWidth) || 30, style(cfg, 'logo').align);
      },
      header: () => {
        if (!cfg.showHeader) return '';
        const st = style(cfg, 'header'), fs = cfg.headerFontSize || 14;
        let h = `<div style="${textCss(st, fs, 'margin-bottom:2px')}">${esc(fill(cfg.headerName || d.sysName, d))}</div>`;
        if (cfg.headerSubtitle)
          h += `<div style="${textCss({ align: st.align, bold:false, color:'gray' }, fs - 3, 'margin-bottom:3px')}">${esc(fill(cfg.headerSubtitle, d))}</div>`;
        return h;
      },
      patientName: () => {
        if (!cfg.showPatientName || !d.patientName) return '';
        return `<div style="${textCss(style(cfg, 'patientName'), cfg.patientFontSize || 11, 'margin:2px 0')}">${esc(d.patientName)}</div>`;
      },
      hnQn: () => {
        if (!cfg.showHnQn || (!d.hn && !d.qn)) return '';
        const parts = [d.hn ? 'HN: ' + d.hn : '', d.qn ? 'QN: ' + d.qn : ''].filter(Boolean).join('&nbsp;&nbsp;&nbsp;');
        return `<div style="${textCss(style(cfg, 'hnQn'), (cfg.patientFontSize || 11) - 2, 'margin:2px 0')}">${parts}</div>`;
      },
      pttype: () => {
        if (!cfg.showPttype || !d.pttypeName) return '';
        const label = cfg.pttypeLabel != null ? cfg.pttypeLabel : 'สิทธิ: ';
        return `<div style="${textCss(style(cfg, 'pttype'), cfg.pttypeFontSize || 10, 'margin:2px 0')}">${esc(label + d.pttypeName)}</div>`;
      },
      queueType: () => {
        if (!cfg.showQueueType || !d.typeName) return '';
        if ((cfg.queueTypePosition || 'above') === 'left') return '';
        return `<div style="${textCss(style(cfg, 'queueType'), cfg.queueTypeFontSize || 11, 'margin:3px 0')}">${esc(d.typeName)}</div>`;
      },
      queueNum: () => {
        const numFs = cfg.queueNumFontSize || 60;
        if ((cfg.queueTypePosition || 'above') === 'left' && cfg.showQueueType && d.typeName) {
          const st = style(cfg, 'queueType');
          return `<div style="display:flex;align-items:center;gap:3px;margin:4px 0">` +
            `<div style="flex:0 0 35%;${textCss({ ...st, align:'center' }, cfg.queueTypeFontSize || 11, 'word-break:break-word;line-height:1.3')}">${esc(d.typeName)}</div>` +
            `<div style="flex:1;font-size:${numFs}pt;font-weight:900;text-align:center;letter-spacing:4px;color:#000;${numBoxCss(box)}padding:1px 4px;box-sizing:border-box">${esc(d.display)}</div>` +
            `</div>`;
        }
        return `<div style="font-size:${numFs}pt;font-weight:900;text-align:${style(cfg, 'queueNum').align};letter-spacing:4px;color:#000;${numBoxCss(box)}padding:1px 10px;display:inline-block;width:100%;box-sizing:border-box;margin:4px 0">${esc(d.display)}</div>`;
      },
      dateTime: () => {
        if (!cfg.showDateTime) return '';
        return `<div style="${textCss(style(cfg, 'dateTime'), cfg.dateFontSize || 9, 'margin:2px 0')}">${esc(d.date)} · ${esc(d.issuedAt)}</div>`;
      },
      barcode: () => {
        const img = codeImage(cfg, d);
        return img ? imgHtml(img.dataUrl, img.wmm, style(cfg, 'barcode').align) : '';
      },
      footer: () => {
        if (!cfg.showFooter || !cfg.footerText) return '';
        return `<div style="${textCss(style(cfg, 'footer'), cfg.footerFontSize || 8, 'margin:3px 0;line-height:1.6')}">${esc(fill(cfg.footerText, d)).replace(/\n/g, '<br/>')}</div>`;
      },
    };

    const order = (cfg.layoutOrder && cfg.layoutOrder.length) ? cfg.layoutOrder : DEFAULT_ORDER;
    let h = '', lastWasDivider = true; // no divider at the very top
    for (const id of order) {
      let part = '';
      if (id === 'divider') {
        if (cfg.showDividerLine !== false && !lastWasDivider) { h += dividerHtml(cfg.dividerStyle); lastWasDivider = true; }
        continue;
      } else if (id.startsWith('text:')) {
        const blk = (cfg.customTexts || []).find(b => 'text:' + b.id === id);
        if (blk && blk.text) {
          const st = { align: blk.align || 'center', bold: !!blk.bold, color: blk.color || 'black' };
          part = `<div style="${textCss(st, Number(blk.fs) || 10, 'margin:2px 0;line-height:1.5')}">${esc(fill(blk.text, d)).replace(/\n/g, '<br/>')}</div>`;
        }
      } else if (builders[id]) {
        part = builders[id]();
      }
      if (part) { h += part; lastWasDivider = false; }
    }
    // Fixed black-on-white so the host page's theme colours never leak into the slip
    const ff = cfg.fontFamily ? `font-family:'${esc(cfg.fontFamily)}',sans-serif;` : '';
    return `<div style="${ff}color:#000;background:#fff">${h}</div>`;
  }

  // Logo / barcode are <img>: wait until decoded, otherwise window.print() prints them blank
  function whenImagesReady(el, timeoutMs = 3000) {
    const imgs = [...el.querySelectorAll('img')];
    const ready = Promise.all(imgs.map(img => img.decode ? img.decode().catch(() => {})
      : new Promise(r => { if (img.complete) r(); else { img.onload = img.onerror = r; } })));
    return Promise.race([ready, new Promise(r => setTimeout(r, timeoutMs))]);
  }

  // ── Paper size — must match slip-print.js (paperWidthMm / paperHeightMm, 3mm margins) ──
  const MARGIN_MM = 3;
  const pxToMm = px => px * 25.4 / 96;

  // { w, h } in mm — h is null when the height is automatic (fit to content)
  function paperSize(cfg) {
    if (cfg.paperSize === 'a4')     return { w: 210, h: 297 };
    if (cfg.paperSize === '58mm')   return { w: 58,  h: null };
    if (cfg.paperSize === 'custom') return { w: Number(cfg.customWidth) || 80, h: Number(cfg.customHeight) || null };
    return { w: 80, h: null };
  }

  // Lay `el` out at the real paper size (same margins as direct print)
  function applyPaperBox(el, cfg) {
    const { w, h } = paperSize(cfg);
    Object.assign(el.style, {
      width: w + 'mm', boxSizing: 'border-box', padding: MARGIN_MM + 'mm', margin: '0',
      height: h ? h + 'mm' : '', overflow: h ? 'hidden' : '', background: '#fff',
    });
  }

  // Content height in mm of an element laid out by applyPaperBox (measured even if it is display:none)
  function measureHeightMm(el) {
    const prev = el.getAttribute('style') || '';
    const hidden = getComputedStyle(el).display === 'none';
    if (hidden) el.style.cssText = prev + ';display:block!important;position:fixed;left:-10000px;top:0;visibility:hidden';
    el.style.height = ''; el.style.overflow = ''; el.style.zoom = '';
    const mm = Math.ceil(pxToMm(el.scrollHeight)) + 2;
    el.setAttribute('style', prev);
    return mm;
  }

  // Render one slip into `el` at paper size, wait for images, return the exact @page CSS for printing
  async function preparePrint(el, cfg, d) {
    el.innerHTML = html(cfg, d);
    applyPaperBox(el, cfg);
    await whenImagesReady(el);
    const { w, h } = paperSize(cfg);
    const hh = h || measureHeightMm(el);
    // body reset: the host page's body margin / min-height would otherwise push the slip onto a 2nd page
    return { w, h: hh, pageCss: `@page{size:${w}mm ${hh}mm;margin:0}` +
      `html,body{margin:0!important;padding:0!important;min-height:0!important;height:auto!important;background:#fff!important}` };
  }

  window.SlipRender = { DEFAULT_ORDER, STYLE_DEFAULTS, style, fill, html, codeImage, whenImagesReady,
                        paperSize, applyPaperBox, measureHeightMm, preparePrint };
})();
