// Firebase 웹 앱 설정 (Firebase 콘솔 → 프로젝트 설정 → 내 앱 → SDK 설정 및 구성).
// 이 값들은 공개돼도 되는 식별자이며, 실제 접근 제어는 firestore.rules가 담당한다.
// 비어 있으면 마니또 '온라인 방' 기능만 꺼지고 나머지는 그대로 동작한다.
export const firebaseConfig = {
  apiKey: '',
  authDomain: '',
  projectId: '',
  appId: '',
};
