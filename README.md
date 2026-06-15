# Olive Print Tags — Desktop

A small **Electron desktop app** for Olive Jewellery staff to print thermal price tags.
It connects to the production Shopify store's **Admin API**, lets a non-technical user
search/filter products, pick variants and quantities, and prints **QR-coded price tags**
to a local thermal printer via the OS print dialog.

The audience is non-technical: they open the app, search, select, and click **Print**.

---

## Table of contents

- [What it does](#what-it-does)
- [Why Electron](#why-electron)
- [Tech stack & repo layout](#tech-stack--repo-layout)
- [Running it (development, macOS)](#running-it-development-macos)
- [First-run configuration](#first-run-configuration)
- [How Shopify auth works](#how-shopify-auth-works) ← read this
- [Where config is stored](#where-config-is-stored)
- [Data model: products → variants](#data-model-products--variants)
- [Search & filters](#search--filters)
- [The UI, screen by screen](#the-ui-screen-by-screen)
- [The two tag layouts (Box & Tail)](#the-two-tag-layouts-box--tail)
- [How printing works](#how-printing-works)
- [Assets (logos & reference designs)](#assets-logos--reference-designs)
- [Theming](#theming)
- [Building the Windows installer](#building-the-windows-installer)
- [IPC reference](#ipc-reference)
- [Developer workflow: verifying tag designs](#developer-workflow-verifying-tag-designs)
- [Known limitations & gotchas](#known-limitations--gotchas)

---

## What it does

1. Connects to the production Shopify store via the **Admin GraphQL API**.
2. Lists products **newest-updated first**, grouped, with each product expandable into its **variants** (each variant has its own SKU/price/inventory).
3. Lets staff **filter by collection and/or tag**, and **search** by title or SKU.
4. Staff tick variants, set a per-variant **quantity** (pre-filled from inventory), and click **Print**.
5. The app renders price tags as HTML and opens the **OS print dialog** targeting the thermal printer.

Each tag shows: the Olive logo, **MRP**, **OJ Price**, a **QR code** encoding the variant SKU, and the SKU text. There are **two physical tag layouts** — see [below](#the-two-tag-layouts-box--tail).

---

## Why Electron

This replaces an earlier **embedded Shopify app** (React Router + Polaris). That pattern needs
public HTTPS hosting, OAuth callbacks, and an always-on server — overkill for a 1–2-user internal
tool on a single Windows laptop with a local printer. A standalone Electron app runs on the laptop,
talks to the Admin API directly, and prints locally. No hosting.

---

## Tech stack & repo layout

- **Electron** (main + renderer), no framework, no bundler, no TypeScript — deliberately minimal.
- **`qrcode`** npm package for SVG QR generation (main process).
- **`electron-builder`** for packaging the Windows installer.

```
oj-print-desktop/
├── package.json            # scripts, deps, electron-builder config
├── README.md               # this file
├── assets/
│   ├── logo/               # PNG logos (see "Assets")
│   │   ├── Logo - Tag.png  # logo printed ON the tags (box + tail)
│   │   ├── Logo Final.png  # app header logo (light mode)
│   │   └── logo dark.png   # app header logo (dark mode)
│   └── tags/               # reference Canva exports of the tag designs
│       ├── box-tag.svg
│       └── tail-tag.svg
└── src/
    ├── main/               # Node (main) process
    │   ├── main.js         # window creation + IPC handlers + print window
    │   ├── config.js       # read/write config.json; loads default creds from secrets.js
    │   ├── secrets.js      # GITIGNORED bundled credentials (copy from secrets.example.js)
    │   ├── secrets.example.js  # template for secrets.js (tracked)
    │   ├── shopify.js      # Admin GraphQL client: auth, search, filters
    │   └── render.js       # builds the print HTML (Box & Tail tags, QR, logo)
    ├── preload/
    │   └── preload.js      # contextBridge: exposes window.api.* to the renderer
    └── renderer/           # the window UI (Chromium)
        ├── index.html      # markup
        ├── styles.css      # all UI styling (CSS variables + light/dark themes)
        └── app.js          # all UI logic (vanilla JS)
```

The **main process** has Node/filesystem/network access. The **renderer** is sandboxed
(`contextIsolation: true`, `nodeIntegration: false`) and reaches the main process only through
the `window.api.*` bridge defined in `preload.js`.

---

## Running it (development, macOS)

```bash
cd "oj-print-desktop"
npm install
npm start            # = electron .
```

> **Dev environment quirk:** if your shell exports `ELECTRON_RUN_AS_NODE=1`, Electron boots as
> plain Node and `require('electron')` returns a string instead of the module, crashing at
> `config.js` (`app.getPath` undefined). If you hit that, launch with the var unset:
> ```bash
> env -u ELECTRON_RUN_AS_NODE npm start
> ```
> A normal terminal without that variable runs `npm start` fine.

---

## First-run configuration

**Credentials are bundled as defaults** loaded from [`src/main/secrets.js`](src/main/secrets.example.js)
(which is **gitignored**), so a fresh install connects immediately and the Settings modal does **not**
appear. To set them up on a new checkout:

```bash
cp src/main/secrets.example.js src/main/secrets.js   # then fill in real values
```

**On first run the defaults are written into `config.json`** (the per-machine store), which then
becomes the source of truth — edits via the **Settings gear icon** persist there and are used from
then on. If `secrets.js` is absent the seeded values are blank and the Settings modal opens so you can
enter them once. The secrets file is bundled into the packaged build but kept out of git.

The three values (defaulted, but editable in **Settings**) are:

| Field | What to enter |
|---|---|
| **Store domain** | The `*.myshopify.com` host, e.g. `your-store.myshopify.com`. No `https://`, no path. ⚠️ This is **not** the `admin.shopify.com/store/<handle>` handle — use the real myshopify domain. |
| **API key (Client ID)** | The app's **Client ID** from the Shopify **Dev Dashboard → your app → Settings → Credentials**. |
| **API secret key** | The **Client secret** (`shpss_…`) from the same Credentials tab. |

Clicking **Save & test** runs a live `shop { name }` query before saving; a bad value surfaces an
error immediately. The shop name itself is not shown after connecting (only a red "Connection failed"
appears if it later fails).

**Credentials are password-gated in Settings.** Opening the gear icon shows only the **Tail Tag tags**
manager by default. Clicking the **lock icon** (bottom-left of the modal) asks for an admin password
before revealing the store domain / API key / secret fields, plus a **Change admin password** option
(new + confirm).

The password is managed by [`src/main/auth.js`](src/main/auth.js): stored **hashed** (SHA-256) in
`auth.json` in the user-data dir (alongside `config.json`), **never** sent to the renderer or written
to `config.json`. Verify/change happen in the main process (IPC `auth:unlock` / `auth:change`). On
first use it's **seeded with the install default** set as `adminPassword` in the gitignored
`secrets.js`; staff change it from there via the in-app flow. On a true first run (no credentials yet) the credential
fields are shown without a password so initial setup is possible.

**Required Shopify scopes** on the app: `read_products` and `read_inventory`. Set these in the
Dev Dashboard app configuration and release/update the app. After changing scopes, **restart the
desktop app** so it mints a fresh token carrying the new scopes (a cached token keeps its old scopes).

---

## How Shopify auth works

**Read this — it's the least obvious part of the app.**

The store's app lives in Shopify's **Dev Dashboard**, and Dev Dashboard apps **do not get a
permanent offline `shpat_…` token**. There is no static token to paste. Instead we use the
**client-credentials grant**:

1. The app POSTs the **Client ID + Client secret** (form-encoded) to
   `https://{shop}/admin/oauth/access_token` with `grant_type=client_credentials`.
2. Shopify returns a short-lived **access token valid 24 hours** (`expires_in: 86399`) plus the
   granted `scope`.
3. The app caches the token **in main-process memory** (`tokenCache` in `shopify.js`) and reuses it
   for all Admin API calls until ~60 s before expiry, then transparently re-mints it.
4. On a `401` from any query, it force-refreshes the token once and retries (handles early
   revocation/rotation).

Implications:
- Staff enter **two static, non-expiring values once** (Client ID + secret). The 24 h token churn is
  invisible to them.
- The Client ID/secret are stored locally (see below). The minted access token is **never persisted** —
  it only lives in memory and is re-derived as needed.
- This only works when **the app and the store are in the same Shopify organization** (a
  client-credentials requirement). A `Token request 401` usually means wrong credentials or a
  different org; an `ACCESS_DENIED` GraphQL error means the token works but the app lacks a scope.

All of this is in [`src/main/shopify.js`](src/main/shopify.js): `fetchAccessToken`, `getAccessToken`,
and the `query` wrapper.

> **Note:** `fetch()` is a global in Electron's Node runtime, so `shopify.js` uses it without an
> import. If the Electron/Node version is ever downgraded below the global-fetch era, add `node-fetch`.

---

## Where config is stored

`config.js` writes `config.json` (mode `600`) to Electron's `userData` directory:

- **Dev (`npm start`)**: derived from the package **`name`** →
  `~/Library/Application Support/oj-print-desktop/config.json`
- **Packaged build**: derived from the **`productName`** ("Olive Print Tags") →
  `~/Library/Application Support/Olive Print Tags/config.json` (macOS) /
  `%APPDATA%\Olive Print Tags\config.json` (Windows)

Stored fields: `{ shop, apiKey, apiSecret, tailTags, offsets }` — where `offsets` is the per-layout
print-calibration nudge `{ box: {x,y}, tail: {x,y} }` in mm (set in Settings → "Print offset"; tail and
tail-rotated share the tail offset). The UI **theme** preference is stored separately in the renderer's
`localStorage` (key `theme`), not in `config.json`. The admin password lives in `auth.json` (see auth
section), never in `config.json`.

---

## Data model: products → variants

Each Shopify product can have multiple **variants**, each with its own SKU, price, compare-at price,
and inventory. Because a price tag is fundamentally **per-SKU**, the app works at the **variant level**:

- `shopify.js` fetches products with `variants(first: 100)` and per-product `tags`.
- Variants **without a SKU are dropped** (a tag needs a SKU for its QR); a product with zero SKU'd
  variants is dropped entirely.
- The renderer shows each product as a **collapsible group**; expanding reveals one **row per variant**.
- **Selection is keyed by variant ID**, and each selected entry stores everything needed to print
  (`sku`, `price`, `compareAtPrice`, product `tags`, `quantity`) — so a selection **survives across
  different searches/filters**.

---

## Search & filters

All filtering happens **server-side** in one Admin API query string (`buildQuery` in `shopify.js`):

- **Search term** → `(title:*term* OR sku:*term*)`. Empty term → `status:active`.
- **Collections** (multi-select, match **ANY**) → `(collection_id:A OR collection_id:B)` using the
  numeric collection id.
- **Tags** (multi-select, match **ALL**) → `(tag:'A' AND tag:'B')`.
- These are **AND-ed** together, so search + filters narrow results together.

**Sorting:** default list (no search term) is `UPDATED_AT` descending (most recently modified first);
with a search term it switches to `RELEVANCE`.

**Filter options** (the collection & tag lists for the dropdowns) come from `getFilters` in
`shopify.js`: up to **500 collections** (paginated, since the API caps `first` at 250 per page) and
**500 tags** (`productTags`), controlled by the `FILTERS_CAP` constant. They load at startup, after
saving settings, and on **Refresh** (so newly created collections/tags appear without restarting).

Results are capped at **50 products** per query (`first: 50`, no pagination yet).

---

## The UI, screen by screen

- **Header**: circular logo (theme-aware), connection status (only shows red on failure), a
  **light/dark toggle** (outline sun/moon icon), and a **Settings gear icon**.
- **Search bar**: debounced (250 ms) title/SKU search, plus a **Refresh** button (reloads filters +
  products).
- **Filter bar**: **Collections** and **Tags** dropdown checklists (each searchable, with a count
  badge), plus **Clear filters**. Panels open on click, close on outside-click.
- **Product list**: collapsible product groups → variant rows with checkbox, title, SKU, price
  (struck-through MRP if different), availability, and a quantity input. A group checkbox
  selects/deselects all of a product's variants.
- **Footer**: selection summary, a **Layout** dropdown (`Box Tag` / `Tail Tag`), and **Print Selected**.
- **Layout warning strip** (above the footer): appears if the selection mixes Box and Tail designs —
  see below.

---

## The two tag layouts (Box & Tail)

There are two physical tag designs, named **Box Tag** and **Tail Tag**. Both are rendered dynamically
from live product data in [`src/main/render.js`](src/main/render.js); the Canva reference exports live
in [`assets/tags/`](assets/tags/).

### Box Tag — `box-tag.svg`
- Physical sheet: **100 × 25 mm**, printed **2-up** = two **48.4 mm** tags with a **3.2 mm gap**
  (48.4 + 3.2 + 48.4 = 100), no outer border.
- Each tag: three ~16 mm columns — **logo** | **MRP (regular) / OJ Price (bold)** | **QR + SKU** —
  over a letter-spaced **www.olivejewellery.in** footer.
- Odd quantities leave a single tag in the last row.

### Tail Tag — `tail-tag.svg`
- Physical sheet: **100 × 15 mm**, printed **1-up** (one per row).
- Layout left→right: **MRP** | divider | **OJ Price** | **QR** | **vertical SKU** | **logo**, then a
  blank ~28 mm **tail** (wraps around the item).

### Which layout prints
- The **Layout** dropdown chooses `Box Tag` or `Tail Tag` for the whole run.
- **Auto-select on first pick:** selecting the first product sets the dropdown to that product's design
  automatically, based on its tags.
- **Tag → layout rule:** a product tagged any of the **tail-tag tags** (case-insensitive) defaults to
  **Tail**; everything else defaults to **Box**.
  - The tail-tag list is **configurable in Settings** ("Tail Tag tags": shows the current tags as
    removable chips + a searchable picker of the store's tags to add). It's persisted to `config.json`
    as `tailTags` and is the single source of truth. The **default** list (used to seed a fresh
    `config.json`) is `DEFAULT_TAIL_TAGS` in [`src/main/config.js`](src/main/config.js):
    `Kadas, Bracelets, Necklace, Chains, Finger Rings, Pendant, Pendant Set`.
  - The layout decision is made in the renderer ([`app.js`](src/renderer/app.js) `designOf`, using
    `state.tailTags`); `render.js` just renders whichever `mode` it's given.
- **Mixing guard:** a print run supports only **one** layout (Box and Tail are different physical
  stock). If the selection mixes designs, the **warning strip** appears telling staff to deselect the
  mismatched items or print them as a separate run.

---

## How printing works

1. **Print Selected** sends `{ items, mode }` to the main process (`print:open` IPC). `items` are the
   selected variant entries; `mode` is `'box'` or `'tail'`.
2. `render.js` `renderPrintHTML`:
   - Generates one **inline SVG QR** per unique SKU via the `qrcode` package.
   - Expands items by quantity.
   - Picks page geometry from `mode`: `@page` is **100 × 25 mm** for box, **100 × 15 mm** for tail.
   - Lays out **box 2-up** (pairs) or **tail 1-up** (one per row).
   - Embeds the logo as a **base64 data URI** (the print window loads via a `data:` URL, so file paths
     don't resolve — the PNG is read from `assets/logo/` and cached).
3. `main.js` opens a **hidden** `BrowserWindow`, loads the HTML, and the page calls `window.print()`
   on load → the **OS print dialog** appears. The user selects the thermal printer + the matching
   custom paper size and prints.

On the thermal printer, set the custom paper size to match (**100 × 25 mm** for box, **100 × 15 mm**
for tail) and print at 100% scale.

---

## Assets (logos & reference designs)

- **`assets/logo/Logo - Tag.png`** — the logo printed **on both tag types**. (Has a near-white,
  non-transparent background; invisible on white labels, but shows a faint box on screen — swap for a
  transparent PNG if that ever matters.)
- **`assets/logo/Logo Final.png`** / **`logo dark.png`** — the app **header** logo for light / dark mode.
- **`assets/tags/box-tag.svg`**, **`tail-tag.svg`** — the **Canva exports** used as the visual spec for
  the printed layouts. Text in them is outlined (vector paths), so they're a reference only — the live
  tags are rebuilt in HTML/CSS in `render.js`. If a design changes, update the SVG here and re-match
  `render.js`.

---

## Theming

`styles.css` defines all colors as **CSS variables** under `:root` (light) and `[data-theme="dark"]`
(dark). The brand color is pink **`#ffa3bc`**; because it's light, buttons/badges use it as a fill with
**dark text** (`--on-accent`), and a deeper pink **`--accent-strong`** is used for links/small text.
The header logo and `color-scheme` switch with the theme. Theme choice persists in `localStorage` and
is applied before first paint (in `app.js`) to avoid a flash.

---

## Building the Windows installer

```bash
npm run build:win        # electron-builder --win --x64, run from macOS or Windows
```

Output: `dist/Olive Print Tags Setup 0.1.0.exe` (NSIS installer; lets the user choose the install dir
and creates a Desktop shortcut). Copy it to the Windows machine and run.

- An **unsigned** `.exe` triggers Windows SmartScreen ("unknown publisher") → **More info → Run
  anyway**. Acceptable for internal use; code signing (~$200/yr) removes it.
- ⚠️ `package.json` references **`assets/icon.png`** for the app/installer icon, which **does not exist
  yet**. Add a real icon there (ideally a 256×256+ PNG / `.ico`) before shipping, or the build may
  warn/fall back to a default icon.

---

## Deployment & auto-update

Updates are delivered via **GitHub Releases** using `electron-updater`, from the **private** repo
`Mukeshjavvaji/oj-price-tag-desktop`.

### Releasing a new version (you)

1. Bump the version and tag:
   ```bash
   npm version patch      # or minor/major — updates package.json and creates a vX.Y.Z tag
   git push --follow-tags
   ```
2. The **GitHub Actions** workflow [`.github/workflows/release.yml`](.github/workflows/release.yml)
   runs on the tag: it writes `secrets.js` from repo Secrets, builds the Windows installer, and
   **publishes** it (+ `latest.yml`) to a GitHub Release via `npm run publish:win`.

**Required GitHub Actions Secrets** (repo → Settings → Secrets and variables → Actions):
`SHOPIFY_SHOP`, `SHOPIFY_API_KEY`, `SHOPIFY_API_SECRET`, `ADMIN_PASSWORD`, and `UPDATE_GH_TOKEN`
(a token with **read** access to this repo's releases — embedded in the app so it can download updates
from the private repo). The build's publish step uses the auto-provided `GITHUB_TOKEN`.

### Updating in the app (staff)

Auto-update is **button-driven and admin-gated** (no background polling):

1. Open Settings (gear) → unlock with the admin password → **Check for updates**.
2. If a newer release exists, it shows **"Version X.Y.Z available"** and an **Install vX.Y.Z** button.
   The user can ignore it (no change) or click Install.
3. Install → downloads the new installer → the app **restarts and applies** it.

Implemented in [`src/main/update.js`](src/main/update.js) (`autoDownload = false`, private-repo feed
from `secrets.js`). Notes: works only in the **installed** app (not `npm start`); unsigned builds still
update via NSIS but keep the SmartScreen prompt; the embedded `githubToken` is a secret in the `.exe`.

## IPC reference

All exposed via `window.api.*` (see `preload.js`); handled in `main.js`.

| `window.api` call | IPC channel | Purpose |
|---|---|---|
| `configRead()` | `config:read` | Read `{ shop, apiKey, apiSecret }` |
| `configWrite(next)` | `config:write` | Persist config |
| `shopifyTest({shop,apiKey,apiSecret})` | `shopify:test` | Mint a token + run `shop { name }` |
| `shopifySearch({term,collectionIds,tags})` | `shopify:search` | Search/filter products (≤50) |
| `shopifyFilters()` | `shopify:filters` | Fetch collections + tags for the filter UI |
| `print({items,mode})` | `print:open` | Render tags and open the print dialog |
| `unlock(password)` | `auth:unlock` | Verify the admin password (main process) |
| `changePassword(next)` | `auth:change` | Set a new admin password |
| `checkForUpdates()` | `update:check` | Check GitHub Releases for a newer version |
| `downloadUpdate()` | `update:download` | Download the available update (then auto-installs) |
| `onUpdateStatus(cb)` | `update:status` (event) | Receive update status (checking/available/…) |

---

## Developer workflow: verifying tag designs

You can render the **exact print HTML** to an image without launching the app, to compare against the
Canva reference — useful when tweaking `render.js`:

```bash
# 1) Generate the HTML for a sample (Node script that requires render.js and writes /tmp/preview.html)
# 2) Screenshot it with headless Chrome at 8x (≈ 30 px/mm, matching a 100mm-wide render):
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --headless=new --disable-gpu --hide-scrollbars \
  --force-device-scale-factor=8 --window-size=378,95 \
  --default-background-color=FFFFFFFF \
  --screenshot=/tmp/preview.png "file:///tmp/preview.html"
```

To inspect the Canva SVGs themselves, render with `rsvg-convert -z 8 box-tag.svg -o out.png`. (The
box design is `378px = 100mm`; `--window-size=378,95` for box ≈ 25 mm tall, `378,57` for tail ≈ 15 mm.)

---

## Known limitations & gotchas

- **50-result cap** on product search (no pagination). Broad searches silently show only the first 50.
- **Filter lists cap at 500** collections / 500 tags (`FILTERS_CAP`). Beyond that, the overflow won't
  appear in the dropdowns (filtering by them would still work if typed).
- **Same-org requirement** for the client-credentials grant (see auth section).
- **`assets/icon.png` is missing** — add before building for distribution.
- **Token never persisted** — first action after launch always makes a token request (fast, cached
  after).
- The tail-tag → layout decision lives in the **renderer** (`app.js`); `render.js` only obeys the
  explicit `mode`. Changing the tail-tag list is done in Settings (no code change needed).
```
