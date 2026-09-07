-- ============================================================
-- OZ 오쇼젠타로 — registers this app in the shared multi-app membership
-- schema. UNLIKE color-tarot / rune-tarot, the 79 Osho Zen cards are
-- ALREADY in public.tarot_cards (card_type = '오쇼젠', card_num 1-79,
-- image_url pointing at Supabase Storage tarot-cards/osho-zen/*) — most
-- likely migrated over from the old tarot-hub project already. This app
-- reads that existing data as-is; nothing here touches tarot_cards.
--
-- This is the ONLY thing this app needs from the DB side: readings.app_key
-- has a foreign key to public.apps(key), so a row must exist here before
-- any reading can be saved to history.
-- ============================================================

insert into public.apps (key, name) values
  ('oshozen-tarot', '오쇼젠 타로')
on conflict (key) do nothing;
