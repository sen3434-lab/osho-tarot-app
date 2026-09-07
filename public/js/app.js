// Shared app bootstrap: Supabase client, auth helpers, nav, toast.
// Loaded as a module on every page. Mirrors color-tarot-app / rune-tarot-app
// so all three ozma apps share one membership system in one Supabase project.

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

const NAV_ITEMS = [
  { href: '/index.html', ic: '\u{1F52E}', label: '리딩' },
  { href: '/history.html', ic: '\u{1F5D3}\u{FE0F}', label: '기록' },
  { href: '/settings.html', ic: '\u{2699}\u{FE0F}', label: '설정' },
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
