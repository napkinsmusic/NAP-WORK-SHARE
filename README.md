# NAPKINS 공유 메모

GitHub Pages에서 화면을 제공하고 Firebase Authentication과 Firestore로 실시간 동기화하는 공유 메모 보드입니다.

## Firebase 설정

1. Firebase 프로젝트와 웹 앱을 만듭니다.
2. Authentication에서 `익명` 로그인 제공업체를 활성화합니다.
3. Firestore Database를 프로덕션 모드로 만듭니다.
4. 웹 앱 설정값을 `firebase-config.js`에 입력합니다.
5. `.firebaserc`의 `REPLACE_WITH_PROJECT_ID`를 실제 프로젝트 ID로 바꿉니다.
6. Firebase CLI에서 `firebase deploy --only firestore:rules`를 실행합니다.

Firebase 웹 설정값은 공개 식별자입니다. 실제 접근 권한은 `firestore.rules`에서 제어합니다.

## GitHub Pages

`main` 브랜치에 푸시하면 `.github/workflows/pages.yml`이 사이트를 자동 배포합니다. 저장소의 Settings > Pages에서 Source를 `GitHub Actions`로 설정해야 합니다.

## 공유 권한

이 프로젝트는 링크 방문자를 Firebase 익명 계정으로 로그인시키며, 로그인된 방문자는 모두 같은 보드를 편집할 수 있습니다. 링크가 외부에 공개되면 제3자도 수정할 수 있으므로 민감한 정보는 입력하지 마세요.
