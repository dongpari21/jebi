# 🎟️ 제비뽑기

설치나 가입 없이 브라우저에서 바로 쓰는 랜덤 뽑기 웹앱입니다.
당첨/꽝 뽑기판, 이름 뽑기, 팀 나누기, 마니또를 한 화면에서 할 수 있습니다.

**▶ 바로 사용하기: https://dongpari21.github.io/jebi/**

![제비뽑기 미리보기](assets/preview.png)

## 기능

| 탭 | 설명 |
| --- | --- |
| **뽑기판** | 접힌 제비를 한 장씩 눌러 펼칩니다. `당첨/꽝` 개수를 정하거나, `커피 쏘기`, `꽝*5`처럼 내용을 직접 입력할 수 있습니다. |
| **이름 뽑기** | 제비통을 흔들어 참가자 중 N명을 뽑습니다. 이미 뽑힌 사람은 제외할 수 있고, 회차별 기록이 남습니다. |
| **팀 나누기** | 참가자를 N개 팀으로 고르게 나누고, 결과를 텍스트로 복사합니다. |
| **마니또** | 자기 자신이나 서로를 챙기는 쌍이 나오지 않도록 배정합니다. 모여서 한 기기로 돌려가며 확인하거나, **온라인 방**에서 각자 확인할 수 있습니다. |

- **공정한 난수**: `Math.random` 대신 `crypto.getRandomValues`를 쓰고, 모듈로 편향이 생기지 않도록 rejection sampling을 적용했습니다. 섞기는 Fisher–Yates 알고리즘을 씁니다.
- **마니또 배정**: 섞은 순서대로 참가자를 원형으로 이어(A→B→…→A) 배정합니다. 모든 배치가 같은 확률로 나오고, 3명 이상이면 자기 자신이나 서로를 챙기는 쌍이 생기지 않습니다.
- **마니또 온라인 방**: 진행자가 방을 만들고 초대 링크를 보내면, 참가자는 이름만 입력하고 입장합니다. 진행자가 구성을 완료하면 각자 화면에 자기 마니또가 실시간으로 열립니다.
  - Firebase 익명 로그인 + Cloud Firestore 실시간 구독(`onSnapshot`)
  - 배정 결과는 `rooms/{id}/secrets/{uid}`에 저장되고, [보안 규칙](firestore.rules)으로 **본인만 읽을 수 있습니다**. 진행자도 남의 결과는 읽을 수 없고, 완료 후에는 결과 수정·추가 입장이 막힙니다.
- **공유 링크**: 현재 설정을 URL 해시에 담아 공유합니다. 서버 없이 동작합니다.
- **자동 저장**: 입력한 내용은 `localStorage`에 저장되어 새로고침해도 유지됩니다.
- **다크 모드**, **반응형 레이아웃**, **키보드 탭 이동**, `prefers-reduced-motion` 대응

## 기술 스택

빌드 도구나 프레임워크 없이 **HTML, CSS, JavaScript(ES Modules)** 로 만들었고, 마니또 온라인 방에만 **Firebase**(Auth, Firestore)를 사용합니다. Firebase SDK는 온라인 방을 열 때만 불러옵니다.

```
index.html
css/style.css          디자인 토큰(라이트/다크), 레이아웃, 애니메이션
js/app.js              상태 관리, 폼 바인딩, 네 가지 뽑기 모드
js/manitto-room.js     마니또 온라인 방 (진행자 관리 화면, 참가자 방 화면)
js/room-api.js         Firebase 데이터 계층 (익명 로그인, 방·참가자·결과)
js/firebase-config.js  Firebase 웹 앱 설정
firestore.rules        Firestore 보안 규칙
js/utils.js            DOM·인코딩·공유 유틸
js/random.js           암호학적 난수 유틸 (randomInt, shuffle, sample)
js/confetti.js         의존성 없는 캔버스 컨페티
```

## 로컬에서 실행

ES Modules를 쓰기 때문에 정적 서버로 열어야 합니다.

```bash
python3 -m http.server 8000
# http://localhost:8000 접속
```
