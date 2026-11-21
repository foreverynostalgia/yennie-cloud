# YENNIE SENSE 인수인계 (Cloudflare 운영 기준)

기준일 **2026-11-20**. 2026-11-20에 ChatGPT Sites에서 Cloudflare Workers로 전환을 마쳤다. 이 문서는 세 저장소(`yennie-booking`, `yennie-manager`, `yennie-cloud`)에 같은 내용으로 들어 있다. 비밀번호·API 키·토큰 값은 적지 않고, 이름과 위치만 적는다.

## 1. 사이트와 저장소

| 역할 | 운영 주소 | 저장소 | Worker 이름 |
|---|---|---|---|
| 학생 예약·시험·복습·과제 | https://yennie-booking.yenniesense.workers.dev | foreverynostalgia/yennie-booking | `yennie-booking` |
| 비공개 관리자(예니센스 클래스 매니저) | https://yennie-manager.yenniesense.workers.dev | foreverynostalgia/yennie-manager | `yennie-manager` |
| 예니센스 클라우드(공개 교사 서비스) | https://yennie-cloud.yenniesense.workers.dev | foreverynostalgia/yennie-cloud | `yennie-cloud` |

- Cloudflare 계정 ID `89c0b2aeeee241c1975ae8caa31a479f`, workers.dev 하위 도메인 `yenniesense`.
- 각 저장소의 `main`이 운영 코드다. `sites-main`은 ChatGPT Sites 시절 원본(관리자 v50, 학생 예약 v129+미배포 1커밋, 클라우드 v7), `sites-export`·`sites-moved-redirect`는 전환에 쓴 Sites용 패치 브랜치(기록 보존용).
- 옛 주소(`*.totoxoxo2.chatgpt.site`)는 Sites 마지막 배포(관리자 v51, 학생 예약 v131, 클라우드 v9)에서 모든 경로를 새 주소의 같은 경로로 302 이동한다. 옛 링크·OMR QR도 그대로 동작한다.

## 2. Cloudflare 리소스

| Worker | 바인딩 | 리소스 |
|---|---|---|
| yennie-booking | D1 `DB` | `yennie-booking` (`06f35184-ab06-4f20-850f-023f16a2b4f9`) |
| | R2 `LEARNING_FILES` | `yennie-booking-files` |
| yennie-manager | Service `BOOKING` | → `yennie-booking` (같은 계정 workers.dev끼리는 공개 주소로 호출 불가, 오류 1042) |
| | Cron | 매시 정각 `0 * * * *` 과제 촉구 웹푸시 |
| yennie-cloud | D1 `DB` | `yennie-cloud` (`eaf1baee-571c-42cf-bab4-2533fb5af6dc`) |
| | R2 `BUCKET` | `yennie-cloud-files` |

### 런타임 비밀값(이름만)

- **yennie-booking**: `ADMIN_USERNAME`, `ADMIN_PASSWORD`(소유자가 대시보드에서 입력), `SESSION_SECRET`, `MANAGER_SERVICE_KEY`, `VAPID_PRIVATE_JWK`, `VAPID_PUBLIC_KEY`, `VAPID_SUBJECT`. 선택: `ADMIN_SECONDARY_*`, `BOOTPAY_*`(알림톡), `UPSTAGE_API_KEY`(없으면 관리자 화면에서 등록한 OCR 키 사용).
- **yennie-manager**: `MANAGER_SERVICE_KEY`(예약과 같은 값), `ACCESS_TEAM_DOMAIN`(`winnerslabedu.cloudflareaccess.com`), `ACCESS_AUD`, `ACCESS_ALLOWED_EMAILS`.
- **yennie-cloud**: `TEACHER_SESSION_SECRET`, `STUDENT_PORTAL_SECRET`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `SUPERADMIN_EMAIL`(`foreverynostalgia@gmail.com`). 선택: `PRIVACY_CONTACT_EMAIL`.
- 모든 값은 **Secret**으로 둔다. 일반 변수(vars)는 `wrangler deploy` 때 덮어써져 사라진다.
- `SESSION_SECRET`을 바꾸면 학생 PIN 사본·캘린더 연결·OCR 키 같은 암호화 설정을 다시 등록해야 한다(로그인용 PIN 해시는 영향 없음). 코드는 풀 수 없는 설정을 "연결 안 됨"으로 처리한다.

## 3. 인증

- **관리자**: Cloudflare Access(Zero Trust 팀 `winnerslabedu`, 앱 "YENNIE SENSE 관리자", 로그인 방식 One-time PIN, 허용 이메일 `foreverynostalgia@gmail.com`). Worker도 Access JWT를 직접 검증하며 설정이 없으면 503으로 막는다. 팀 이름을 바꾸면 `ACCESS_TEAM_DOMAIN`도 바꿔야 한다. 허용 이메일 추가는 Access 정책과 `ACCESS_ALLOWED_EMAILS` 둘 다 고친다.
- **학생 예약 관리자 화면**: 예니센스 관리자의 하위 메뉴(예약 시스템)로만 쓴다. 관리자 사이트가 `MANAGER_SERVICE_KEY`로 세션을 받아 띄우므로 별도 로그인이 없다. 데이터 로드가 실패해도 로그인 대신 자동 재시도·‘다시 연결’을 보여 준다. 예약 사이트 `/admin`에 세션 없이 들어오면 `MANAGER_URL`(wrangler 설정의 일반 변수, 배포 때마다 설정 파일에서 다시 들어감)로 이동한다.
- **학생**: 닉네임 + PIN(`YE####`). PIN 사본은 첫 로그인 때 새 키로 자동 재암호화된다.
- **클라우드 교사**: Google 로그인(OIDC + PKCE). Google Cloud 프로젝트 "YENNIE SENSE", 리디렉션 URI `https://yennie-cloud.yenniesense.workers.dev/auth/google/callback`, 게시 상태 프로덕션(브랜드 인증 미진행, 기본 범위만 사용). Sites 시절 계정은 같은 이메일의 Google 계정으로 처음 로그인할 때 한 번 자동 연결된다(소유자 계정 `totoxoxo2@gmail.com`은 연결 완료). 개인정보처리방침 `/privacy`.

## 4. 외부 연동

- **구글 캘린더**: Apps Script 웹 앱(실행 사용자 "나", 액세스 "모든 사용자"). 수업 캘린더 4개 ID는 D1 `calendar_settings`(`google_course_calendar_*`)에 평문으로 있다. 코드 재생성 시 관리자 화면 예약 시스템 → 구글 캘린더 연동에서 코드 준비 → Apps Script 붙여넣기 → `authorizeCalendar` 실행 → 새 버전 배포 → URL 저장. 역방향 동기화는 `enableCalendarSync` 1회 실행. 여러 번 연달아 누르면 "Lock timeout"이 난다.
- **OCR**: 관리자 사이트 시험·자동 채점 → OCR 연결 설정에 Upstage 키.
- **웹푸시**: 2026-11-20 새 VAPID 키 발급. 옛 구독은 무효이므로 기기마다 다시 허용해야 한다.

## 5. 개발·배포

공통: Node 22 이상. 배포에는 Cloudflare API 토큰(Workers Scripts·D1·R2 편집, Account Settings 읽기, Access 앱·정책 편집, Access 조직·IdP 편집 권한)이 필요하다.

- **yennie-booking** (Vinext/Next, pnpm)
  ```
  pnpm install --frozen-lockfile
  for t in scripts/test-*.cjs; do node $t || break; done
  pnpm run build && node scripts/cloudflare-config.mjs
  npx wrangler deploy --config dist/server/wrangler.json
  ```
  `cloudflare-config.mjs`가 Sites용 빌드 결과를 Cloudflare 계정용으로 바꾸고, 정적 파일을 Worker 안에 넣는다(별도 assets 업로드 없이 토큰만으로 배포).
- **yennie-manager**
  ```
  npm test && npm run build:cloudflare && npm run test:cloudflare
  npx wrangler deploy --config dist/cloudflare/wrangler.json
  ```
  `scripts/build-cloudflare.mjs`가 Sites 빌드를 감싸 Access 검증, 예약 서비스 바인딩, 매시 Cron을 붙인다.
- **yennie-cloud**
  ```
  npm run build && npm test && node cloudflare-config.mjs
  npx wrangler deploy --config dist/server/wrangler.json
  ```
- D1 스키마 변경은 각 저장소 `drizzle/`에 SQL을 추가하고 `wrangler d1 execute <db> --remote --file`로 적용한다. 운영 데이터로 테스트하지 않는다.

## 6. 데이터 이전 기록 (2026-11-20)

- 학생 예약: D1 28개 테이블 412행(로그인 시도 기록 제외), R2 2개 파일 — 원본과 행 수·체크섬 일치.
- 클라우드: D1 8개 테이블 7행, R2 0개 — 일치.
- 관리자: 브라우저 저장소(`yensense-v1`)를 2026-11-20 오전 JSON 백업으로 복원. 학생 `s0`~`s5` 등은 처음 설치 시 예시 데이터.
- 백업 원본 묶음: `yennie-sense-backup-2026-11-20.tar.gz`(소유자 보관, 학생 개인정보 포함, 저장소에 넣지 않음).

## 7. 남은 일

- 웹푸시 알림 기기별 재허용(관리자·학생), 학생에게 새 주소 공지와 홈 화면 앱 아이콘 재추가 안내.
- 학생 예약 `sites-main`의 미배포 커밋 `3484c51`(과제 제출 갤러리 개선)은 운영에 반영되지 않았다. 필요하면 `main`에 다시 적용해 테스트 후 배포한다.
- 클라우드 미이식 기능: 고급 예약 옵션, OCR, 영상 시청 시간 자동 집계, 학생 과제 제출·웹푸시, 캘린더·알림톡.
- 자체 도메인을 쓰면 Google OAuth 리디렉션 URI, Access 앱 도메인, 관리자 빌드의 `BOOKING_ORIGIN`, Apps Script 코드를 함께 바꾼다.
- ChatGPT Sites 세 프로젝트는 이동 페이지로만 남아 있다. 삭제하면 옛 링크가 끊긴다.
