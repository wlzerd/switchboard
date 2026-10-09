# Switchboard

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

24시간 돌아가는 Claude 에이전트 서버입니다. 에이전트 · 모듈 · 스킬이 어떻게 이어져 있고 지금 무엇을 하는지 카드와 선으로 한눈에 보고,
권한과 훅으로 안전하게 운영합니다.

- **에이전트 여러 명** — 같은 모델로 여러 에이전트를 두고 각각 이름 · 색 · 역할을 정합니다.
- **모델은 고르기만** — API 키를 확인하면 그 키로 쓸 수 있는 모델 목록이 나옵니다. 모델 이름을 직접 입력하지 않습니다.
- **캔버스** — 모듈 → 에이전트 → 스킬 연결, 메시지와 스킬 호출 흐름, 에이전트가 새로 만든 스킬을 실시간으로 보여 줍니다.
- **콘솔** — 지시, 실시간 답변, 도구 호출 카드, 승인 요청, 새 스킬 카드.
- **모듈** — Discord · Telegram 기본 제공. Git · zip · 템플릿으로 설치하거나 에이전트에게 만들어 달라고 요청합니다. 설치 전 정적 검사와 라이선스 점검을 거칩니다.
- **권한 · 훅** — 항목별 허용 / 확인 / 차단과 허용 범위, 끌 수 없는 기본 금지 조항 10개, 화면에서 만드는 규칙 훅, 파일로 쓰는 코드 훅.
- **테마** — 기본 테마 5개, 색 토큰 편집과 대비 검사, JSON 가져오기 · 내보내기.

## 빠른 시작

필요한 것: Node.js 22.18 이상 (TypeScript 직접 실행 · node:sqlite · 권한 모델), git (Git 저장소에서 모듈을 설치할 때)

```bash
git clone <저장소 주소> switchboard
cd switchboard
npm install
cp .env.example .env
```

`.env` 에서 아래 세 값은 꼭 채웁니다. 비어 있거나 형식이 틀리면 서버가 어떤 값이 왜 잘못됐는지 알려 주고 멈춥니다.

| 변수 | 값 |
|---|---|
| `ADMIN_PASSWORD` | 관리자 비밀번호 (12자 이상) |
| `SESSION_SECRET` | `openssl rand -hex 32` 결과 (32자 이상) |
| `SECRETS_KEY` | `openssl rand -base64 32` 결과 (화면에서 입력한 API 키를 암호화) |
| `ANTHROPIC_API_KEY` | 선택. 넣어 두면 에이전트를 만들 때 ".env 기본 키"로 고를 수 있습니다 |

실행:

```bash
npm run build
npm start
```

브라우저에서 `http://<서버 주소>:8787` 을 열고 관리자 비밀번호로 로그인합니다.

개발 모드 (서버 자동 재시작 + 화면 즉시 반영, 화면은 `http://localhost:5173`):

```bash
npm run dev
```

## 어디서든 접속하기

서버는 로그인이 필요하지만, 인터넷에 열 때는 **반드시 HTTPS** 뒤에 둡니다. 셋 중 하나를 고르세요.

**Cloudflare Tunnel** — 포트를 열지 않고 공개 주소를 받습니다.

```bash
cloudflared tunnel --url http://localhost:8787
```

**Tailscale** — 내 기기들끼리만 접속합니다. 서버와 휴대폰에 Tailscale 을 켜고 `http://<tailnet 이름>:8787` 로 접속합니다.
HTTPS 가 필요하면 `tailscale serve --bg 8787` 을 씁니다.

**리버스 프록시 (Caddy)** — 도메인이 있을 때. 인증서는 Caddy 가 자동으로 받습니다.

```
agents.example.com {
    reverse_proxy 127.0.0.1:8787
}
```

프록시나 터널 뒤에서 실행할 때는 `.env` 를 이렇게 바꿉니다.

```
HOST=127.0.0.1                         # 프록시만 서버에 붙도록
PUBLIC_URL=https://agents.example.com  # 쿠키에 Secure 가 붙습니다
TRUST_PROXY=true                       # 로그인 제한이 실제 접속 IP 로 동작하도록
```

실시간 화면은 WebSocket(`/api/ws`)을 씁니다. Caddy · Cloudflare Tunnel 은 그대로 되고, Nginx 는 `Upgrade` 헤더를 넘겨야 합니다.

```nginx
location / {
    proxy_pass http://127.0.0.1:8787;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
}
```

## 24시간 실행

서버가 꺼지거나 컴퓨터가 다시 켜져도 돌아오도록 서비스로 등록합니다 (Linux systemd 예시).

```ini
# /etc/systemd/system/switchboard.service
[Unit]
Description=Switchboard
After=network-online.target
Wants=network-online.target

[Service]
WorkingDirectory=/opt/switchboard
ExecStart=/usr/bin/node server/dist/index.js
Restart=always
RestartSec=5
User=switchboard
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable --now switchboard
```

서버는 종료 신호를 받으면 진행 중인 작업을 정리하고 모듈 프로세스를 내린 뒤 끝납니다. 모듈 프로세스가 비정상 종료되면 다시 띄우고,
짧은 시간에 반복되면 멈추고 이유를 모듈 화면에 보여 줍니다 (`MODULE_RESTART_MAX`, `MODULE_RESTART_WINDOW_MINUTES`).

## 설정

모든 설정은 `.env` 에 있고 `.env.example` 에 기본값과 설명이 있습니다. 코드에 하드코딩된 주소 · 키 · 포트는 없습니다.
`.env` 와 `data/` 는 `.gitignore` 에 들어 있어 커밋되지 않습니다.

| 묶음 | 주요 변수 |
|---|---|
| 서버 | `HOST` `PORT` `PUBLIC_URL` `TRUST_PROXY` `TZ` `LOG_LEVEL` |
| 로그인 | `ADMIN_PASSWORD` `SESSION_SECRET` `SESSION_TTL_HOURS` `LOGIN_MAX_ATTEMPTS` `LOGIN_LOCK_MINUTES` |
| 저장소 | `DATA_DIR` `SECRETS_KEY` |
| Anthropic | `ANTHROPIC_API_KEY` `ANTHROPIC_BASE_URL` `AGENT_MAX_TOKENS` `AGENT_COMPACTION` `ANTHROPIC_REFUSAL_FALLBACK` |
| 실행 | `AGENT_MAX_CONCURRENCY` `APPROVAL_TIMEOUT_MINUTES` `SHELL_TIMEOUT_MS` `HTTP_TOOL_TIMEOUT_MS` |
| 모듈 | `MODULE_SANDBOX` `MODULE_CALL_TIMEOUT_MS` `MODULE_IDLE_TIMEOUT_MS` `GIT_BIN` |
| 기본 모듈 | `DISCORD_BOT_TOKEN` `TELEGRAM_BOT_TOKEN` |
| 기본 금지 조항 | `GUARD_FLOOD_PER_MINUTE` `GUARD_LOOP_REPEAT` |

권한 프리셋은 `config/presets.json`, 기본 금지 조항의 목록(금융 API 도메인, 비밀 파일 이름 등)은 `config/guards.json`,
기본 테마는 `config/themes.json` 에서 바꿀 수 있습니다.

## 구조

```
server/     Fastify API · SQLite(node:sqlite) · 에이전트 실행 · 모듈 호스트 · 훅 엔진
web/        React 화면 (캔버스는 React Flow)
modules/    기본 모듈 (discord, telegram)
templates/  모듈 템플릿 (blank, webhook, watch)
config/     권한 프리셋 · 기본 금지 조항 목록 · 테마
docs/       모듈 제작 가이드 · 서드파티 라이선스
scripts/    개발 실행 · 라이선스 점검
```

```
 채널 모듈 ──메시지──▶ 에이전트 ──도구 호출──▶ 내장 도구 · 모듈 도구 · 스킬
 (Discord 등)           │  ▲                       │
                        │  └── 훅 · 권한 · 승인 ◀───┘
                        ▼
                  Claude Messages API (스트리밍, 적응형 사고, 서버 측 요약)
```

- 에이전트마다 작업 대기열이 있고, 같은 대화는 순서대로, 서로 다른 대화는 동시에 처리합니다 (`AGENT_MAX_CONCURRENCY` 안에서).
- 모델 기능(노력 수준, 적응형 사고, 서버 측 요약, 웹 검색)은 모델 목록 API 가 알려 주는 대로 켭니다.
- 대화 기록과 작업 단계는 `DATA_DIR` 의 SQLite 에 저장되어 서버를 다시 켜도 남습니다.

## 안전 장치

**권한** — 에이전트마다 항목별로 정합니다.

| 모드 | 동작 |
|---|---|
| 허용 | 허용 범위(경로 · 명령 · 도메인 · 대상 패턴)가 비어 있으면 전부, 있으면 범위 안만 허용. 범위 밖은 확인으로 넘어감 |
| 확인 | 실행 전에 승인을 요청. "항상 허용"을 누른 대상은 다음부터 묻지 않음 |
| 차단 | 실행하지 않음 |

비밀 파일 읽기와 자기 권한 · 훅 변경은 잠긴 항목이라 항상 차단입니다. 일일 토큰 · 작업당 단계 · 동시 작업 · 분당 메시지 한도도 에이전트마다 정합니다.

**기본 금지 조항** (끌 수 없음): 비밀값 유출, 비밀 파일 접근, 위험 명령, 권한 상승, 작업 폴더 탈출, 자기 권한 · 훅 변경,
하드코딩된 비밀값 설치, 금융 거래, 대량 발송, 무한 반복.

**규칙 훅** — 권한 · 훅 화면에서 만듭니다. 이벤트(도구 실행 전 · 후, 메시지 보내기 전, 메시지 받을 때, 모듈 설치 전),
조건(같음 · 포함 · 정규식 · 시간대 …), 동작(차단 · 확인 · 수정 · 기록)과 문구를 고르고, 예시 입력으로 바로 시험합니다.
조건 값에 `$env:이름` 을 쓰면 `.env` 의 값을 참조합니다 (예: `$env:QUIET_HOURS`).

**코드 훅** — `DATA_DIR/hooks/*.mjs` 에 직접 씁니다. 규칙 훅의 "코드 보기"를 그대로 저장해도 같은 동작을 합니다.

```js
// DATA_DIR/hooks/quiet-shell.mjs
export default {
  name: '야간 셸 명령 확인',
  on: 'before_tool',
  action: 'ask',
  when: (ctx, h) => h.field('category') === 'shell.exec' && h.inWindow(h.env('QUIET_HOURS')),
  reason: '업무 시간 외 셸 명령({command})은 승인이 필요합니다',
};
```

`h.field(이름)` · `h.env(이름)` · `h.inWindow('HH:MM-HH:MM')` · `h.matches(이름, 정규식)` · `h.clock()` 을 쓸 수 있고,
`reason` 문자열의 `{필드}` 는 실제 값으로 바뀝니다. 파일을 고친 뒤 권한 · 훅 화면에서 "코드 훅 다시 읽기"를 누릅니다.
평가 순서는 기본 금지 조항 → 규칙 훅 → 코드 훅이며, 하나라도 차단하면 즉시 차단합니다.

**모듈 격리** — 모듈마다 별도 프로세스로 실행합니다.

- 모듈이 module.json 에 선언한 환경 변수만 전달합니다 (Anthropic 키 같은 서버 비밀값은 없음).
- Node 권한 모델로 파일 읽기는 모듈 폴더와 데이터 폴더, 쓰기는 데이터 폴더만 허용하고 하위 프로세스는 선언했을 때만 허용합니다.
- 외부 접속은 선언한 도메인만 됩니다. 서버 쪽 HTTP 도구는 사설 IP 와 리다이렉트를 다시 검사합니다.
- 설치 전에 정적 검사(eval, new Function, 선언하지 않은 child_process), 라이선스, 의존성 라이선스, 도구 이름 충돌을 점검합니다.

**키와 로그인** — 화면에서 입력한 API 키는 AES-256-GCM 으로 암호화해 저장하고, 화면에는 끝 4자리만 보입니다.
세션 쿠키는 서명된 HttpOnly · SameSite=Strict 쿠키이고, 로그인 실패가 반복되면 잠깁니다.

## 모듈

**Discord** — [개발자 포털](https://discord.com/developers/applications)에서 봇을 만들고 Bot 페이지에서
**MESSAGE CONTENT INTENT** 를 켭니다. 토큰을 `.env` 의 `DISCORD_BOT_TOKEN` 에 넣고, 모듈 화면에서 Discord 를 켠 뒤
에이전트에 연결합니다. 대상은 `#채널이름`, 채널 id, `dm:<사용자 id>` 로 지정합니다.

**Telegram** — @BotFather 에서 봇을 만들어 토큰을 `TELEGRAM_BOT_TOKEN` 에 넣습니다. 대상은 대화(chat) id 입니다.

`.env` 를 고친 뒤에는 모듈 카드의 ".env 다시 읽기"로 서버를 다시 켜지 않고 반영할 수 있습니다.

**모듈 추가** — 모듈 화면의 "모듈 추가"에서 Git 저장소, zip 파일, 템플릿을 고르거나 에이전트에게 만들어 달라고 요청합니다.
에이전트가 만든 모듈은 사용자가 코드와 점검 결과를 보고 승인해야 설치됩니다.

모듈을 직접 만들거나 에이전트가 만들 때의 규칙은 [docs/MODULE_GUIDE.md](docs/MODULE_GUIDE.md) 에 있습니다.
이 문서는 에이전트의 시스템 프롬프트에도 들어갑니다.

## 테스트

```bash
npm test
npm run typecheck
```

테스트는 통과를 위한 확인이 아니라 버그를 찾기 위한 것입니다. 분기마다 경계값(한도의 최솟값 − 1 · 최솟값 · 최댓값 · 최댓값 + 1,
자정을 넘는 시간대, 빈 값, 이스케이프된 문자 등)을 넣고, 모듈 격리는 실제 프로세스를 띄워 확인합니다.

## 라이선스

[MIT](LICENSE) 라이선스로 공개한 오픈소스입니다. 개인 · 회사 · 상업 목적 모두 자유롭게 쓰고, 고치고, 재배포할 수 있습니다.
재배포할 때는 저작권 표시와 라이선스 문구를 함께 포함하면 됩니다.

### 사용한 오픈소스

```bash
npm run licenses              # 배포 의존성의 라이선스 점검 (카피레프트 · 확인 불가가 있으면 실패)
npm run licenses -- --write   # docs/THIRD_PARTY_LICENSES.md 다시 만들기
```

사용한 오픈소스의 이름 · 버전 · 라이선스 · 출처는 [docs/THIRD_PARTY_LICENSES.md](docs/THIRD_PARTY_LICENSES.md) 에 있습니다.
글꼴(IBM Plex Sans KR, Noto Sans KR, JetBrains Mono)은 SIL Open Font License 1.1 이고, 캔버스는 React Flow(MIT)를 씁니다.
