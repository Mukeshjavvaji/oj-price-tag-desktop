const API_VERSION = '2025-01';

// Dev Dashboard apps don't issue permanent offline tokens. We mint a short-lived
// (24h) Admin API access token via the client_credentials grant using the app's
// static Client ID + Client secret, then cache it until shortly before it expires.
// See: https://shopify.dev/docs/apps/build/dev-dashboard/get-api-access-tokens
const tokenCache = new Map(); // shop -> { token, expiresAt (ms) }

async function fetchAccessToken({ shop, apiKey, apiSecret }) {
  const r = await fetch(`https://${shop}/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: apiKey,
      client_secret: apiSecret,
    }),
  });
  if (!r.ok) {
    throw new Error(`Token request ${r.status}: ${await r.text()}`);
  }
  const data = await r.json();
  if (!data.access_token) {
    throw new Error('Token request returned no access_token: ' + JSON.stringify(data));
  }
  return data;
}

async function getAccessToken(creds, { force = false } = {}) {
  const cached = tokenCache.get(creds.shop);
  // Refresh 60s early so an in-flight request never races the expiry.
  if (!force && cached && Date.now() < cached.expiresAt - 60_000) {
    return cached.token;
  }
  const data = await fetchAccessToken(creds);
  const expiresAt = Date.now() + (data.expires_in ?? 86399) * 1000;
  tokenCache.set(creds.shop, { token: data.access_token, expiresAt });
  return data.access_token;
}

async function query(creds, gql, variables, { retry = true } = {}) {
  const token = await getAccessToken(creds);
  const r = await fetch(`https://${creds.shop}/admin/api/${API_VERSION}/graphql.json`, {
    method: 'POST',
    headers: {
      'X-Shopify-Access-Token': token,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query: gql, variables }),
  });
  // A cached token can be revoked/rotated before its nominal expiry — on a 401,
  // force-refresh once and retry before giving up.
  if (r.status === 401 && retry) {
    await getAccessToken(creds, { force: true });
    return query(creds, gql, variables, { retry: false });
  }
  if (!r.ok) {
    throw new Error(`Shopify API ${r.status}: ${await r.text()}`);
  }
  const data = await r.json();
  if (data.errors?.length) {
    throw new Error('GraphQL errors: ' + JSON.stringify(data.errors));
  }
  return data.data;
}

const SEARCH_PRODUCTS = `
  query SearchProducts($q: String!, $first: Int!, $sortKey: ProductSortKeys, $reverse: Boolean) {
    products(first: $first, query: $q, sortKey: $sortKey, reverse: $reverse) {
      nodes {
        id
        title
        tags
        variants(first: 100) {
          nodes {
            id
            title
            sku
            price
            compareAtPrice
            inventoryQuantity
          }
        }
      }
    }
  }
`;

// collection_id in the search syntax wants the numeric id, not the gid.
function numericId(gid) {
  return String(gid).split('/').pop();
}

// Wrap tag values in single quotes so multi-word tags work; escape embedded quotes.
function quoteTag(tag) {
  return `'${String(tag).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

// Build the products `query` string: search term, collections (match ANY),
// and tags (match ALL) all AND-ed together. See Shopify API search syntax.
function buildQuery({ term, collectionIds = [], tags = [] }) {
  const parts = [];
  const t = (term || '').trim();
  parts.push(t ? `(title:*${t}* OR sku:*${t}*)` : 'status:active');
  if (collectionIds.length) {
    parts.push('(' + collectionIds.map(id => `collection_id:${numericId(id)}`).join(' OR ') + ')');
  }
  if (tags.length) {
    parts.push('(' + tags.map(tag => `tag:${quoteTag(tag)}`).join(' AND ') + ')');
  }
  return parts.join(' AND ');
}

async function searchProducts({ shop, apiKey, apiSecret, term = '', collectionIds = [], tags = [], limit = 50 }) {
  const hasTerm = !!term.trim();
  const q = buildQuery({ term, collectionIds, tags });
  // Default (no search term): most recently updated first. With a term: relevance ordering.
  const sortKey = hasTerm ? 'RELEVANCE' : 'UPDATED_AT';
  const reverse = !hasTerm; // UPDATED_AT + reverse = most recently modified at top
  const data = await query({ shop, apiKey, apiSecret }, SEARCH_PRODUCTS, { q, first: limit, sortKey, reverse });
  return (data.products?.nodes || [])
    .map(node => {
      const variants = (node.variants?.nodes || [])
        .map(v => ({
          id: v.id,
          title: v.title || '',
          sku: v.sku || '',
          price: v.price || '',
          compareAtPrice: v.compareAtPrice || v.price || '',
          available: Number.isFinite(v.inventoryQuantity) ? v.inventoryQuantity : 0,
        }))
        .filter(v => v.sku); // a tag needs a SKU for its QR
      return { id: node.id, title: node.title || '', tags: node.tags || [], variants };
    })
    .filter(p => p.variants.length > 0);
}

async function testConnection({ shop, apiKey, apiSecret }) {
  const TEST = `query { shop { name myshopifyDomain } }`;
  const data = await query({ shop, apiKey, apiSecret }, TEST);
  return data.shop;
}

const FILTERS_CAP = 500; // how many collections/tags to load into the filter UI

// `collections` caps `first` at 250 per request, so page through until we hit the cap.
const COLLECTIONS_PAGE = `
  query Collections($first: Int!, $after: String) {
    collections(first: $first, after: $after) {
      nodes { id title }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

const TAGS_QUERY = `query Tags($first: Int!) { productTags(first: $first) { edges { node } } }`;

// Fetch the collections and product tags used to populate the filter controls.
async function getFilters({ shop, apiKey, apiSecret }) {
  const creds = { shop, apiKey, apiSecret };

  const collections = [];
  let after = null;
  do {
    const data = await query(creds, COLLECTIONS_PAGE, { first: 250, after });
    const conn = data.collections;
    for (const c of (conn?.nodes || [])) collections.push({ id: c.id, title: c.title });
    after = conn?.pageInfo?.hasNextPage ? conn.pageInfo.endCursor : null;
  } while (after && collections.length < FILTERS_CAP);

  const tdata = await query(creds, TAGS_QUERY, { first: FILTERS_CAP });
  const tags = (tdata.productTags?.edges || []).map(e => e.node).filter(Boolean);

  return { collections, tags };
}

module.exports = { searchProducts, testConnection, getFilters };
