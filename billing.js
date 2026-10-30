// Google Play coin-pack purchases: verify with Google, credit the wallet, consume.
//
// Flow (the app is a Bubblewrap TWA, so the browser talks to Play through the
// Digital Goods API + PaymentRequest):
//   1. page buys a product in Play  ->  gets a purchaseToken
//   2. page POSTs {productId, purchaseToken} to /api/purchase/verify (logged in)
//   3. we ask Google whether that token is a real, paid purchase
//   4. we credit coins through server_credit_purchase (idempotent per token)
//   5. we consume the purchase so the same pack can be bought again
//
// Security notes
//   - The server holds NO Supabase service key. It credits coins through
//     server_credit_purchase(), guarded by BILLING_SECRET (see coins_5_billing.sql).
//   - Coins are only ever credited for a purchase Google reports as PURCHASED.
//   - A token can be credited once (unique on provider+purchase_token), so replaying
//     a request, or sending the same token from two accounts, cannot double-pay.

const crypto = require('crypto');
const fs = require('fs');

const PROVIDER = 'google_play';
const SCOPE = 'https://www.googleapis.com/auth/androidpublisher';
const PUBLISHER_BASE = () => process.env.GOOGLE_PUBLISHER_BASE || 'https://androidpublisher.googleapis.com';

let serviceAccount;
function loadServiceAccount() {
  if (serviceAccount !== undefined) return serviceAccount;
  serviceAccount = null;
  try {
    let raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
    if (!raw && process.env.GOOGLE_SERVICE_ACCOUNT_FILE) {
      raw = fs.readFileSync(process.env.GOOGLE_SERVICE_ACCOUNT_FILE, 'utf8');
    }
    if (raw) {
      const json = JSON.parse(raw);
      if (json.client_email && json.private_key) serviceAccount = json;
    }
  } catch (e) {
    console.error('billing: could not read service account', e.message);
  }
  return serviceAccount;
}

const b64url = (buf) => Buffer.from(buf).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');

let tokenCache = { value: null, exp: 0 };
async function googleAccessToken() {
  const sa = loadServiceAccount();
  if (!sa) throw new Error('service account not configured');
  const now = Math.floor(Date.now() / 1000);
  if (tokenCache.value && tokenCache.exp - 60 > now) return tokenCache.value;

  const tokenUri = sa.token_uri || 'https://oauth2.googleapis.com/token';
  const head = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = b64url(JSON.stringify({ iss: sa.client_email, scope: SCOPE, aud: tokenUri, iat: now, exp: now + 3600 }));
  const sig = crypto.createSign('RSA-SHA256').update(`${head}.${claims}`).sign(sa.private_key);
  const assertion = `${head}.${claims}.${b64url(sig)}`;

  const r = await fetch(tokenUri, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }),
  });
  const body = await r.json().catch(() => ({}));
  if (!r.ok || !body.access_token) throw new Error(`google token request failed: ${r.status} ${body.error || ''}`);
  tokenCache = { value: body.access_token, exp: now + (body.expires_in || 3600) };
  return tokenCache.value;
}

async function publisher(pathname, { method = 'GET', body } = {}) {
  const token = await googleAccessToken();
  const r = await fetch(`${PUBLISHER_BASE()}/androidpublisher/v3/applications/${pathname}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON error body */ }
  return { ok: r.ok, status: r.status, json, text };
}

const enc = encodeURIComponent;

function isConfigured() {
  return !!(loadServiceAccount() && process.env.BILLING_SECRET && process.env.SUPABASE_URL && process.env.SUPABASE_ANON_KEY);
}

// Credit/refund go through SECURITY DEFINER functions that check BILLING_SECRET.
async function rpc(fn, args) {
  const r = await fetch(`${process.env.SUPABASE_URL}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: {
      apikey: process.env.SUPABASE_ANON_KEY,
      Authorization: `Bearer ${process.env.SUPABASE_ANON_KEY}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ p_secret: process.env.BILLING_SECRET, ...args }),
  });
  if (!r.ok) throw new Error(`${fn} failed: ${r.status} ${await r.text()}`);
  return r.json();
}

// Consuming also acknowledges. If consume fails, at least acknowledge: Play
// refunds any purchase that is not acknowledged within 3 days.
async function finishPurchase(pkg, productId, token) {
  const base = `${enc(pkg)}/purchases/products/${enc(productId)}/tokens/${enc(token)}`;
  const c = await publisher(`${base}:consume`, { method: 'POST' });
  if (c.ok) return 'consumed';
  const a = await publisher(`${base}:acknowledge`, { method: 'POST', body: {} });
  if (a.ok) return 'acknowledged';
  console.error('billing: consume/acknowledge failed', productId, c.status, c.text, a.status, a.text);
  return 'unfinished';
}

function registerBilling(app, { packageName, requireUser, HttpError, limiter, products }) {
  const pkg = process.env.GOOGLE_PLAY_PACKAGE || packageName;

  // The page asks this first so it can hide the buy buttons when billing is not set up.
  app.get('/api/billing/status', (req, res) => {
    res.json({ enabled: isConfigured(), packageName: pkg });
  });

  app.post('/api/purchase/verify', limiter, async (req, res) => {
    try {
      if (!isConfigured()) return res.status(503).json({ error: 'billing_unavailable' });
      const { user } = await requireUser(req);

      const { productId, purchaseToken } = req.body || {};
      if (typeof productId !== 'string' || !/^[a-z0-9_.]{1,60}$/.test(productId) ||
          typeof purchaseToken !== 'string' || purchaseToken.length < 10 || purchaseToken.length > 2000) {
        return res.status(400).json({ error: 'bad_request' });
      }
      if (!(await products()).includes(productId)) {
        return res.status(400).json({ error: 'unknown_product' });
      }

      const got = await publisher(`${enc(pkg)}/purchases/products/${enc(productId)}/tokens/${enc(purchaseToken)}`);
      if (!got.ok) {
        // 400/404: Google does not know this token -> forged or wrong app
        const bad = got.status === 400 || got.status === 404 || got.status === 410;
        console.error('billing: google lookup failed', got.status, got.text);
        return res.status(bad ? 400 : 502).json({ error: bad ? 'invalid_purchase' : 'google_unavailable' });
      }
      const p = got.json || {};
      // 0 = purchased, 1 = canceled, 2 = pending (e.g. cash payment not yet completed)
      if (p.purchaseState === 2) return res.status(409).json({ error: 'purchase_pending' });
      if (p.purchaseState !== 0) return res.status(400).json({ error: 'invalid_purchase' });
      // defence in depth: the response names the product it belongs to
      if (p.productId && p.productId !== productId) return res.status(400).json({ error: 'invalid_purchase' });

      const credit = await rpc('server_credit_purchase', {
        p_member: user.id,
        p_provider: PROVIDER,
        p_product_id: productId,
        p_order_id: p.orderId || null,
        p_token: purchaseToken,
        p_raw: {
          purchaseTimeMillis: p.purchaseTimeMillis, purchaseState: p.purchaseState,
          consumptionState: p.consumptionState, acknowledgementState: p.acknowledgementState,
          orderId: p.orderId, regionCode: p.regionCode, purchaseType: p.purchaseType,
        },
      });
      if (!credit || credit.ok !== true) {
        console.error('billing: credit refused', credit);
        return res.status(credit?.reason === 'forbidden' ? 500 : 400).json({ error: credit?.reason || 'credit_failed' });
      }

      // Coins are safe in the wallet at this point; finishing is best-effort.
      const finished = await finishPurchase(pkg, productId, purchaseToken);
      res.json({ ok: true, already: !!credit.already, balance: credit.balance, coins: credit.coins ?? null, finished });
    } catch (err) {
      if (HttpError && err instanceof HttpError) return res.status(err.status).json(err.body);
      console.error('billing: verify error', err);
      res.status(502).json({ error: 'verify_failed' });
    }
  });
}

// Refunds / chargebacks: Play lists voided purchases; we take the coins back.
async function syncVoidedPurchases(packageName, { sinceMs } = {}) {
  const pkg = process.env.GOOGLE_PLAY_PACKAGE || packageName;
  const out = { checked: 0, refunded: 0, already: 0, notFound: 0 };
  let pageToken = '';
  do {
    const q = new URLSearchParams({ type: '0', maxResults: '100' });
    if (sinceMs) q.set('startTime', String(sinceMs));
    if (pageToken) q.set('token', pageToken);
    const r = await publisher(`${enc(pkg)}/purchases/voidedpurchases?${q}`);
    if (!r.ok) throw new Error(`voidedpurchases failed: ${r.status} ${r.text}`);
    for (const v of r.json?.voidedPurchases || []) {
      out.checked++;
      const res = await rpc('server_refund_purchase', { p_provider: PROVIDER, p_token: v.purchaseToken });
      if (res.ok && res.already) out.already++;
      else if (res.ok) out.refunded++;
      else if (res.reason === 'not_found') out.notFound++;
      else throw new Error('refund refused: ' + JSON.stringify(res));
    }
    pageToken = r.json?.tokenPagination?.nextPageToken || '';
  } while (pageToken);
  return out;
}

module.exports = { registerBilling, syncVoidedPurchases, isConfigured };
