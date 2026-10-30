require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const express = require('express');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

const { createLimiter } = require('./rate-limit');
const { registerBilling } = require('./billing');

const app = express();
// nginx sits in front and sets X-Forwarded-For; without this every visitor
// would look like 127.0.0.1 and share one rate-limit bucket.
app.set('trust proxy', 1);
const PORT = process.env.PORT || 3002;
const APP_KEY = 'oshozen-tarot';
const CARD_TYPE = '오쇼젠';

app.use(express.json());

// Osho card content ALREADY lives in the shared public.tarot_cards table
// (card_type = '오쇼젠', card_num 1-79) alongside color-tarot-app's
// '컬러타로' and rune-tarot-app's '룬타로' rows — it was migrated in from
// the old tarot-hub project previously, images included (image_url points
// at Supabase Storage). This app only reads it, never writes to it.
// Cached in memory for CARDS_TTL_MS so a live edit in the Table Editor
// shows up without a server restart, but every request doesn't pay for a
// DB round trip.
const CARDS_TTL_MS = 10 * 60 * 1000;
let cardsCache = null;
let cardsCacheAt = 0;
const CARD_SELECT = [
  'id', 'card_num', 'name', 'keyword', 'meaning', 'love', 'wealth',
  'health', 'career', 'caution', 'advice', 'image_url', 'mood_quote',
].join(', ');

function getSupabase() {
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);
}

async function getCards() {
  if (cardsCache && Date.now() - cardsCacheAt < CARDS_TTL_MS) return cardsCache;
  const sb = getSupabase();
  const { data, error } = await sb
    .from('tarot_cards')
    .select(CARD_SELECT)
    .eq('card_type', CARD_TYPE)
    .order('card_num');
  if (error) {
    console.error('Failed to load osho cards from Supabase', error);
    if (cardsCache) return cardsCache; // serve stale data over a hard failure
    throw error;
  }
  cardsCache = data;
  cardsCacheAt = Date.now();
  return cardsCache;
}

// card_num 1-23 are the Major Arcana (22 traditional cards + "마스터"),
// 24-79 are the Minor Arcana across 4 suits (불/물/구름/무지개), each
// named "{suit} {rank} · {keyword}" — no separate suit/arcana column
// needed, it's already encoded in the name string.
function isMajor(cardNum) {
  return cardNum <= 23;
}

function suitLabel(name, cardNum) {
  if (isMajor(cardNum)) return '메이저 아르카나';
  const [suitRank] = name.split(' · ');
  return `마이너 아르카나 · ${suitRank || ''}`;
}

// Public runtime config for the browser Supabase client. The anon key is
// designed to be public (row level security enforces access) — same
// pattern as color-tarot-app / rune-tarot-app.
app.get('/api/config', (req, res) => {
  res.json({
    supabaseUrl: process.env.SUPABASE_URL,
    supabaseAnonKey: process.env.SUPABASE_ANON_KEY,
  });
});

function cardGroundingLines(card) {
  const lines = [
    `카드 이름: ${card.name}`,
    `종류: ${suitLabel(card.name, card.card_num)}`,
    card.keyword && `핵심 키워드: ${card.keyword}`,
    card.meaning && `카드의 의미: ${card.meaning}`,
    card.advice && `조언: ${card.advice}`,
    card.love && `애정운: ${card.love}`,
    card.wealth && `재물운: ${card.wealth}`,
    card.health && `건강운: ${card.health}`,
    card.career && `직업/커리어운: ${card.career}`,
    card.caution && `주의할 점: ${card.caution}`,
    card.mood_quote && `카드가 전하는 말: ${card.mood_quote}`,
  ];
  return lines.filter(Boolean).join('\n');
}

async function callGemini(systemPrompt, userPrompt) {
  if (!process.env.GEMINI_API_KEY) {
    const err = new Error('AI reading is not configured yet (missing GEMINI_API_KEY).');
    err.status = 503;
    throw err;
  }
  const model = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
  const apiRes = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${process.env.GEMINI_API_KEY}`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: systemPrompt }] },
        contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
        generationConfig: {
          responseMimeType: 'application/json',
          temperature: 0.5,
          maxOutputTokens: 2048,
          thinkingConfig: { thinkingBudget: 0 },
        },
      }),
    }
  );
  if (!apiRes.ok) {
    const errText = await apiRes.text();
    console.error('Gemini API error', apiRes.status, errText);
    const err = new Error('AI reading failed');
    err.status = 502;
    throw err;
  }
  const data = await apiRes.json();
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    console.error('Could not find JSON in AI response', text);
    const err = new Error('AI reading failed');
    err.status = 502;
    throw err;
  }
  return JSON.parse(jsonMatch[0]);
}

// ---------------------------------------------------------------------
// Coins. Every call below is made WITH THE USER'S OWN TOKEN, so Supabase
// row-level security decides what they can see — this server holds no admin
// key. The reading is generated first and the coin is charged only after it
// exists, in one database step together with saving it to the user's history.
// ---------------------------------------------------------------------
const COIN_ITEM = 'reading';

function sbFetch(pathAndQuery, token, init = {}) {
  return fetch(`${process.env.SUPABASE_URL}${pathAndQuery}`, {
    ...init,
    headers: {
      apikey: process.env.SUPABASE_ANON_KEY,
      Authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      ...(init.headers || {}),
    },
  });
}

class HttpError extends Error {
  constructor(status, code, extra = {}) {
    super(code);
    this.status = status;
    this.body = { error: code, ...extra };
  }
}

async function requireUser(req) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) throw new HttpError(401, 'login_required');
  const r = await sbFetch('/auth/v1/user', token);
  if (!r.ok) throw new HttpError(401, 'login_required');
  return { token, user: await r.json() };
}

let priceCache = { coins: 1, at: 0 };
async function readingPrice(token) {
  if (Date.now() - priceCache.at < 5 * 60 * 1000) return priceCache.coins;
  try {
    const r = await sbFetch(`/rest/v1/coin_prices?app_key=eq.${APP_KEY}&item=eq.${COIN_ITEM}&select=coins`, token);
    const rows = r.ok ? await r.json() : [];
    if (rows[0]?.coins > 0) priceCache = { coins: rows[0].coins, at: Date.now() };
  } catch (e) {
    console.error('price lookup failed, using cached/default', e);
  }
  return priceCache.coins;
}

async function walletBalance(token) {
  const r = await sbFetch('/rest/v1/wallets?select=balance', token);
  if (!r.ok) throw new HttpError(502, 'wallet_unavailable');
  const rows = await r.json();
  return rows[0]?.balance ?? 0;
}

// Google Play coin packs (see billing.js). Valid product ids come from the
// public coin_products table so a price/pack change needs no redeploy.
let productCache = { ids: [], at: 0 };
async function activeProductIds() {
  if (Date.now() - productCache.at < 60 * 1000 && productCache.ids.length) return productCache.ids;
  const r = await fetch(`${process.env.SUPABASE_URL}/rest/v1/coin_products?active=eq.true&select=product_id`, {
    headers: { apikey: process.env.SUPABASE_ANON_KEY },
  });
  if (!r.ok) return productCache.ids;
  productCache = { ids: (await r.json()).map((p) => p.product_id), at: Date.now() };
  return productCache.ids;
}
registerBilling(app, {
  packageName: 'com.ozma.oshozentarot',
  requireUser, HttpError,
  limiter: createLimiter(),
  products: activeProductIds,
});

// ---------------------------------------------------------------------
// POST /api/reading — AI interpretation of the card the person drew (the draw
// itself is free and happens in the browser), 1 coin, saved to their history.
// ---------------------------------------------------------------------
app.post('/api/reading', createLimiter(), async (req, res) => {
  const body = req.body || {};
  const emotion = String(body.emotion || '').trim().slice(0, 500);
  if (!emotion) {
    return res.status(400).json({ error: 'emotion is required' });
  }
  if (!Number.isInteger(body.cardId)) {
    return res.status(400).json({ error: 'card is required' });
  }

  // Login and balance are checked BEFORE spending AI money.
  let token;
  try {
    ({ token } = await requireUser(req));
    const cost = await readingPrice(token);
    const balance = await walletBalance(token);
    if (balance < cost) {
      return res.status(402).json({ error: 'insufficient_coins', balance, cost });
    }
  } catch (err) {
    if (err instanceof HttpError) return res.status(err.status).json(err.body);
    console.error('auth/balance check failed', err);
    return res.status(502).json({ error: 'wallet_unavailable' });
  }

  try {
    const cards = await getCards();
    if (!cards.length) {
      return res.status(503).json({ error: '카드 데이터를 아직 불러올 수 없어요.' });
    }
    const card = cards.find((c) => c.id === body.cardId);
    if (!card) {
      return res.status(400).json({ error: 'unknown card' });
    }

    const systemPrompt = `당신은 내면 명상 타로에 깊이 정통한, 따뜻하고 지혜로운 타로 리더입니다. 내면 명상 타로는 명상, 깨달음, 현재 순간의 의식, 그리고 내면 깊은 곳에 초점을 맞춘 특별한 덱으로, 생생한 수채화 이미지들로 가득합니다.

근거 규칙 (가장 중요):
- 아래 [카드 기준 자료]가 이 풀이의 유일한 근거입니다. 카드의 의미, 조언, 영역별 해석(애정·재물·건강·커리어·주의점)은 반드시 이 자료의 내용에서 가져오세요.
- 자료와 다른 의미를 만들거나, 자료에 없는 카드 그림·인물·상징·장면을 지어내지 마세요. 카드의 장면은 자료의 "카드의 의미"에 묘사된 것만 말하세요.
- 당신의 역할은 자료를 바탕으로 이 사람의 감정에 맞게 풀어 쓰고, 자료와 모순되지 않는 범위에서 따뜻한 설명을 덧붙이는 것입니다. 자료의 핵심 문장과 조언은 의미가 바뀌지 않게 살려서 쓰세요.
- 이 사람의 감정이 연애·돈·건강·일 중 한 영역과 닿아 있으면 그 영역의 자료 내용을 우선 반영하세요. 닿아 있지 않으면 억지로 넣지 마세요.
- 핵심 키워드가 영어이면 자연스러운 한국어로 옮겨서 쓰세요.
- 항목명을 그대로 나열하지 말고 자연스러운 이야기로 풀어내세요.
- "interpretation" 필드는 다음 형식을 반드시 그대로 지켜 작성하세요.

[첫 줄: 요약]
지금 이 사람의 감정과 카드를 한 호흡으로 연결하는 따뜻한 요약 문장 1~2개.

[빈 줄]

◇ 감정 읽기
이 사람의 감정을 이름 붙여 따뜻하게 인정해주세요 (2~3문장). 판단 없이, 있는 그대로.

◇ 카드의 이미지
자료의 카드 이름, 핵심 키워드, "카드의 의미"에 담긴 장면과 에너지를 바탕으로 이 카드의 내면 풍경을 풀어주세요 (자료에 없는 그림은 만들지 마세요). 그리고 그 상징이 지금 이 사람의 감정과 어떻게 닮아있는지 자연스럽게 연결해주세요 (3~4문장).

◇ 카드의 메시지
자료의 카드 의미와 조언을 중심으로, 명상적·철학적 관점에서 이 감정에 어떤 빛을 비춰주는지 설명해주세요. 자료의 조언을 자연스럽게 녹여 현재 순간, 자각, 내면의 자유라는 언어로 따뜻하게 풀어주세요 (3~4문장).

◇ 오늘의 초대
자료의 조언에서 출발해, 오늘 자신에게 해줄 수 있는 작고 구체적인 한 가지를 부드럽게 제안해주세요 (2~3문장).

[마지막: 마무리 한 마디]
오늘 하루 마음속에 간직할 시처럼 아름다운 문장 1~2개로 끝맺어주세요. 이 줄 앞에는 ◇ 표시 없이 바로 써주세요.

글쓰기 원칙:
- 오래된 친구이자 명상 스승이 조용히 옆에 앉아 눈을 바라보며 말해주듯
- 명상의 언어: 판단 없음, 수용, 현재 순간, 자각, 내면의 자유
- ◇ 표시는 반드시 위의 4개 소주제에만 사용하고, 그 외에는 절대 사용 금지
- 볼드(**), 번호, 이모지 없이
- 전체 한국어로, 요약 포함 총 500~700자 분량으로 간결하게
- 특정 인물이나 덱의 이름은 언급하지 말고 "이 카드"로만 표현
- 반드시 아래 JSON 형식으로만 답하세요.

{
  "interpretation": "위 형식을 그대로 따른 전체 텍스트"
}`;

    const userPrompt = `오늘 이 사람이 나눠준 감정:
"${emotion}"

[카드 기준 자료] (이 내용을 근거로 풀이하세요)
${cardGroundingLines(card)}`;

    const parsed = await callGemini(systemPrompt, userPrompt);
    const cardOut = {
      id: card.id,
      cardNum: card.card_num,
      name: card.name,
      arcana: isMajor(card.card_num) ? 'Major' : 'Minor',
      topLabel: suitLabel(card.name, card.card_num),
      keyword: card.keyword,
      imageUrl: card.image_url,
    };

    // Save to the user's history AND charge, in one database step (all or
    // nothing). The reading is only handed over if this succeeds.
    const saved = await sbFetch('/rest/v1/rpc/save_reading_with_spend', token, {
      method: 'POST',
      body: JSON.stringify({
        p_app_key: APP_KEY,
        p_card_id: card.id,
        p_mood: emotion,
        p_memo: JSON.stringify({ reading: parsed.interpretation }),
      }),
    });
    if (!saved.ok) {
      console.error('save_reading_with_spend failed', saved.status, await saved.text());
      return res.status(502).json({ error: 'save_failed' });
    }
    const outcome = await saved.json();
    if (!outcome.ok) {
      const status = outcome.reason === 'insufficient_coins' ? 402 : 400;
      return res.status(status).json({ error: outcome.reason, balance: outcome.balance, cost: outcome.cost });
    }

    res.json({
      interpretation: parsed.interpretation,
      card: cardOut,
      emotion,
      balance: outcome.balance,
      cost: outcome.cost,
      readingId: outcome.reading_id,
    });
  } catch (err) {
    console.error('Error creating tarot reading', err);
    res.status(err.status || 500).json({ error: err.message || 'Failed to create tarot reading' });
  }
});

app.use(express.static(path.join(__dirname, 'public'), { dotfiles: 'allow' }));

app.listen(PORT, () => {
  console.log(`Inner Meditation Tarot App running at http://localhost:${PORT}`);
});
