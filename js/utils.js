// 여러 모듈이 함께 쓰는 DOM·인코딩·클립보드 유틸리티

export const $ = (sel, el = document) => el.querySelector(sel);
export const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];
export const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');

export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function toBase64Url(bytes) {
  let bin = '';
  bytes.forEach((b) => { bin += String.fromCharCode(b); });
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export const fromBase64Url = (str) =>
  Uint8Array.from(atob(str.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));

/** location.hash가 `#prefix=값` 형태면 값을 돌려준다 */
export function readHash(prefix) {
  const m = location.hash.match(new RegExp(`^#${prefix}=([\\w-]+)$`));
  return m ? m[1] : null;
}

export const pageUrl = () => `${location.origin}${location.pathname}`;

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.append(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  }
}

/**
 * 휴대폰에서는 공유 시트(카카오톡 등으로 바로 전송), 그 외에는 클립보드 복사.
 * @returns {'shared' | 'copied' | 'cancelled' | 'failed'}
 */
export async function shareOrCopy(text) {
  if (navigator.share && matchMedia('(pointer: coarse)').matches) {
    try {
      await navigator.share({ text });
      return 'shared';
    } catch (err) {
      if (err?.name === 'AbortError') return 'cancelled';
    }
  }
  return (await copyText(text)) ? 'copied' : 'failed';
}

let toastTimer;
export function toast(msg) {
  const el = $('#toast');
  // 모달 dialog는 최상위 레이어에 그려지므로, 열려 있으면 그 안으로 옮겨야 보인다
  const host = $('dialog[open]') ?? document.body;
  if (el.parentElement !== host) host.append(el);
  el.textContent = msg;
  el.classList.add('is-visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('is-visible'), 2400);
}
