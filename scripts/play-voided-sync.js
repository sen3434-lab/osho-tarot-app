// Takes coins back for purchases Google refunded or charged back.
// Run by hand or from cron (e.g. every 6 hours):
//   node scripts/play-voided-sync.js            # last 30 days
//   node scripts/play-voided-sync.js 90         # last 90 days
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { syncVoidedPurchases, isConfigured } = require('../billing');

(async () => {
  if (!isConfigured()) {
    console.error('billing is not configured (service account / BILLING_SECRET / Supabase env missing)');
    process.exit(1);
  }
  const days = Number(process.argv[2]) || 30;
  const out = await syncVoidedPurchases('com.ozma.oshozentarot', { sinceMs: Date.now() - days * 86400000 });
  console.log(new Date().toISOString(), JSON.stringify(out));
})().catch((e) => { console.error(e); process.exit(1); });
