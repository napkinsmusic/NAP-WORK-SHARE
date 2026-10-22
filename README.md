# NAPKINS 공유 메모

GitHub Pages에서 화면을 제공하고 Firebase Authentication과 Firestore로 실시간 동기화하는 공유 메모 보드입니다.

## Firebase 설정

1. Firebase 프로젝트와 웹 앱을 만듭니다.
2. Authentication에서 `익명` 로그인 제공업체를 활성화합니다.
3. Firestore Database를 프로덕션 모드로 만듭니다.
4. 웹 앱 설정값을 `firebase-config.js`에 입력합니다.
5. `.firebaserc`에 실제 프로젝트 ID를 입력합니다.
6. Firebase CLI에서 `firebase deploy --only firestore:rules`를 실행합니다.

Firebase 웹 설정값은 공개 식별자입니다. 실제 접근 권한은 `firestore.rules`에서 제어합니다.

## 붙여넣은 이미지

내용 영역에 붙여넣은 캡처 이미지는 브라우저에서 WebP로 변환되며 300KB 이하가 될 때까지 압축됩니다. 이미지를 클릭한 뒤 우측 아래를 드래그하면 크기가 조절되고, 두 번 클릭하면 원래 크기로 돌아갑니다. 이미지는 별도 Firestore 문서에 Base64로 저장되므로 Firebase Storage와 유료 요금제가 필요하지 않습니다. 이미지와 일일 내용 기록은 30일이 지나면 사이트 접속 시 자동으로 삭제되며 제목, 팀원 이름과 프로필 사진은 유지됩니다.

## GitHub Pages

`main` 브랜치에 푸시하면 GitHub Pages가 사이트를 자동 배포합니다.

## 공유 권한

이 프로젝트는 링크 방문자를 Firebase 익명 계정으로 로그인시키며, 로그인된 방문자는 모두 같은 보드를 편집할 수 있습니다. 링크가 외부에 공개되면 제3자도 수정할 수 있으므로 민감한 정보는 입력하지 마세요.
