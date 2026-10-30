// Shared app bootstrap: Supabase client, auth helpers, nav, toast, coin wallet.
// Loaded as a module on every page. Mirrors color-tarot-app / rune-tarot-app
// so all OZ apps share one membership system and one coin wallet.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

let _sb = null;
let _sbReady;

async function initSupabase() {
  if (_sb) return _sb;
  const res = await fetch('/api/config');
  const { supabaseUrl, supabaseAnonKey } = await res.json();
  _sb = createClient(supabaseUrl, supabaseAnonKey);
  return _sb;
}

_sbReady = initSupabase();

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  });
}

export async function getSb() {
  return _sbReady;
}

// True when running inside the Android TWA/Capacitor wrapper rather than a
// regular browser.
export function isTWA() {
  return document.referrer.startsWith('android-app://');
}

export async function getSession() {
  const sb = await getSb();
  const { data } = await sb.auth.getSession();
  return data.session;
}

// This app's key in the shared multi-app membership schema (public.apps).
export const APP_KEY = 'oshozen-tarot';

// Ensures public.members (global identity) and public.enrollments (this
// app's role/subscription/usage row) both exist for the current user, then
// returns a merged view.
export async function ensureMemberRow(session, nickname) {
  if (!session) return null;
  const sb = await getSb();

  let { data: memberRow } = await sb
    .from('members')
    .select('*')
    .eq('id', session.user.id)
    .maybeSingle();

  if (!memberRow) {
    const oauthName = session.user.user_metadata?.full_name || session.user.user_metadata?.name || null;
    let pendingNickname = null;
    try { pendingNickname = localStorage.getItem('ot_pending_nickname'); } catch {}
    const { data: created, error } = await sb
      .from('members')
      .insert({ id: session.user.id, email: session.user.email, display_name: oauthName || nickname || pendingNickname || null })
      .select()
      .single();
    if (error) {
      console.error('ensureMemberRow (members) failed', error);
      return null;
    }
    try { localStorage.removeItem('ot_pending_nickname'); } catch {}
    memberRow = created;
  }

  let { data: enrollment } = await sb
    .from('enrollments')
    .select('*')
    .eq('member_id', session.user.id)
    .eq('app_key', APP_KEY)
    .maybeSingle();

  if (!enrollment) {
    const { data: created, error } = await sb
      .from('enrollments')
      .insert({ member_id: session.user.id, app_key: APP_KEY })
      .select()
      .single();
    if (error) {
      console.error('ensureMemberRow (enrollment) failed', error);
      return null;
    }
    enrollment = created;
  } else if (enrollment.role !== 'student') {
    // Only worth the extra round trip if they're not already a student —
    // once promoted there's nothing left to recheck.
    const { data: isStudent } = await sb.rpc('recheck_student_status', { p_app_key: APP_KEY });
    if (isStudent) {
      enrollment = { ...enrollment, role: 'student' };
    }
  }

  return {
    id: memberRow.id,
    email: memberRow.email,
    display_name: memberRow.display_name,
    created_at: memberRow.created_at,
    enrollment_id: enrollment.id,
    role: enrollment.role,
    subscription_status: enrollment.subscription_status,
    subscription_expires_at: enrollment.subscription_expires_at,
    daily_reading_count: enrollment.daily_reading_count,
    daily_reading_reset_date: enrollment.daily_reading_reset_date,
  };
}

export async function getMember(session, nickname) {
  return ensureMemberRow(session, nickname);
}

export async function signOut() {
  const sb = await getSb();
  await sb.auth.signOut();
  window.location.href = '/auth.html';
}

export function showToast(msg, ms = 2200) {
  let el = document.querySelector('.toast');
  if (!el) {
    el = document.createElement('div');
    el.className = 'toast';
    document.body.appendChild(el);
  }
  el.textContent = msg;
  requestAnimationFrame(() => el.classList.add('show'));
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.remove('show'), ms);
}

// 아래 메뉴: 리딩 · 명상 · 기록 · 코인 (설정은 위쪽 "계정" 버튼)
const NAV_ITEMS = [
  { href: '/index.html', ic: '\u{1F52E}', label: '리딩' },
  { href: '/meditation.html', ic: '\u{1F9D8}', label: '명상' },
  { href: '/history.html', ic: '\u{1F4D6}', label: '기록' },
  { href: '/coins.html', ic: '\u{1FA99}', label: '코인' },
];

export function renderBottomNav(active) {
  const nav = document.createElement('nav');
  nav.className = 'bottom-nav';
  nav.innerHTML = NAV_ITEMS.map(item => `
    <a href="${item.href}" class="${active === item.href ? 'active' : ''}">
      <span class="ic">${item.ic}</span>
      <span>${item.label}</span>
    </a>
  `).join('');
  document.body.appendChild(nav);
}

export function fmtDate(d) {
  const dt = typeof d === 'string' ? new Date(d) : d;
  return `${dt.getFullYear()}년 ${dt.getMonth() + 1}월 ${dt.getDate()}일`;
}

// Redirects to /auth.html if not logged in. Returns the session otherwise.
export async function requireAuth() {
  const session = await getSession();
  if (!session) {
    window.location.href = '/auth.html';
    return null;
  }
  return session;
}

// ---------------------------------------------------------------------
// OZ coin wallet (shared by every OZ tarot app — one balance per account).
// The browser can only READ its wallet; every grant/charge happens inside
// database functions, so none of this can be forged from the console.
// ---------------------------------------------------------------------
const kstDate = () => new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);

export async function getBalance() {
  const sb = await getSb();
  const { data } = await sb.from('wallets').select('balance').maybeSingle();
  return data?.balance ?? 0;
}

export async function getPrice(item = 'reading') {
  const sb = await getSb();
  const { data } = await sb.from('coin_prices').select('coins').eq('app_key', APP_KEY).eq('item', item).maybeSingle();
  return data?.coins ?? 1;
}

// Call once the member row exists. Grants the signup bonus (first time ever)
// and today's attendance coin (first open of the day, KST). Safe to call
// repeatedly — the database refuses duplicates — but we remember "done
// today" to avoid a request on every page. Returns the new balance or null.
export async function claimFreeCoins(session) {
  if (!session) return null;
  const doneKey = `oz_claim_${session.user.id}`;
  try {
    if (localStorage.getItem(doneKey) === kstDate()) return null;
  } catch {}
  const sb = await getSb();
  const { data, error } = await sb.rpc('claim_free_coins');
  if (error || !data?.ok) {
    if (error) console.error('claim_free_coins failed', error);
    return null;
  }
  try { localStorage.setItem(doneKey, kstDate()); } catch {}
  const parts = [];
  if (data.signup > 0) parts.push(`가입 보너스 +${data.signup}코인`);
  if (data.attendance > 0) parts.push(`출석 보너스 +${data.attendance}코인`);
  if (data.admin > 0) parts.push(`운영자 지급 +${data.admin}코인`);
  if (parts.length) showToast('🪙 ' + parts.join(' · '), 3200);
  return data.balance;
}

// Small "🪙 N" pill for the top bar (shows "로그인" for visitors).
export async function renderCoinBadge(el) {
  if (!el) return null;
  const session = await getSession();
  if (!session) {
    el.textContent = '로그인';
    el.href = '/auth.html';
    return null;
  }
  const balance = await getBalance();
  el.textContent = '🪙 ' + balance;
  el.href = '/coins.html';
  return balance;
}

// What to tell the visitor when the server says login or coins are missing.
export function gateMessage(status) {
  if (status === 401) return { title: '로그인이 필요해요', desc: '가입하면 5코인을 바로 드려요. 풀이는 코인 1개로 열어볼 수 있어요.', btn: '로그인 / 가입하기', href: '/auth.html' };
  return { title: '코인이 부족해요', desc: '충전하거나, 매일 출석하면 1코인씩 받아요. 수강생 코드를 입력하면 100코인을 드려요.', btn: '코인 충전하기', href: '/coins.html' };
}
