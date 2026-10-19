// 비대면 마니또용 암호화 (Web Crypto API, 서버 없음)
//
// 1. 참가자가 등록하면 브라우저에서 ECDH(P-256) 키 쌍을 만든다.
//    개인 키는 extractable=false로 만들어 IndexedDB에 보관하므로 JS로도 밖으로 꺼낼 수 없다.
//    공개 키는 "등록 코드"에 담겨 진행자에게 전달된다.
// 2. 진행자는 각 참가자의 결과를 (임시 키 ⨉ 참가자 공개 키) ECDH → HKDF → AES-GCM으로 암호화해
//    결과 링크를 만든다. 진행자 쪽에는 개인 키가 없으므로 결과 링크를 풀 수 없다.
// 3. 결과 링크는 등록한 브라우저의 개인 키로만 복호화된다.

import { toBase64Url, fromBase64Url } from './utils.js?v=4';

const VERSION = 1;
const ROOM_BYTES = 6;
const PUB_BYTES = 65; // 비압축 P-256 공개 키
const IV_BYTES = 12;
const CODE_PREFIX = 'JEBI1-';
const ECDH = { name: 'ECDH', namedCurve: 'P-256' };
const HKDF_INFO = new TextEncoder().encode('jebi-manitto-v1');

const enc = new TextEncoder();
const dec = new TextDecoder('utf-8', { fatal: true });

export class SecretError extends Error {
  constructor(code) {
    super(code);
    this.code = code; // 'unsupported' | 'no-key' | 'wrong-key' | 'invalid'
  }
}

export const isSupported = () => !!(window.crypto?.subtle && window.indexedDB);

function concat(...parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

export const newRoomId = () => toBase64Url(crypto.getRandomValues(new Uint8Array(ROOM_BYTES)));

/* --------------------------------------------------------------------------
   IndexedDB 키 보관소
   -------------------------------------------------------------------------- */
const request = (req) => new Promise((resolve, reject) => {
  req.onsuccess = () => resolve(req.result);
  req.onerror = () => reject(req.error);
});

let dbPromise;
function openDb() {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open('jebi', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('keys', { keyPath: 'id', autoIncrement: true });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

async function keyStore(mode) {
  const db = await openDb();
  return db.transaction('keys', mode).objectStore('keys');
}

/** 이 브라우저에 등록된 특정 마니또방의 키 목록 (최근 등록 순) */
export async function keysForRoom(roomId) {
  const all = await request((await keyStore('readonly')).getAll());
  return all.filter((k) => k.roomId === roomId).sort((a, b) => b.createdAt - a.createdAt);
}

/* --------------------------------------------------------------------------
   참가 등록 링크 / 등록 코드
   -------------------------------------------------------------------------- */
export function makeJoinToken(roomId, title) {
  return toBase64Url(concat([VERSION], fromBase64Url(roomId), enc.encode(title)));
}

export function parseJoinToken(token) {
  try {
    const bytes = fromBase64Url(token);
    if (bytes[0] !== VERSION || bytes.length < 1 + ROOM_BYTES) throw 0;
    return {
      roomId: toBase64Url(bytes.slice(1, 1 + ROOM_BYTES)),
      title: dec.decode(bytes.slice(1 + ROOM_BYTES)),
    };
  } catch {
    throw new SecretError('invalid');
  }
}

/** 키 쌍을 만들어 보관하고, 진행자에게 보낼 등록 코드를 돌려준다 */
export async function register(roomId, name) {
  if (!isSupported()) throw new SecretError('unsupported');
  const pair = await crypto.subtle.generateKey(ECDH, false, ['deriveBits']);
  const pub = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
  const code = CODE_PREFIX + toBase64Url(concat([VERSION], fromBase64Url(roomId), pub, enc.encode(name)));
  await request((await keyStore('readwrite')).add({ roomId, name, code, privateKey: pair.privateKey, createdAt: Date.now() }));
  return code;
}

/** 붙여넣은 텍스트(채팅 내용 통째로도 가능)에서 등록 코드를 모두 찾아낸다 */
export function extractCodes(text) {
  const found = [];
  for (const [raw] of String(text).matchAll(/JEBI1-[A-Za-z0-9_-]{90,}/g)) {
    try {
      const bytes = fromBase64Url(raw.slice(CODE_PREFIX.length));
      const pub = bytes.slice(1 + ROOM_BYTES, 1 + ROOM_BYTES + PUB_BYTES);
      if (bytes[0] !== VERSION || pub.length !== PUB_BYTES || pub[0] !== 4) continue;
      const name = dec.decode(bytes.slice(1 + ROOM_BYTES + PUB_BYTES)).trim();
      if (!name) continue;
      found.push({ roomId: toBase64Url(bytes.slice(1, 1 + ROOM_BYTES)), name, key: toBase64Url(pub) });
    } catch {
      // 잘린 코드 등은 건너뜀
    }
  }
  return found;
}

/* --------------------------------------------------------------------------
   결과 암호화 / 복호화
   -------------------------------------------------------------------------- */
async function deriveAesKey(privateKey, publicKey, salt, usage) {
  const bits = await crypto.subtle.deriveBits({ name: 'ECDH', public: publicKey }, privateKey, 256);
  const hkdf = await crypto.subtle.importKey('raw', bits, 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt, info: HKDF_INFO },
    hkdf,
    { name: 'AES-GCM', length: 256 },
    false,
    [usage],
  );
}

const importPublic = (raw) => crypto.subtle.importKey('raw', raw, ECDH, false, []);

/** 참가자 공개 키로 payload를 암호화한 결과 토큰 */
export async function sealResult(roomId, recipientKey, payload) {
  const room = fromBase64Url(roomId);
  const recipient = await importPublic(fromBase64Url(recipientKey));
  const ephemeral = await crypto.subtle.generateKey(ECDH, false, ['deriveBits']);
  const ephPub = new Uint8Array(await crypto.subtle.exportKey('raw', ephemeral.publicKey));
  const aes = await deriveAesKey(ephemeral.privateKey, recipient, room, 'encrypt');
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const header = concat([VERSION], room, ephPub);
  const sealed = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: header },
    aes,
    enc.encode(JSON.stringify(payload)),
  );
  return toBase64Url(concat(header, iv, new Uint8Array(sealed)));
}

/** 이 브라우저에 보관된 키로 결과 토큰을 연다 */
export async function openResult(token) {
  if (!isSupported()) throw new SecretError('unsupported');
  let bytes;
  try { bytes = fromBase64Url(token); } catch { throw new SecretError('invalid'); }
  const headerLen = 1 + ROOM_BYTES + PUB_BYTES;
  if (bytes[0] !== VERSION || bytes.length < headerLen + IV_BYTES + 16) throw new SecretError('invalid');

  const room = bytes.slice(1, 1 + ROOM_BYTES);
  const header = bytes.slice(0, headerLen);
  const iv = bytes.slice(headerLen, headerLen + IV_BYTES);
  const sealed = bytes.slice(headerLen + IV_BYTES);

  const keys = await keysForRoom(toBase64Url(room));
  if (!keys.length) throw new SecretError('no-key');

  let ephemeral;
  try { ephemeral = await importPublic(bytes.slice(1 + ROOM_BYTES, headerLen)); } catch { throw new SecretError('invalid'); }

  // 한 브라우저에서 여러 명이 등록했을 수 있으므로 보관된 키를 차례로 시도
  for (const k of keys) {
    try {
      const aes = await deriveAesKey(k.privateKey, ephemeral, room, 'decrypt');
      const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv, additionalData: header }, aes, sealed);
      return JSON.parse(dec.decode(plain));
    } catch {
      // 다음 키 시도
    }
  }
  throw new SecretError('wrong-key');
}
