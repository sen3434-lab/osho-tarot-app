-- ============================================================
-- OZ 내면 명상 타로 코인제 도입 (풀이 1코인)
--
-- 먼저 실행되어 있어야 하는 것: coins_1_wallet.sql (RUN_THIS_coins_setup.sql 에 포함)
-- 재실행해도 안전합니다.
--
-- 풀이 저장 + 코인 차감은 컬러타로와 같은 함수(save_reading_with_spend)를 쓰므로
-- 새 함수는 필요 없고, 이 앱의 가격만 넣으면 됩니다.
-- ============================================================

-- 1) 앱 등록 확인 (이미 있으면 그대로 둠)
insert into public.apps (key, name)
values ('oshozen-tarot', 'OZ 내면 명상 타로')
on conflict (key) do update set name = excluded.name;

-- 2) 가격표: 풀이 1코인
insert into public.coin_prices (app_key, item, coins) values
  ('oshozen-tarot', 'reading', 1)
on conflict (app_key, item) do nothing;

-- 3) 수강생 코드: 입력하면 100코인
insert into public.class_codes (code, app_key, label, coins)
values ('OZMA-2026-INNER', 'oshozen-tarot', '2026 내면 명상 타로 수강생', 100)
on conflict (code, app_key) do nothing;

-- 확인: 아래 두 줄이 나오면 성공
select app_key, item, coins from public.coin_prices where app_key = 'oshozen-tarot';
select code, app_key, coins, active from public.class_codes where code = 'OZMA-2026-INNER';
