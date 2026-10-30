// In-memory limiter for the AI reading endpoint (no dependency; counters
// reset when the process restarts). Three layers:
//   1. per-IP burst window   - stops scripted hammering
//   2. per-IP daily cap      - bounds what one address can spend
//   3. global daily cap      - bounds the worst-case Gemini bill even if an
//                              attacker rotates IPs
// Defaults are generous on purpose: students on one classroom wifi share an
// IP, and the apps have no automatic history, so people legitimately redraw.
// Override with RATE_WINDOW_MIN / RATE_MAX_PER_WINDOW / RATE_MAX_PER_DAY /
// RATE_GLOBAL_PER_DAY in .env.
const KST_OFFSET_MS = 9 * 60 * 60 * 1000;

const num = (value, fallback) => (Number(value) > 0 ? Number(value) : fallback);
const kstDay = (now) => new Date(now + KST_OFFSET_MS).toISOString().slice(0, 10);
const secondsToKstMidnight = (now) => {
  const next = Math.floor((now + KST_OFFSET_MS) / 86400000 + 1) * 86400000 - KST_OFFSET_MS;
  return Math.max(1, Math.ceil((next - now) / 1000));
};

function createLimiter() {
  const windowMs = num(process.env.RATE_WINDOW_MIN, 10) * 60 * 1000;
  const maxPerWindow = num(process.env.RATE_MAX_PER_WINDOW, 30);
  const maxPerDay = num(process.env.RATE_MAX_PER_DAY, 150);
  const globalPerDay = num(process.env.RATE_GLOBAL_PER_DAY, 3000);

  const recent = new Map(); // ip -> timestamps inside the window
  const today = new Map(); // ip -> count for the current KST day
  let day = kstDay(Date.now());
  let globalCount = 0;

  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [ip, stamps] of recent) {
      const live = stamps.filter((t) => now - t < windowMs);
      if (live.length) recent.set(ip, live);
      else recent.delete(ip);
    }
  }, 60 * 1000);
  sweep.unref();

  function deny(res, message, retryAfterSec) {
    res.set('Retry-After', String(retryAfterSec));
    return res.status(429).json({ error: message, retryAfterSec });
  }

  return function limiter(req, res, next) {
    const now = Date.now();
    const currentDay = kstDay(now);
    if (currentDay !== day) {
      day = currentDay;
      today.clear();
      globalCount = 0;
    }

    if (globalCount >= globalPerDay) {
      return deny(res, '오늘은 이용하시는 분이 많아 잠시 쉬어가요. 내일 다시 만나요.', secondsToKstMidnight(now));
    }

    const ip = req.ip || 'unknown';
    const stamps = (recent.get(ip) || []).filter((t) => now - t < windowMs);
    if (stamps.length >= maxPerWindow) {
      const retry = Math.max(1, Math.ceil((stamps[0] + windowMs - now) / 1000));
      return deny(res, '요청이 너무 많아요. 잠시 후 다시 시도해주세요.', retry);
    }
    const count = today.get(ip) || 0;
    if (count >= maxPerDay) {
      return deny(res, '오늘 이용 가능한 횟수를 모두 사용했어요. 내일 다시 만나요.', secondsToKstMidnight(now));
    }

    stamps.push(now);
    recent.set(ip, stamps);
    today.set(ip, count + 1);
    globalCount += 1;
    next();
  };
}

module.exports = { createLimiter };
