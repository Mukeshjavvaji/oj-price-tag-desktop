const QRCode = require('qrcode');
const fs = require('fs');
const path = require('path');

// The print window loads via a data: URL, so logos must be embedded as base64
// data URIs rather than referenced by path. Read once per file and cache.
const logoCache = {};
const BASE_PRINT_NUDGE_Y_MM = -2;

function getLogo(file) {
  if (file in logoCache) return logoCache[file];
  try {
    const p = path.join(__dirname, '..', '..', 'assets', 'logo', file);
    logoCache[file] = `data:image/png;base64,${fs.readFileSync(p).toString('base64')}`;
  } catch {
    logoCache[file] = ''; // fall back to text if the file is missing
  }
  return logoCache[file];
}

// Price with no decimals, e.g. "249.00" -> "Rs.249/-".
function rupees(v) {
  const n = parseFloat(v);
  return `Rs.${Number.isFinite(n) ? Math.round(n) : v}/-`;
}

// Split a SKU into two lines (after the last hyphen, like the SVG: "OJATK-" / "0002").
function skuLines(sku) {
  const s = String(sku);
  const i = s.lastIndexOf('-');
  const [a, b] = (i > 0 && i < s.length - 1)
    ? [s.slice(0, i + 1), s.slice(i + 1)]
    : [s.slice(0, Math.ceil(s.length / 2)), s.slice(Math.ceil(s.length / 2))];
  return `<span>${a}</span><span>${b}</span>`;
}

async function renderPrintHTML(payload) {
  // The renderer decides box vs tail (config-driven) and sends an explicit mode.
  const items = Array.isArray(payload) ? payload : (payload.items || []);
  const mode = Array.isArray(payload) ? 'box' : (payload.mode || 'box');
  // Print calibration offset (mm) for the active layout.
  const off = (Array.isArray(payload) ? null : payload.offset) || {};
  const offX = Number(off.x) || 0;
  const offY = (Number(off.y) || 0) + BASE_PRINT_NUDGE_Y_MM;

  // One QR per unique SKU.
  const uniqueBySku = new Map();
  for (const p of items) {
    if (!uniqueBySku.has(p.sku)) uniqueBySku.set(p.sku, p);
  }
  const qrBySku = new Map();
  await Promise.all(
    [...uniqueBySku.values()].map(async (p) => {
      if (!p.sku) return;
      const svg = await QRCode.toString(p.sku, {
        type: 'svg',
        margin: 0,
        errorCorrectionLevel: 'M',
      });
      qrBySku.set(p.sku, svg);
    })
  );

  // Expand by quantity, tagging each copy with its resolved layout.
  const expanded = items.flatMap((p) => {
    const qty = Math.max(0, Math.floor(p.quantity ?? 1));
    return Array(qty).fill(p);
  });

  const pairs = [];
  for (let i = 0; i < expanded.length; i += 2) pairs.push(expanded.slice(i, i + 2));

  const boxLogo = getLogo('Logo - Tag.png');
  const tailLogo = getLogo('tail-logo.png'); // ink-cropped for a bigger logo within 15mm

  // --- Box Tag (current production layout) ---
  const renderBoxTag = (p) => `
    <div class="price-tag box-tag">
      <div class="top-section">
        <div class="logo-section">${boxLogo ? `<img class="tag-logo" src="${boxLogo}" alt="Olive Jewellery">` : '<div class="logo-text">Olive</div>'}</div>
        <div class="price-section">
          <div class="price-row">
            <div class="price-label">MRP</div>
            <div class="price-value mrp">${rupees(p.compareAtPrice || p.price)}</div>
          </div>
          <div class="price-row">
            <div class="price-label">OJ Price</div>
            <div class="price-value">${rupees(p.price)}</div>
          </div>
        </div>
        <div class="qr-section">
          <div class="qr-code">${qrBySku.get(p.sku) || ''}</div>
          <div class="sku-text">${p.sku}</div>
        </div>
      </div>
      <div class="bottom-section">www.olivejewellery.in</div>
    </div>`;

  // --- Tail Tag (100x15mm, 1-up): MRP | OJ | QR | vertical SKU | logo, then blank tail ---
  const renderTailTag = (p, rotated) => `
    <div class="tail-tag${rotated ? ' rotated' : ''}">
      <div class="tail-block tail-mrp">
        <div class="tail-label">MRP</div>
        <div class="tail-value mrp">${rupees(p.compareAtPrice || p.price)}</div>
      </div>
      <div class="tail-block tail-oj">
        <div class="tail-label">OJ Price</div>
        <div class="tail-value">${rupees(p.price)}</div>
      </div>
      <div class="tail-qr">${qrBySku.get(p.sku) || ''}</div>
      <div class="tail-sku">${skuLines(p.sku)}</div>
      ${tailLogo ? `<img class="tail-logo" src="${tailLogo}" alt="Olive Jewellery">` : '<div class="logo-text">Olive</div>'}
    </div>`;

  // A print run is a single layout (enforced in the UI), so page geometry follows the mode.
  const isTail = mode === 'tail' || mode === 'tail-rotated';
  const pageH = isTail ? 15 : 25;
  // Paper choices for the preview dropdown (Electron can't read the printer's
  // list, so these are presets); default to this layout's exact label size.
  const defaultPaper = `100x${pageH}`;
  const paperOptionsHtml = [
    ['100x25', '100 × 25 mm (Box)'],
    ['100x15', '100 × 15 mm (Tail)'],
    ['A4', 'A4'],
    ['Letter', 'Letter'],
  ].map(([v, l]) => `<option value="${v}"${v === defaultPaper ? ' selected' : ''}>${l}</option>`).join('');
  const body = isTail
    ? expanded.map(p => `<div class="tail-row">${renderTailTag(p, mode === 'tail-rotated')}</div>`).join('')
    : pairs.map(pair => `<div class="tag-pair">${pair.map(renderBoxTag).join('')}</div>`).join('');

  return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Price Tags</title>
  <style>
    @page { size: 100mm ${pageH}mm; margin: 0; }
    * { margin: 0; padding: 0; box-sizing: border-box; }
    html, body { margin: 0; padding: 0; font-family: Arial, sans-serif; }
    .pages { margin: 0; padding: 0; }
    /* Box Tag: two 48.4mm tags with a 3.2mm gap = 100mm row (measured from the Canva design). */
    .tag-pair {
      width: 100mm; height: 25mm;
      display: flex; gap: 3.2mm; page-break-after: always;
    }
    .tag-pair:last-child { page-break-after: auto; }
    .price-tag {
      width: 48.4mm; height: 25mm;
      display: flex; flex-direction: column; background: white;
    }
    .top-section {
      display: grid; grid-template-columns: 16mm 16.4mm 16mm;
      height: 20mm; border-bottom: 0.3mm solid #000;
    }
    .logo-section {
      border-right: 0.3mm solid #000; display: flex;
      align-items: center; justify-content: center; padding: 0.4mm;
    }
    .logo-text { font-size: 9pt; font-weight: bold; font-style: italic; }
    /* Logo embedded once here (not per tag) so large print runs stay small. */
    .tag-logo { width: 100%; height: 19mm; object-fit: contain; display: block; }
    .price-section {
      border-right: 0.3mm solid #000; display: flex;
      flex-direction: column; padding: 1mm;
    }
    .price-row {
      display: flex; flex-direction: column;
      justify-content: center; align-items: center; text-align: center;
      border-bottom: 0.3mm solid #000;
    }
    .price-row:first-child { flex: 79; }
    .price-row:last-child { flex: 105; border-bottom: none; }
    .price-label { font-size: 5pt; font-weight: bold; }
    .price-row:last-child .price-label { font-size: 6.5pt; } /* OJ Price label bigger */
    .price-value { font-size: 9pt; font-weight: bold; }
    .price-value.mrp { font-weight: normal; font-size: 8pt; }
    .qr-section {
      display: flex; flex-direction: column; align-items: center;
      justify-content: center; padding: 1mm; transform: translateY(1mm);
    }
    .qr-code { width: 12mm; height: 12mm; }
    .qr-code svg { width: 100%; height: 100%; display: block; }
    .sku-text { font-size: 6.5pt; font-weight: bold; text-align: center; margin-top: 0.5mm; }
    .bottom-section {
      flex: 1; display: flex; align-items: center;
      justify-content: center; font-size: 8pt; letter-spacing: 0.65mm;
    }

    /* Tail Tag (100x15mm, 1-up): MRP | OJ | QR | vertical SKU | logo, then a blank tail. */
    .tail-row { width: 100mm; height: 15mm; overflow: hidden; page-break-after: always; }
    .tail-row:last-child { page-break-after: auto; }
    .tail-tag { width: 100mm; height: 15mm; overflow: hidden; display: flex; align-items: center; background: white; }
    .tail-tag.rotated { transform: rotate(180deg); }
    .tail-block {
      height: 100%; padding: 0 0.5mm;
      display: flex; flex-direction: column; align-items: center; justify-content: center; text-align: center;
    }
    /* Block widths match the SVG: divider at 14.75mm, OJ to ~31.75mm. */
    .tail-mrp { width: 14.75mm; border-right: 0.3mm solid #000; }
    .tail-oj { width: 17mm; }
    .tail-label { font-size: 8pt; font-weight: bold; }
    .tail-value { font-size: 9pt; font-weight: bold; }
    .tail-value.mrp { font-weight: normal; }
    /* QR sits near the top (a little top padding); everything else is vertically centered. */
    .tail-qr { width: 12.5mm; height: 12.5mm; margin-left: 5.25mm; align-self: flex-start; margin-top: 1.4mm; }
    .tail-qr svg { width: 100%; height: 100%; display: block; }
    .tail-sku { display: flex; flex-direction: row; gap: 0.3mm; margin-left: 1mm; }
    .tail-sku span {
      writing-mode: vertical-rl; transform: rotate(180deg);
      font-size: 6pt; font-weight: bold; letter-spacing: 0.2mm;
    }
    .tail-logo { width: 24mm; height: 13.5mm; object-fit: contain; display: block; margin-left: 4mm; }

    /* Print calibration offset (mm) for the active layout. */
    .tag-pair, .tail-row { transform: translate(${offX}mm, ${offY}mm); }

    /* On-screen preview chrome — hidden when actually printing. */
    @media screen {
      html, body { background: #3c3c3c; }
      .toolbar {
        position: sticky; top: 0; z-index: 10; display: flex; align-items: center; gap: 10px;
        padding: 10px 14px; background: #fff; border-bottom: 1px solid #ccc;
        font-family: -apple-system, "Segoe UI", system-ui, sans-serif; font-size: 14px;
      }
      .toolbar label { display: flex; align-items: center; gap: 6px; }
      .toolbar select { padding: 5px 6px; max-width: 320px; }
      .toolbar .spacer { flex: 1; }
      .toolbar .pv-msg { color: #b32d2d; font-size: 13px; }
      .toolbar button { padding: 6px 16px; border-radius: 4px; cursor: pointer; font-size: 14px; border: 1px solid #bbb; background: #f3f3f3; }
      .toolbar #print { background: #ffa3bc; border-color: #ffa3bc; color: #3a1420; font-weight: 600; }
      .pages { padding: 24px; display: flex; flex-direction: column; align-items: center; gap: 12px; }
      .pages > div { zoom: 1.8; background: #fff; box-shadow: 0 2px 10px rgba(0,0,0,0.5); }
    }
    @media print {
      .toolbar { display: none; }
      .pages { padding: 0; }
    }
  </style>
</head>
<body>
  <div class="toolbar">
    <label>Printer: <select id="printer"></select></label>
    <label>Paper: <select id="paper">${paperOptionsHtml}</select></label>
    <span id="pv-msg" class="pv-msg"></span>
    <span class="spacer"></span>
    <button id="cancel">Cancel</button>
    <button id="print">Print</button>
  </div>
  <div class="pages">${body}</div>
  <script>
    (function () {
      var sel = document.getElementById('printer');
      var msg = document.getElementById('pv-msg');
      window.previewApi.getPrinters().then(function (r) {
        var list = (r && r.printers) || [], def = (r && r.defaultPrinter) || '';
        sel.innerHTML = list.length ? list.map(function (p) {
          var s = (def ? p.name === def : p.isDefault) ? ' selected' : '';
          return '<option value="' + p.name.replace(/"/g, '&quot;') + '"' + s + '>' + (p.displayName || p.name) + '</option>';
        }).join('') : '<option value="">No printers found</option>';
      });
      document.getElementById('print').onclick = function () {
        if (!sel.value) { msg.textContent = 'Select a printer'; return; }
        this.disabled = true; msg.textContent = 'Printing…';
        var btn = this;
        var paper = document.getElementById('paper').value;
        window.previewApi.print(sel.value, paper).then(function (r) {
          if (r && r.ok) { window.previewApi.cancel(); }
          else { btn.disabled = false; msg.textContent = 'Print failed: ' + ((r && r.reason) || ''); }
        });
      };
      document.getElementById('cancel').onclick = function () { window.previewApi.cancel(); };
    })();
  </script>
</body>
</html>`;
}

module.exports = { renderPrintHTML };
