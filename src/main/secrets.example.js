// Template for src/main/secrets.js (which is gitignored).
// Copy this file to secrets.js and fill in the real Shopify Dev Dashboard credentials:
//   Dev Dashboard -> your app -> Settings -> Credentials (Client ID + Client secret).
// `shop` is the *.myshopify.com domain (no https://, no path).
//
//   cp src/main/secrets.example.js src/main/secrets.js
//
// Without secrets.js the app still runs, but the Settings modal will ask for credentials.
module.exports = {
  shop: 'your-store.myshopify.com',
  apiKey: 'YOUR_CLIENT_ID',
  apiSecret: 'shpss_YOUR_CLIENT_SECRET',
  // Password required to view/edit the credentials in the in-app Settings.
  adminPassword: 'CHOOSE_A_PASSWORD',

  // Auto-update from a PRIVATE GitHub repo (electron-updater).
  githubOwner: 'YOUR_GITHUB_USER_OR_ORG',
  githubRepo: 'oj-print-desktop',
  githubToken: 'ghp_READ_ONLY_TOKEN_WITH_RELEASES_ACCESS',
};
