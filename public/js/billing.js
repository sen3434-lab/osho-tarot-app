// Google Play coin purchases from inside the installed (TWA) app.
// Uses the Digital Goods API + Payment Request, which only exist in a Play-installed
// Trusted Web Activity — in a normal browser tab buying is not possible.
//
// The server (/api/purchase/verify) is what actually checks the purchase with
// Google and adds the coins; this file only runs the Play purchase sheet.

const PLAY_BILLING = 'https://play.google.com/billing';

let servicePromise;
function getService() {
  if (!servicePromise) {
    servicePromise = (async () => {
      if (!('getDigitalGoodsService' in window)) return null;
      try { return await window.getDigitalGoodsService(PLAY_BILLING); } catch { return null; }
    })();
  }
  return servicePromise;
}

async function serverEnabled() {
  try {
    const r = await fetch('/api/billing/status');
    return r.ok && (await r.json()).enabled === true;
  } catch { return false; }
}

// 'ok' | 'not_in_app' (plain browser) | 'server_off' (billing not configured yet)
export async function billingState() {
  if (!(await getService())) return 'not_in_app';
  if (!(await serverEnabled())) return 'server_off';
  return 'ok';
}

async function verify(accessToken, productId, purchaseToken) {
  const r = await fetch('/api/purchase/verify', {
    method: 'POST',
    headers: { 'content-type': 'application/json', Authorization: `Bearer ${accessToken}` },
    body: JSON.stringify({ productId, purchaseToken }),
  });
  const body = await r.json().catch(() => ({}));
  return { status: r.status, ok: r.ok && body.ok === true, body };
}

// Localized prices straight from Play (falls back to the DB price in the page).
export async function playPrices(productIds) {
  const service = await getService();
  if (!service) return {};
  try {
    const details = await service.getDetails(productIds);
    const out = {};
    details.forEach((d) => { out[d.itemId] = d.price; });
    return out;
  } catch { return {}; }
}

// Opens the Play purchase sheet. Resolves to:
//   {ok:true, balance, coins} | {cancelled:true} | {error:'...'}
export async function buyPack(accessToken, productId, priceKrw) {
  const service = await getService();
  if (!service) return { error: 'not_in_app' };

  let response;
  try {
    const request = new PaymentRequest(
      [{ supportedMethods: PLAY_BILLING, data: { sku: productId } }],
      { total: { label: '코인 충전', amount: { currency: 'KRW', value: String(priceKrw) } } },
    );
    response = await request.show();
  } catch (e) {
    // closing the sheet rejects with AbortError/NotAllowedError — not a failure
    if (e && (e.name === 'AbortError' || e.name === 'NotAllowedError')) return { cancelled: true };
    console.error('purchase sheet failed', e);
    return { error: 'sheet_failed' };
  }

  const purchaseToken = response.details && response.details.purchaseToken;
  if (!purchaseToken) {
    try { await response.complete('fail'); } catch { /* ignore */ }
    return { error: 'no_token' };
  }

  let result;
  try {
    result = await verify(accessToken, productId, purchaseToken);
  } catch {
    // Paid but could not reach our server: leave the purchase open. It stays in
    // listPurchases(), so restorePurchases() on the next visit credits it.
    try { await response.complete('unknown'); } catch { /* ignore */ }
    return { error: 'network_pending' };
  }

  try { await response.complete(result.ok ? 'success' : 'fail'); } catch { /* ignore */ }
  if (result.ok) return { ok: true, balance: result.body.balance, coins: result.body.coins };
  if (result.status === 409) return { error: 'purchase_pending' };
  return { error: result.body.error || 'verify_failed' };
}

// Purchases Play still lists as owned (paid but never credited, e.g. the app was
// closed mid-purchase). Each is verified again; crediting is idempotent per token.
export async function restorePurchases(accessToken) {
  const service = await getService();
  if (!service) return { restored: 0, balance: null };
  let owned = [];
  try { owned = await service.listPurchases(); } catch { return { restored: 0, balance: null }; }
  let restored = 0;
  let balance = null;
  for (const p of owned) {
    try {
      const r = await verify(accessToken, p.itemId, p.purchaseToken);
      if (r.ok) {
        balance = r.body.balance;
        if (!r.body.already) restored++;
      }
    } catch { /* try again next visit */ }
  }
  return { restored, balance };
}
