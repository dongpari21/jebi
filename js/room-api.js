// 마니또 방 데이터 계층 (Firebase Anonymous Auth + Cloud Firestore)
//
// rooms/{roomId}                 { title, ownerUid, status: 'open' | 'done', createdAt }
// rooms/{roomId}/members/{uid}   { name, joinedAt }      ← 방 참가자 누구나 읽기 가능 (명단)
// rooms/{roomId}/secrets/{uid}   { target, title }       ← 본인(uid)만 읽기 가능 (firestore.rules)
//
// Firebase SDK는 마니또 방을 쓸 때만 동적으로 불러온다.

import { firebaseConfig } from './firebase-config.js?v=5';

const SDK = 'https://www.gstatic.com/firebasejs/10.12.2';
const ROOM_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';

export const isConfigured = () => Boolean(firebaseConfig?.apiKey && firebaseConfig?.projectId);

let ready;

/** SDK 로드 + 익명 로그인. 같은 브라우저에서는 같은 uid가 유지된다. */
export function connect() {
  ready ??= (async () => {
    if (!isConfigured()) throw new Error('not-configured');
    const [{ initializeApp }, auth, fs] = await Promise.all([
      import(`${SDK}/firebase-app.js`),
      import(`${SDK}/firebase-auth.js`),
      import(`${SDK}/firebase-firestore.js`),
    ]);
    const app = initializeApp(firebaseConfig);
    const a = auth.getAuth(app);
    await a.authStateReady();
    const user = a.currentUser ?? (await auth.signInAnonymously(a)).user;
    return { uid: user.uid, db: fs.getFirestore(app), fs };
  })();
  ready.catch(() => { ready = undefined; });
  return ready;
}

function newRoomId() {
  const bytes = crypto.getRandomValues(new Uint8Array(10));
  return [...bytes].map((b) => ROOM_ALPHABET[b % ROOM_ALPHABET.length]).join('');
}

export async function createRoom(title) {
  const { uid, db, fs } = await connect();
  const roomId = newRoomId();
  await fs.setDoc(fs.doc(db, 'rooms', roomId), {
    title, ownerUid: uid, status: 'open', createdAt: fs.serverTimestamp(),
  });
  return roomId;
}

/** 방 정보 실시간 구독. 방이 없으면 cb(null) */
export async function watchRoom(roomId, cb, onError) {
  const { db, fs } = await connect();
  return fs.onSnapshot(fs.doc(db, 'rooms', roomId), (snap) => cb(snap.exists() ? { id: roomId, ...snap.data() } : null), onError);
}

/** 참가자 명단 실시간 구독 (입장 순) */
export async function watchMembers(roomId, cb, onError) {
  const { db, fs } = await connect();
  const q = fs.query(fs.collection(db, 'rooms', roomId, 'members'), fs.orderBy('joinedAt'));
  return fs.onSnapshot(q, (snap) => cb(snap.docs.map((d) => ({ uid: d.id, name: d.data().name }))), onError);
}

export async function joinRoom(roomId, name) {
  const { uid, db, fs } = await connect();
  await fs.setDoc(fs.doc(db, 'rooms', roomId, 'members', uid), { name, joinedAt: fs.serverTimestamp() });
}

export async function renameMember(roomId, name) {
  const { uid, db, fs } = await connect();
  await fs.updateDoc(fs.doc(db, 'rooms', roomId, 'members', uid), { name });
}

export async function removeMember(roomId, memberUid) {
  const { uid, db, fs } = await connect();
  await fs.deleteDoc(fs.doc(db, 'rooms', roomId, 'members', memberUid ?? uid));
}

/** 진행자가 배정 결과를 각자의 비공개 문서에 쓰고 방을 닫는다 (한 번에 처리) */
export async function completeRoom(roomId, title, pairs) {
  const { db, fs } = await connect();
  const batch = fs.writeBatch(db);
  for (const { giverUid, targetName } of pairs) {
    batch.set(fs.doc(db, 'rooms', roomId, 'secrets', giverUid), { target: targetName, title });
  }
  batch.update(fs.doc(db, 'rooms', roomId), { status: 'done' });
  await batch.commit();
}

/** 내 마니또. 보안 규칙상 본인 문서만 읽을 수 있다. */
export async function getMySecret(roomId) {
  const { uid, db, fs } = await connect();
  const snap = await fs.getDoc(fs.doc(db, 'rooms', roomId, 'secrets', uid));
  return snap.exists() ? snap.data() : null;
}

export async function myUid() {
  return (await connect()).uid;
}
