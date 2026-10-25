// 마니또 방 데이터 계층 (Firebase Anonymous Auth + Cloud Firestore)
//
// rooms/{roomId}                 { title, ownerUid, admins?: [uid], status: 'open' | 'done', createdAt }
// rooms/{roomId}/members/{uid}   { name, joinedAt }      ← 방 참가자 누구나 읽기 가능 (명단)
// rooms/{roomId}/secrets/{uid}   { target, title }       ← 본인(uid)만 읽기 가능 (firestore.rules)
// rooms/{roomId}/reveals/{uid}   { name, target }        ← 공개에 동의한 사람의 결과. 전원 동의 전에는 아무도 못 읽음
//   (rooms 문서의 memberCount = 참가 인원, revealVotes = 공개에 동의한 uid 목록)
// rooms/{roomId}/rejoins/{newUid} { memberUid, name, approved } ← 기기가 바뀐 참가자의 재접속 요청 (방장 승인)
//
// 승인된 재접속 기기는 원래 참가자 uid(actingUid)로 결과 조회·공개 투표를 한다.
//
// Firebase SDK는 마니또 방을 쓸 때만 동적으로 불러온다.

import { firebaseConfig } from './firebase-config.js?v=9';

const SDK = 'https://www.gstatic.com/firebasejs/13.0.0';
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
  batch.update(fs.doc(db, 'rooms', roomId), { status: 'done', memberCount: pairs.length });
  await batch.commit();
}

/** 내가 만들었거나 공동 방장인 방 목록 실시간 구독 (최근 생성 순) */
export async function watchMyRooms(cb, onError) {
  const { uid, db, fs } = await connect();
  const rooms = fs.collection(db, 'rooms');
  const found = { owned: [], shared: [] };
  const emit = () => {
    const byId = new Map([...found.shared, ...found.owned].map((r) => [r.id, r]));
    const time = (r) => r.createdAt?.toMillis?.() ?? Date.now();
    cb([...byId.values()].sort((a, b) => time(b) - time(a)));
  };
  const listen = (key, q) => fs.onSnapshot(q, (snap) => {
    found[key] = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    emit();
  }, onError);
  const offs = [
    listen('owned', fs.query(rooms, fs.where('ownerUid', '==', uid))),
    // 공동 방장 목록은 규칙을 아직 게시하지 않았으면 실패할 수 있으므로 오류를 따로 무시한다
    fs.onSnapshot(fs.query(rooms, fs.where('admins', 'array-contains', uid)), (snap) => {
      found.shared = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      emit();
    }, (err) => console.warn('shared rooms unavailable', err)),
  ];
  return () => offs.forEach((off) => off());
}

/** 원래 방장: 참가자를 공동 방장으로 지정하거나 해제 */
export async function setAdmin(roomId, memberUid, on) {
  const { db, fs } = await connect();
  await fs.updateDoc(fs.doc(db, 'rooms', roomId), {
    admins: on ? fs.arrayUnion(memberUid) : fs.arrayRemove(memberUid),
  });
}

export async function countMembers(roomId) {
  const { db, fs } = await connect();
  const snap = await fs.getCountFromServer(fs.collection(db, 'rooms', roomId, 'members'));
  return snap.data().count;
}

export async function renameRoom(roomId, title) {
  const { db, fs } = await connect();
  await fs.updateDoc(fs.doc(db, 'rooms', roomId), { title });
}

/** 방과 참가자 명단·배정 결과를 한 번에 삭제한다 (하위 문서는 자동으로 지워지지 않으므로 직접 지움) */
export async function deleteRoom(roomId) {
  const { db, fs } = await connect();
  const members = await fs.getDocs(fs.collection(db, 'rooms', roomId, 'members'));
  const batch = fs.writeBatch(db);
  const rejoins = await fs.getDocs(fs.collection(db, 'rooms', roomId, 'rejoins'));
  for (const m of members.docs) {
    batch.delete(fs.doc(db, 'rooms', roomId, 'secrets', m.id));
    batch.delete(fs.doc(db, 'rooms', roomId, 'reveals', m.id));
    batch.delete(m.ref);
  }
  for (const r of rejoins.docs) batch.delete(r.ref);
  batch.delete(fs.doc(db, 'rooms', roomId));
  await batch.commit();
}

/**
 * 전체 공개에 동의(agree=true)하거나 동의를 취소한다.
 * 동의하면 내 결과를 공개 대기함(reveals)에 넣는다. 전원이 동의하기 전에는 누구도 읽을 수 없다.
 */
export async function voteReveal(roomId, agree, { name, target } = {}, actingUid) {
  const { db, fs, ...me } = await connect();
  const uid = actingUid ?? me.uid;
  const batch = fs.writeBatch(db);
  const roomRef = fs.doc(db, 'rooms', roomId);
  const revealRef = fs.doc(db, 'rooms', roomId, 'reveals', uid);
  if (agree) {
    batch.set(revealRef, { name, target });
    batch.update(roomRef, { revealVotes: fs.arrayUnion(uid) });
  } else {
    batch.delete(revealRef);
    batch.update(roomRef, { revealVotes: fs.arrayRemove(uid) });
  }
  await batch.commit();
}

/** 전원 동의 후 공개된 전체 명단 */
export async function getReveals(roomId) {
  const { db, fs } = await connect();
  const snap = await fs.getDocs(fs.collection(db, 'rooms', roomId, 'reveals'));
  return snap.docs.map((d) => d.data());
}

/** 내 마니또. 보안 규칙상 본인 문서만 읽을 수 있다. */
export async function getMySecret(roomId, actingUid) {
  const { db, fs, ...me } = await connect();
  const snap = await fs.getDoc(fs.doc(db, 'rooms', roomId, 'secrets', actingUid ?? me.uid));
  return snap.exists() ? snap.data() : null;
}

export async function myUid() {
  return (await connect()).uid;
}

/* --------------------------------------------------------------------------
   재접속 (기기·브라우저가 바뀐 참가자)
   -------------------------------------------------------------------------- */
export async function requestRejoin(roomId, memberUid, name) {
  const { uid, db, fs } = await connect();
  await fs.setDoc(fs.doc(db, 'rooms', roomId, 'rejoins', uid), {
    memberUid, name, approved: false, requestedAt: fs.serverTimestamp(),
  });
}

/** 이 기기의 재접속 요청 상태 (없으면 null) */
export async function watchMyRejoin(roomId, cb, onError) {
  const { uid, db, fs } = await connect();
  return fs.onSnapshot(fs.doc(db, 'rooms', roomId, 'rejoins', uid), (snap) => cb(snap.exists() ? snap.data() : null), onError);
}

export async function cancelRejoin(roomId) {
  const { uid, db, fs } = await connect();
  await fs.deleteDoc(fs.doc(db, 'rooms', roomId, 'rejoins', uid));
}

/** 방장: 재접속 요청 목록 */
export async function watchRejoins(roomId, cb, onError) {
  const { db, fs } = await connect();
  return fs.onSnapshot(fs.collection(db, 'rooms', roomId, 'rejoins'),
    (snap) => cb(snap.docs.map((d) => ({ newUid: d.id, ...d.data() }))), onError);
}

export async function approveRejoin(roomId, newUid) {
  const { db, fs } = await connect();
  await fs.updateDoc(fs.doc(db, 'rooms', roomId, 'rejoins', newUid), { approved: true });
}

export async function rejectRejoin(roomId, newUid) {
  const { db, fs } = await connect();
  await fs.deleteDoc(fs.doc(db, 'rooms', roomId, 'rejoins', newUid));
}
