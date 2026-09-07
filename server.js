require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const express = require('express');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const PORT = process.env.PORT || 3002;
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

function drawCard(cards) {
  return cards[Math.floor(Math.random() * cards.length)];
}

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
// POST /api/reading — draws a card for the given emotion and returns an
// AI interpretation. Free, no login required. Saving to history (the
// `readings` table) happens client-side, only if the user is logged in
// and taps "저장" — same pattern as color-tarot-app.
// ---------------------------------------------------------------------
app.post('/api/reading', async (req, res) => {
  const { emotion } = req.body || {};
  if (!emotion || !emotion.trim()) {
    return res.status(400).json({ error: 'emotion is required' });
  }

  try {
    const cards = await getCards();
    if (!cards.length) {
      return res.status(503).json({ error: '카드 데이터를 아직 불러올 수 없어요.' });
    }
    const card = drawCard(cards);

    const systemPrompt = `당신은 오쇼젠 타로(Osho Zen Tarot)에 깊이 정통한, 따뜻하고 지혜로운 타로 리더입니다. 오쇼젠 타로는 명상, 깨달음, 현재 순간의 의식에 초점을 맞춘 특별한 덱으로, 생생한 수채화 이미지들로 가득합니다.

규칙:
- 아래 전달되는 카드 데이터는 참고 자료입니다. 항목명을 그대로 나열하지 말고 자연스러운 이야기로 풀어내세요.
- "interpretation" 필드는 다음 형식을 반드시 그대로 지켜 작성하세요.

[첫 줄: 요약]
지금 이 사람의 감정과 카드를 한 호흡으로 연결하는 따뜻한 요약 문장 1~2개.

[빈 줄]

◇ 감정 읽기
이 사람의 감정을 이름 붙여 따뜻하게 인정해주세요 (2~3문장). 판단 없이, 있는 그대로.

◇ 카드의 이미지
카드 이름, 핵심 키워드, 본질적 의미를 바탕으로 이 카드가 상징하는 내면의 풍경과 에너지를 생생하게 풀어주세요. 그리고 그 상징이 지금 이 사람의 감정과 어떻게 닮아있는지 자연스럽게 연결해주세요 (3~4문장).

◇ 카드의 메시지
카드의 본질적 의미와 오쇼의 철학적 관점에서 이 감정에 어떤 빛을 비춰주는지 설명해주세요. 조언을 자연스럽게 녹여 현재 순간, 자각, 내면의 자유라는 언어로 따뜻하게 풀어주세요 (3~4문장).

◇ 오늘의 초대
오늘 자신에게 해줄 수 있는 작고 따뜻한 한 가지를 부드럽게 제안해주세요 (2~3문장).

[마지막: 마무리 한 마디]
오늘 하루 마음속에 간직할 시처럼 아름다운 문장 1~2개로 끝맺어주세요. 이 줄 앞에는 ◇ 표시 없이 바로 써주세요.

글쓰기 원칙:
- 오래된 친구이자 명상 스승이 조용히 옆에 앉아 눈을 바라보며 말해주듯
- 오쇼의 언어: 판단 없음, 수용, 현재 순간, 자각, 내면의 자유
- ◇ 표시는 반드시 위의 4개 소주제에만 사용하고, 그 외에는 절대 사용 금지
- 볼드(**), 번호, 이모지 없이
- 전체 한국어로, 요약 포함 총 500~700자 분량으로 간결하게
- 반드시 아래 JSON 형식으로만 답하세요.

{
  "interpretation": "위 형식을 그대로 따른 전체 텍스트"
}`;

    const userPrompt = `오늘 이 사람이 나눠준 감정:
"${emotion}"

우주가 뽑아준 카드:
${cardGroundingLines(card)}`;

    const parsed = await callGemini(systemPrompt, userPrompt);
    res.json({
      interpretation: parsed.interpretation,
      card: {
        id: card.id,
        cardNum: card.card_num,
        name: card.name,
        arcana: isMajor(card.card_num) ? 'Major' : 'Minor',
        topLabel: suitLabel(card.name, card.card_num),
        keyword: card.keyword,
        imageUrl: card.image_url,
      },
      emotion,
    });
  } catch (err) {
    console.error('Error creating tarot reading', err);
    res.status(err.status || 500).json({ error: err.message || 'Failed to create tarot reading' });
  }
});

app.use(express.static(path.join(__dirname, 'public'), { dotfiles: 'allow' }));

app.listen(PORT, () => {
  console.log(`Osho Zen Tarot App running at http://localhost:${PORT}`);
});
