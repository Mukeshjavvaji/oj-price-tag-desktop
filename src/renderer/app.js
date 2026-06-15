const $ = (sel) => document.querySelector(sel);

const state = {
  products: [],
  // variantId -> { productTitle, variantTitle, sku, price, compareAtPrice, quantity }
  // Stores everything needed to print, so selection survives across searches.
  selection: new Map(),
  expanded: new Set(), // productIds whose variant list is open
  filters: { collections: [], tags: [] }, // available options from the store
  selCollections: new Set(), // selected collection gids (match ANY)
  selTags: new Set(), // selected tags (match ALL)
  layoutMode: 'box', // tag layout at print time: 'box' | 'tail' (auto-set on first selection)
  tailTags: [], // tags that map to Tail Tag (from config)
  tailTagsDraft: [], // working copy while the Settings modal is open
  offsets: { box: { x: 0, y: 0 }, tail: { x: 0, y: 0 } }, // print calibration (mm)
  configured: false,
};

// ----- Theme (persisted in localStorage) -----

const LOGO_LIGHT = '../../assets/logo/Logo%20Final.png';
const LOGO_DARK = '../../assets/logo/logo%20dark.png';

// Monochrome outline icons (Feather-style); inherit color via currentColor.
const ICON_MOON = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>';
const ICON_SUN = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>';

function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  const btn = document.querySelector('#theme-toggle');
  if (btn) {
    btn.innerHTML = theme === 'dark' ? ICON_SUN : ICON_MOON;
    btn.title = theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode';
  }
  const logo = document.querySelector('#brand-logo');
  if (logo) logo.src = theme === 'dark' ? LOGO_DARK : LOGO_LIGHT;
}

function toggleTheme() {
  const current = document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
  const next = current === 'dark' ? 'light' : 'dark';
  localStorage.setItem('theme', next);
  applyTheme(next);
}

// Apply before first paint to avoid a flash of the wrong theme.
applyTheme(localStorage.getItem('theme') || 'light');

// ----- Init -----

(async function init() {
  const cfg = await window.api.configRead();
  state.tailTags = cfg.tailTags || [];
  if (cfg.offsets) state.offsets = cfg.offsets;
  if (!cfg.shop || !cfg.apiKey || !cfg.apiSecret) {
    openSettings({ firstRun: true });
  } else {
    state.configured = true;
    await checkConnection();
    await loadFilters();
    await loadProducts('');
  }
  wireEvents();
})();

// ----- Connection status -----

async function checkConnection() {
  const cfg = await window.api.configRead();
  const r = await window.api.shopifyTest(cfg);
  const el = $('#conn-status');
  if (r.ok) {
    el.textContent = '';
    el.className = 'status ok';
  } else {
    el.textContent = 'Connection failed';
    el.className = 'status err';
  }
}

// ----- Product loading -----

let searchTimer = null;

async function loadProducts(term) {
  const list = $('#product-list');
  list.innerHTML = '<p class="empty">Loading…</p>';
  const r = await window.api.shopifySearch({
    term,
    collectionIds: [...state.selCollections],
    tags: [...state.selTags],
  });
  if (!r.ok) {
    list.innerHTML = `<p class="empty">Error: ${escapeHtml(r.error)}</p>`;
    return;
  }
  state.products = r.products;
  // Auto-expand groups when searching so matched variants are visible;
  // collapse by default for the full catalog list.
  const hasTerm = !!(term && term.trim());
  state.expanded = new Set(hasTerm ? state.products.map(p => p.id) : []);
  renderProductList();
}

function renderProductList() {
  const list = $('#product-list');
  if (state.products.length === 0) {
    list.innerHTML = '<p class="empty">No products found.</p>';
    return;
  }
  list.innerHTML = state.products.map(renderGroup).join('');
  list.querySelectorAll('.product-group').forEach(groupEl => {
    const pid = groupEl.dataset.id;
    const product = state.products.find(p => p.id === pid);
    if (!product) return;

    // Header: clicking it toggles expand, except when the click lands on the checkbox.
    const header = groupEl.querySelector('.group-header');
    header.addEventListener('click', (e) => {
      if (e.target.closest('input')) return;
      toggleExpand(pid);
    });

    // Group checkbox selects/deselects every variant.
    const groupCb = groupEl.querySelector('.group-select');
    const selCount = product.variants.filter(v => state.selection.has(v.id)).length;
    groupCb.indeterminate = selCount > 0 && selCount < product.variants.length;
    groupCb.addEventListener('change', (e) => toggleGroup(pid, e.target.checked));

    groupEl.querySelectorAll('.variant-row').forEach(row => {
      const vid = row.dataset.vid;
      row.querySelector('input[type=checkbox]').addEventListener('change', (e) => {
        toggleVariant(pid, vid, e.target.checked);
      });
      const qtyInput = row.querySelector('input[type=number]');
      if (qtyInput) {
        qtyInput.addEventListener('input', (e) => {
          updateQuantity(vid, parseInt(e.target.value, 10) || 0);
        });
      }
    });
  });
}

function priceRange(variants) {
  const nums = variants.map(v => parseFloat(v.price)).filter(n => !isNaN(n));
  if (!nums.length) return '';
  const min = Math.min(...nums), max = Math.max(...nums);
  return min === max ? `Rs.${min}` : `Rs.${min}–${max}`;
}

function renderGroup(p) {
  const expanded = state.expanded.has(p.id);
  const selCount = p.variants.filter(v => state.selection.has(v.id)).length;
  const allSelected = selCount === p.variants.length;
  const n = p.variants.length;
  return `
    <div class="product-group" data-id="${p.id}">
      <div class="group-header${selCount ? ' has-selection' : ''}">
        <button class="expand-toggle" aria-label="Expand">${expanded ? '▾' : '▸'}</button>
        <div class="checkbox"><input type="checkbox" class="group-select" ${allSelected ? 'checked' : ''} /></div>
        <div class="group-info">
          <div class="title">${escapeHtml(p.title)}</div>
          <div class="meta">${n} variant${n > 1 ? 's' : ''} · ${priceRange(p.variants)}</div>
        </div>
        <div class="group-count">${selCount ? `${selCount} selected` : ''}</div>
      </div>
      <div class="variant-list"${expanded ? '' : ' hidden'}>
        ${p.variants.map(renderVariant).join('')}
      </div>
    </div>`;
}

function renderVariant(v) {
  const sel = state.selection.get(v.id);
  const selected = !!sel;
  const qty = selected ? sel.quantity : (v.available > 0 ? v.available : 1);
  return `
    <div class="variant-row${selected ? ' selected' : ''}" data-vid="${v.id}">
      <div class="checkbox"><input type="checkbox" ${selected ? 'checked' : ''} /></div>
      <div class="v-info">
        <div class="title">${escapeHtml(v.title)}</div>
        <div class="meta">${escapeHtml(v.sku)}</div>
      </div>
      <div class="price">
        ${v.compareAtPrice && v.compareAtPrice !== v.price
          ? `<div class="strike">Rs.${escapeHtml(v.compareAtPrice)}</div>`
          : ''}
        <div>Rs.${escapeHtml(v.price)}</div>
      </div>
      <div class="available">Avail: ${v.available}</div>
      <div class="qty-cell">
        ${selected
          ? `<label>Qty</label><input type="number" min="0" value="${qty}" />`
          : '<span class="dash">—</span>'}
      </div>
    </div>`;
}

// ----- Filters (collections / tags) -----

async function loadFilters() {
  const r = await window.api.shopifyFilters();
  if (!r.ok) return; // filters are optional; skip silently if unavailable
  state.filters.collections = r.collections || [];
  state.filters.tags = r.tags || [];
  renderCollectionOptions('');
  renderTagOptions('');
  updateFilterBadges();
}

function renderFilterOptions(box, items, labelOf, valueOf, selSet, onChange) {
  box.innerHTML = items.length
    ? items.map(it => `
        <label class="filter-option">
          <input type="checkbox" value="${escapeHtml(valueOf(it))}" ${selSet.has(valueOf(it)) ? 'checked' : ''} />
          <span>${escapeHtml(labelOf(it))}</span>
        </label>`).join('')
    : '<div class="filter-empty">No matches</div>';
  box.querySelectorAll('input').forEach(cb => {
    cb.addEventListener('change', (e) => {
      if (e.target.checked) selSet.add(e.target.value);
      else selSet.delete(e.target.value);
      updateFilterBadges();
      onChange();
    });
  });
}

function renderCollectionOptions(filterText) {
  const ft = filterText.trim().toLowerCase();
  const items = state.filters.collections.filter(c => c.title.toLowerCase().includes(ft));
  renderFilterOptions($('#collection-options'), items, c => c.title, c => c.id, state.selCollections, applyFilters);
}

function renderTagOptions(filterText) {
  const ft = filterText.trim().toLowerCase();
  const items = state.filters.tags.filter(t => t.toLowerCase().includes(ft));
  renderFilterOptions($('#tag-options'), items, t => t, t => t, state.selTags, applyFilters);
}

function updateFilterBadges() {
  const cCount = state.selCollections.size;
  const tCount = state.selTags.size;
  $('#collection-badge').textContent = cCount;
  $('#collection-badge').hidden = cCount === 0;
  $('#tag-badge').textContent = tCount;
  $('#tag-badge').hidden = tCount === 0;
  $('#clear-filters').hidden = cCount === 0 && tCount === 0;
}

function clearFilters() {
  state.selCollections.clear();
  state.selTags.clear();
  renderCollectionOptions($('#collection-search').value);
  renderTagOptions($('#tag-search').value);
  updateFilterBadges();
  applyFilters();
}

function applyFilters() {
  loadProducts($('#search').value);
}

function togglePanel(dropdownId) {
  const dd = $(dropdownId);
  const panel = dd.querySelector('.filter-panel');
  const wasOpen = !panel.hidden;
  closePanels();
  if (!wasOpen) {
    panel.hidden = false;
    dd.classList.add('open');
  }
}

function closePanels() {
  document.querySelectorAll('.filter-dropdown').forEach(dd => {
    dd.classList.remove('open');
    const p = dd.querySelector('.filter-panel');
    if (p) p.hidden = true;
  });
}

// ----- Expand / collapse -----

function toggleExpand(pid) {
  if (state.expanded.has(pid)) state.expanded.delete(pid);
  else state.expanded.add(pid);
  renderProductList();
}

// ----- Selection (variant-level) -----

function selectionEntry(product, v) {
  return {
    productTitle: product.title,
    variantTitle: v.title,
    sku: v.sku,
    price: v.price,
    compareAtPrice: v.compareAtPrice,
    tags: product.tags || [], // product-level tags drive auto layout selection
    quantity: v.available > 0 ? v.available : 1,
  };
}

function toggleVariant(pid, vid, checked) {
  const product = state.products.find(p => p.id === pid);
  const v = product?.variants.find(x => x.id === vid);
  if (!v) return;
  const wasEmpty = state.selection.size === 0;
  if (checked) state.selection.set(vid, selectionEntry(product, v));
  else state.selection.delete(vid);
  // First selection auto-sets the layout to that product's design.
  if (checked && wasEmpty) setLayoutMode(designOf(product.tags));
  renderProductList();
  updateFooter();
}

function toggleGroup(pid, checked) {
  const product = state.products.find(p => p.id === pid);
  if (!product) return;
  const wasEmpty = state.selection.size === 0;
  product.variants.forEach(v => {
    if (checked) {
      if (!state.selection.has(v.id)) state.selection.set(v.id, selectionEntry(product, v));
    } else {
      state.selection.delete(v.id);
    }
  });
  if (checked && wasEmpty) setLayoutMode(designOf(product.tags));
  renderProductList();
  updateFooter();
}

function updateQuantity(vid, qty) {
  const sel = state.selection.get(vid);
  if (sel) {
    sel.quantity = qty;
    updateFooter();
  }
}

function updateFooter() {
  const count = state.selection.size;
  const totalTags = [...state.selection.values()].reduce((s, x) => s + (x.quantity || 0), 0);
  $('#selection-summary').textContent = `${count} variant(s) selected · ${totalTags} tag(s) total`;
  $('#print-button').disabled = count === 0 || totalTags === 0;
  updateLayoutWarning();
}

// ----- Tag layout (Box vs Tail) -----

// The tail-tag list is configurable (Settings → persisted to config.json as `tailTags`).
// A product with any of these tags is a Tail Tag; everything else is a Box Tag.
function designOf(tags) {
  const tailSet = new Set((state.tailTags || []).map(x => String(x).toLowerCase()));
  const t = (tags || []).map(x => String(x).toLowerCase());
  return t.some(x => tailSet.has(x)) ? 'tail' : 'box';
}

function setLayoutMode(mode) {
  state.layoutMode = mode;
  const sel = $('#layout-mode');
  if (sel) sel.value = mode;
}

// Warn when some selected products use the other design than the chosen layout.
function updateLayoutWarning() {
  const strip = $('#layout-warning');
  if (!strip) return;
  if (state.selection.size === 0) {
    strip.hidden = true;
    return;
  }
  // Box vs Tail family — 'tail' and 'tail-rotated' are both the tail design.
  const family = state.layoutMode === 'box' ? 'box' : 'tail';
  const conflict = [...state.selection.values()].some(s => designOf(s.tags) !== family);
  if (!conflict) {
    strip.hidden = true;
    return;
  }
  const cur = family === 'tail' ? 'Tail Tag' : 'Box Tag';
  const other = family === 'tail' ? 'Box Tag' : 'Tail Tag';
  strip.textContent = `⚠ Selection mixes designs: some products are ${other} but the Layout is set to ${cur}. A print run supports only one layout — deselect the mismatched products, or print them as a separate run.`;
  strip.hidden = false;
}

// ----- Print -----

async function doPrint() {
  const items = [...state.selection.values()]
    .filter(s => s.quantity > 0)
    .map(s => ({
      sku: s.sku,
      price: s.price,
      compareAtPrice: s.compareAtPrice,
      tags: s.tags,
      quantity: s.quantity,
    }));
  if (items.length === 0) return;
  const offset = state.layoutMode === 'box' ? state.offsets.box : state.offsets.tail;
  await window.api.print({ items, mode: state.layoutMode, offset });
}

// ----- Settings -----

function openSettings({ firstRun = false } = {}) {
  const modal = $('#settings-modal');
  $('#settings-error').hidden = true;
  window.api.configRead().then(cfg => {
    $('#shop-input').value = cfg.shop || '';
    $('#apikey-input').value = cfg.apiKey || '';
    $('#apisecret-input').value = cfg.apiSecret || '';
  });
  // Edit tail-tag tags against a draft so Cancel discards changes.
  state.tailTagsDraft = [...(state.tailTags || [])];
  $('#tailtags-search').value = '';
  renderTailTagsUI();
  // Populate offset inputs from current config.
  $('#box-off-x').value = state.offsets.box.x;
  $('#box-off-y').value = state.offsets.box.y;
  $('#tail-off-x').value = state.offsets.tail.x;
  $('#tail-off-y').value = state.offsets.tail.y;
  // Credentials are hidden behind the admin password — except on first run,
  // where there's nothing configured yet so we reveal them for setup.
  if (firstRun) unlockCreds(); else lockCreds();
  modal.showModal();
  $('#settings-cancel').disabled = !!firstRun;
}

// ----- Settings: credential lock (password-gated) -----

function lockCreds() {
  $('#creds-section').hidden = true;
  $('#admin-toggle').hidden = false;
  $('#admin-prompt').hidden = true;
  $('#admin-error').hidden = true;
  $('#admin-password').value = '';
  // reset the change-password sub-form
  $('#changepw-fields').hidden = true;
  $('#changepw-msg').hidden = true;
  $('#newpw').value = '';
  $('#confirmpw').value = '';
  // reset update controls
  $('#update-install').hidden = true;
  setUpdateStatus('');
}

async function submitChangePassword() {
  const np = $('#newpw').value;
  const cp = $('#confirmpw').value;
  const msg = $('#changepw-msg');
  const show = (text, ok) => { msg.textContent = text; msg.className = 'msg ' + (ok ? 'ok' : 'err'); msg.hidden = false; };
  if (!np) return show('Enter a new password.', false);
  if (np !== cp) return show("Passwords don't match.", false);
  const r = await window.api.changePassword(np);
  if (r.ok) {
    show('Password updated.', true);
    $('#newpw').value = '';
    $('#confirmpw').value = '';
  } else {
    show('Could not update password.', false);
  }
}

function unlockCreds() {
  $('#creds-section').hidden = false;
  $('#admin-toggle').hidden = true;
  $('#admin-prompt').hidden = true;
  $('#admin-error').hidden = true;
  $('#admin-password').value = '';
}

async function submitAdminPassword() {
  const r = await window.api.unlock($('#admin-password').value);
  if (r.ok) {
    unlockCreds();
  } else {
    $('#admin-error').hidden = false;
  }
}

// ----- Settings: Tail Tag tag management -----

function renderTailTagsUI() {
  renderTailTagChips();
  renderTailTagOptions($('#tailtags-search').value);
}

function renderTailTagChips() {
  const box = $('#tailtags-selected');
  const draft = state.tailTagsDraft || [];
  box.innerHTML = draft.length
    ? draft.map(t => `<span class="tag-chip">${escapeHtml(t)}<button type="button" class="chip-x" data-tag="${escapeHtml(t)}" aria-label="Remove">×</button></span>`).join('')
    : '<span class="tailtags-empty">None — all products print as Box Tag.</span>';
  box.querySelectorAll('.chip-x').forEach(btn => btn.addEventListener('click', () => removeTailTag(btn.dataset.tag)));
}

function renderTailTagOptions(filterText) {
  const box = $('#tailtags-options');
  const draftLower = new Set((state.tailTagsDraft || []).map(t => t.toLowerCase()));
  const ft = (filterText || '').trim().toLowerCase();
  const avail = (state.filters.tags || []).filter(t => !draftLower.has(t.toLowerCase()) && t.toLowerCase().includes(ft));
  box.innerHTML = avail.length
    ? avail.slice(0, 50).map(t => `<button type="button" class="tailtag-option" data-tag="${escapeHtml(t)}">${escapeHtml(t)}</button>`).join('')
    : '<div class="filter-empty">No matching tags</div>';
  box.querySelectorAll('.tailtag-option').forEach(btn => btn.addEventListener('click', () => addTailTag(btn.dataset.tag)));
}

function addTailTag(tag) {
  if (!state.tailTagsDraft.some(t => t.toLowerCase() === tag.toLowerCase())) state.tailTagsDraft.push(tag);
  renderTailTagsUI();
}

function removeTailTag(tag) {
  state.tailTagsDraft = state.tailTagsDraft.filter(t => t.toLowerCase() !== tag.toLowerCase());
  renderTailTagsUI();
}

async function saveSettings(e) {
  e.preventDefault();
  const shop = $('#shop-input').value.trim().replace(/^https?:\/\//, '').replace(/\/$/, '');
  const apiKey = $('#apikey-input').value.trim();
  const apiSecret = $('#apisecret-input').value.trim();
  if (!shop || !apiKey || !apiSecret) return;
  const err = $('#settings-error');
  err.hidden = true;
  const test = await window.api.shopifyTest({ shop, apiKey, apiSecret });
  if (!test.ok) {
    err.textContent = 'Connection failed: ' + test.error;
    err.hidden = false;
    return;
  }
  const num = (sel) => parseFloat($(sel).value) || 0;
  const offsets = {
    box: { x: num('#box-off-x'), y: num('#box-off-y') },
    tail: { x: num('#tail-off-x'), y: num('#tail-off-y') },
  };
  await window.api.configWrite({ shop, apiKey, apiSecret, tailTags: state.tailTagsDraft, offsets });
  state.tailTags = [...state.tailTagsDraft];
  state.offsets = offsets;
  $('#settings-modal').close();
  state.configured = true;
  await checkConnection();
  await loadFilters();
  await loadProducts('');
  updateLayoutWarning();
}

// ----- Wiring -----

function wireEvents() {
  $('#search').addEventListener('input', (e) => {
    clearTimeout(searchTimer);
    const term = e.target.value;
    searchTimer = setTimeout(() => loadProducts(term), 250);
  });
  $('#refresh').addEventListener('click', async () => {
    await loadFilters(); // pick up newly added collections/tags
    await loadProducts($('#search').value);
  });
  $('#print-button').addEventListener('click', doPrint);
  $('#layout-mode').addEventListener('change', (e) => { state.layoutMode = e.target.value; updateLayoutWarning(); });
  $('#update-btn').addEventListener('click', onUpdateButton);
  $('#update-install').addEventListener('click', onInstallUpdate);
  window.api.onUpdateStatus(handleUpdateStatus);

  // Filter dropdowns
  $('#collection-toggle').addEventListener('click', (e) => { e.stopPropagation(); togglePanel('#collection-filter'); });
  $('#tag-toggle').addEventListener('click', (e) => { e.stopPropagation(); togglePanel('#tag-filter'); });
  $('#collection-search').addEventListener('input', (e) => renderCollectionOptions(e.target.value));
  $('#tag-search').addEventListener('input', (e) => renderTagOptions(e.target.value));
  $('#clear-filters').addEventListener('click', clearFilters);
  // Keep interactions inside a panel from bubbling up to the document close handler.
  document.querySelectorAll('.filter-panel').forEach(p => p.addEventListener('click', (e) => e.stopPropagation()));
  document.addEventListener('click', closePanels);
  $('#theme-toggle').addEventListener('click', toggleTheme);
  $('#open-settings').addEventListener('click', () => openSettings());
  $('#settings-cancel').addEventListener('click', () => $('#settings-modal').close());
  $('#settings-form').addEventListener('submit', saveSettings);
  $('#tailtags-search').addEventListener('input', (e) => renderTailTagOptions(e.target.value));
  $('#admin-toggle').addEventListener('click', () => {
    $('#admin-prompt').hidden = false;
    $('#admin-error').hidden = true;
    $('#admin-password').focus();
  });
  $('#admin-submit').addEventListener('click', submitAdminPassword);
  // Enter in the password field unlocks instead of submitting the whole form.
  $('#admin-password').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); submitAdminPassword(); }
  });
  $('#changepw-toggle').addEventListener('click', () => {
    const f = $('#changepw-fields');
    f.hidden = !f.hidden;
  });
  $('#changepw-save').addEventListener('click', submitChangePassword);
  ['#newpw', '#confirmpw'].forEach(sel => $(sel).addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); submitChangePassword(); }
  }));
}

// ----- Updates (button-driven) -----

function setUpdateStatus(text, isError) {
  const s = $('#update-status');
  s.textContent = text;
  s.className = 'update-status' + (isError ? ' err' : '');
  s.hidden = !text;
}

function handleUpdateStatus(p) {
  switch (p.status) {
    case 'checking':
      setUpdateStatus('Checking for updates…');
      $('#update-install').hidden = true;
      break;
    case 'available':
      // Offer the install — the user decides whether to take it.
      setUpdateStatus(`Version ${p.version} available`);
      $('#update-install').textContent = `Install v${p.version}`;
      $('#update-install').hidden = false;
      break;
    case 'up-to-date':
      setUpdateStatus("You're on the latest version");
      $('#update-install').hidden = true;
      setTimeout(() => setUpdateStatus(''), 4000);
      break;
    case 'downloading':
      setUpdateStatus(`Downloading… ${p.percent}%`);
      break;
    case 'downloaded':
      setUpdateStatus(`Installing v${p.version} — the app will restart…`);
      break;
    case 'error':
      setUpdateStatus('Update failed', true);
      $('#update-install').hidden = true;
      break;
  }
}

async function onUpdateButton() {
  setUpdateStatus('Checking for updates…');
  $('#update-install').hidden = true;
  const r = await window.api.checkForUpdates();
  if (!r.ok) setUpdateStatus(r.error, true);
}

function onInstallUpdate() {
  $('#update-install').hidden = true;
  setUpdateStatus('Starting download…');
  window.api.downloadUpdate();
}

// ----- Helpers -----

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}
