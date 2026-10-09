# Switchboard

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

24시간 돌아가는 Claude 에이전트 서버입니다. 에이전트 · 모듈 · 스킬이 어떻게 이어져 있고 지금 무엇을 하는지 카드와 선으로 한눈에 보고,
권한과 훅으로 안전하게 운영합니다.

- **에이전트 여러 명** — 같은 모델로 여러 에이전트를 두고 각각 이름 · 색 · 역할을 정합니다.
- **모델은 고르기만** — API 키를 확인하면 그 키로 쓸 수 있는 모델 목록이 나옵니다. 모델 이름을 직접 입력하지 않습니다.
- **캔버스** — 모듈 → 에이전트 → 스킬 연결, 메시지와 스킬 호출 흐름, 에이전트가 새로 만든 스킬을 실시간으로 보여 줍니다.
- **콘솔** — 지시, 실시간 답변, 도구 호출 카드, 승인 요청, 새 스킬 카드.
- **모듈** — Discord · Telegram · 이메일 기본 제공. Git · zip · 템플릿으로 설치하거나 에이전트에게 만들어 달라고 요청합니다. 설치 전 정적 검사와 라이선스 점검을 거칩니다.
- **스스로 일하기** — 하트비트(정해진 간격으로 스스로 점검)와 모듈 자동 알림(새 메일 등)은 알릴 것이 있을 때만 보고하고, 없으면 아무 흔적도 남기지 않습니다.
- **위임** — 에이전트끼리 일을 맡기고 결과를 돌려받습니다. 권한이 없어 막힌 요청은 상위 에이전트에게 넘길 수 있습니다.
- **허용 폴더** — 작업 폴더 밖에서 에이전트가 쓸 폴더를 사용자가 정합니다 (읽기만 / 읽기·쓰기). 하트비트 · 예약 실행으로 주기적으로 관리하게 할 수 있습니다.
- **화면 제어** — 에이전트가 이 컴퓨터의 화면을 보고 마우스 · 키보드로 조작합니다 (기본 꺼짐, macOS · Linux X11).
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
| 스스로 일하기 | `HEARTBEAT_MIN_MINUTES` `DELEGATION_MAX_DEPTH` |
| 모듈 | `MODULE_SANDBOX` `MODULE_CALL_TIMEOUT_MS` `MODULE_IDLE_TIMEOUT_MS` `GIT_BIN` |
| 기본 모듈 | `DISCORD_BOT_TOKEN` `TELEGRAM_BOT_TOKEN` `EMAIL_IMAP_HOST` `EMAIL_USER` `EMAIL_PASSWORD` `EMAIL_MAILBOX` `COMPUTER_MAX_EDGE` `DISPLAY` |
| 기본 금지 조항 | `GUARD_FLOOD_PER_MINUTE` `GUARD_LOOP_REPEAT` |

권한 프리셋은 `config/presets.json`, 기본 금지 조항의 목록(금융 API 도메인, 비밀 파일 이름 등)은 `config/guards.json`,
기본 테마는 `config/themes.json` 에서 바꿀 수 있습니다.

## 구조

```
server/     Fastify API · SQLite(node:sqlite) · 에이전트 실행 · 모듈 호스트 · 훅 엔진
web/        React 화면 (캔버스는 React Flow)
modules/    기본 모듈 (discord, telegram, email, computer)
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
- 모듈의 `fetch` 는 선언한 도메인만 접속됩니다. `net` · `tls` 같은 저수준 소켓은 Node 권한 모델이 막지 않으므로 정적 검사에서 경고로 보여 줍니다
  (기본 이메일 모듈은 IMAP 서버 주소를 `.env` 로 정하므로 "모든 주소"를 선언합니다). 서버 쪽 HTTP 도구는 사설 IP 와 리다이렉트를 다시 검사합니다.
- 설치 전에 정적 검사(eval, new Function, 선언하지 않은 child_process), 라이선스, 의존성 라이선스, 도구 이름 충돌을 점검합니다.

**허용 폴더의 한계** — 허용 폴더는 사용자가 권한 · 훅 화면에서만 정하고, 에이전트에게는 바꾸는 도구가 없습니다.
홈 폴더 전체 · 디스크 전체 · 운영체제 폴더 · Switchboard 설치 폴더와 데이터 폴더 · 비밀 폴더(.ssh 등) · macOS 키체인은 허용할 수 없습니다.
경로는 심볼릭 링크를 따라간 실제 위치로 검사하므로 링크로 밖을 가리켜도 막힙니다. 셸 명령은 읽기·쓰기 폴더에서만 쓸 수 있습니다
(어떤 파일을 바꿀지 미리 알 수 없어서). 셸의 `~` 와 `$HOME` 은 작업 폴더를 뜻하며, 다른 사용자의 홈(`~이름`)은 막습니다.

**화면 제어의 한계** — 화면 제어 권한은 기본이 "확인"이라 작업마다 처음 한 번 승인을 받습니다 (그 작업이 끝나면 다시 물음).
하트비트 같은 조용한 작업에서는 화면을 제어하지 않고, 화면 하나는 한 번에 한 작업만 씁니다. 카드 번호처럼 보이는 숫자는 입력하지 않으며
(기본 금지 조항 · 금융 거래), 에이전트는 화면 제어 모듈을 직접 만들 수 없습니다. 마우스를 화면 왼쪽 위 모서리로 옮기면 바로 멈춥니다.

**위임의 한계** — 위임을 받은 에이전트에게는 그 에이전트 자신의 권한 · 훅 · 승인 절차가 그대로 적용됩니다.
권한 설정으로 막혔을 때만 상위 에이전트에게 넘기라고 안내하고, 기본 금지 조항 · 훅 차단 · 사용자의 거부는 넘겨서 우회할 수 없습니다.
순환 위임(맡겨 온 쪽으로 되돌려 맡기기)과 `DELEGATION_MAX_DEPTH` 를 넘는 위임은 거절합니다.

**키와 로그인** — 화면에서 입력한 API 키는 AES-256-GCM 으로 암호화해 저장하고, 화면에는 끝 4자리만 보입니다.
세션 쿠키는 서명된 HttpOnly · SameSite=Strict 쿠키이고, 로그인 실패가 반복되면 잠깁니다.

## 스스로 일하기

**조용한 판단** — 하트비트와 모듈 자동 알림(새 메일 등)은 조용한 작업으로 돕니다. 에이전트가 "점검 · 알릴 조건"에 비춰
알릴 것이 없다고 판단하면(`NO_REPORT`) 작업 · 대화 기록 · 화면 · 채널 어디에도 남지 않습니다. 알릴 것이 있을 때만 콘솔에
보고 카드와 알림이 생기고, "보고 받을 곳"(Discord · Telegram 채널)으로 보냅니다. 조용한 작업 중에는 승인이 필요한 동작을
하지 않습니다 (사용자가 자리에 없을 때 승인을 기다리며 멈추지 않도록, 필요하면 보고에 적습니다). 같은 오류가 되풀이되면 처음 한 번만 보입니다.

**하트비트** — 콘솔 오른쪽 패널에서 켜고 간격 · 활동 시간 · 점검 · 알릴 조건 · 보고 받을 곳을 정합니다. "지금 확인"으로 바로 한 번 돌려 볼 수 있습니다.
대화에서 "이 페이지 바뀌면 알려줘"처럼 부탁하면 에이전트가 `heartbeat_set` 도구로 직접 등록합니다 (권한 "하트비트 설정").
메일처럼 모듈이 새 소식을 보내 주는 일은 주기 점검 없이 알릴 조건만 적어 둡니다.

**위임** — 에이전트를 만들 때(또는 권한 · 훅 화면에서) 정합니다.

| 설정 | 허용 | 미허용 |
|---|---|---|
| 위임 받기 | 다른 에이전트가 맡기는 일을 받아 처리하고 결과를 돌려줌 | 맡길 수 없음 |
| 위임 요청 보내기 | `delegate_task` 로 다른 에이전트에게 일을 맡김 | 도구가 주어지지 않음 |
| 상위 에이전트 | 권한이 없어 막힌 요청을 이 에이전트에게 넘길 수 있음 (보내기 허용 필요) | — |

맡긴 일은 따로 돌고, 끝나는 대로 결과가 원래 대화로 돌아와 이어서 마무리합니다. 캔버스에서 상위 관계는 점선,
진행 중인 위임은 움직이는 선으로 보입니다.

## 허용 폴더

에이전트는 기본으로 자기 작업 폴더(`DATA_DIR/workspaces/<에이전트 id>`)만 씁니다. 다른 폴더에서 일하게 하려면 권한 · 훅 화면의
"허용 폴더"에 서버 컴퓨터의 폴더 경로(`~/Documents/보고서` 처럼)를 넣고 범위를 고릅니다.

| 범위 | 파일 읽기 · 목록 | 파일 쓰기 | 셸 명령 |
|---|---|---|---|
| 읽기만 | 됨 | 안 됨 | 안 됨 |
| 읽기·쓰기 | 됨 | 됨 | 됨 (`cwd` 로 그 폴더에서 실행) |

겹치는 폴더는 더 깊은 쪽 설정을 따릅니다 (예: `~/Documents` 읽기만 + `~/Documents/보고서` 읽기·쓰기). 파일 쓰기 · 셸 명령 권한의
허용 범위에는 `~/Documents/보고서/**` 처럼 화면에 보이는 경로 그대로 쓸 수 있습니다. 주기적으로 정리하게 하려면 하트비트의
점검 · 알릴 조건이나 예약 실행에 할 일을 적습니다. 하트비트는 승인을 물을 수 없으므로 정리까지 맡기려면 파일 쓰기 권한을 "허용"으로 둡니다.

## 화면 제어

기본 제공 "화면 제어" 모듈은 처음에 꺼져 있습니다. 모듈 화면에서 켜고 에이전트에 연결하면, 그 에이전트가 Claude 의 컴퓨터 사용 도구
(`computer_toolset_20260801`, Claude 5 계열 · Opus 4.8)로 화면을 보고 마우스 · 키보드를 씁니다. 콘솔에는 동작 목록과 에이전트가 마지막으로 본
화면이 카드로 남고, 스크린샷은 `DATA_DIR/screens` 에 에이전트마다 최근 200장까지 보관합니다.

- **macOS** — 기본 제공 프로그램(screencapture · sips · osascript)을 씁니다. 시스템 설정 > 개인정보 보호 및 보안에서 Switchboard 를 실행한 앱
  (터미널 · iTerm 등)에 **손쉬운 사용**과 **화면 및 시스템 오디오 녹화**를 허용한 뒤 모듈을 다시 시작합니다. 글자 입력은 한글 자판 같은 입력기의
  영향을 받지 않도록 붙여넣기로 하고, 입력 뒤 원래 클립보드 글자를 되돌립니다.
- **Linux (X11)** — `xdotool` 과 ImageMagick(`import`)이 필요합니다 (`sudo apt install xdotool imagemagick`). 화면이 없는 서버는 가상 화면을 띄우고
  (`Xvfb :99 -screen 0 1280x800x24 &`) `.env` 에 `DISPLAY=:99` 를 넣습니다. Wayland 세션은 지원하지 않습니다.

Anthropic 은 컴퓨터 사용을 최소 권한의 전용 가상 머신이나 컨테이너에서 쓰기를 권합니다. 내 컴퓨터의 실제 화면을 맡길 때는 로그인된 계정 ·
결제 수단이 열린 창을 닫아 두고, 작업이 도는 동안 화면을 지켜보세요.

## 모듈

**Discord** — [개발자 포털](https://discord.com/developers/applications)에서 봇을 만들고 Bot 페이지에서
**MESSAGE CONTENT INTENT** 를 켭니다. 토큰을 `.env` 의 `DISCORD_BOT_TOKEN` 에 넣고, 모듈 화면에서 Discord 를 켠 뒤
에이전트에 연결합니다. 대상은 `#채널이름`, 채널 id, `dm:<사용자 id>` 로 지정합니다.

**Telegram** — @BotFather 에서 봇을 만들어 토큰을 `TELEGRAM_BOT_TOKEN` 에 넣습니다. 대상은 대화(chat) id 입니다.

**이메일** (받기 전용) — `EMAIL_IMAP_HOST` · `EMAIL_USER` · `EMAIL_PASSWORD` 를 넣고 에이전트에 연결합니다. Gmail 은 계정 비밀번호가 아니라
2단계 인증 후 만든 앱 비밀번호를 넣어야 하고, 네이버 · 다음은 메일 환경설정에서 IMAP 사용을 켜야 합니다. Outlook.com · Microsoft 365 는
비밀번호 IMAP 로그인을 받지 않아 쓸 수 없습니다. 편지함은 읽기 전용으로 열고 본문은 미리보기로만 가져오므로 메일이 읽음으로 바뀌지 않습니다.
처음 켤 때 이미 있던 메일은 건너뛰고, 그 뒤로 오는 메일만(꺼져 있던 동안 온 메일 포함) 모아서 알립니다.
에이전트는 `email_search` · `email_read` 로 메일을 찾고 읽을 수 있습니다.

예) 에이전트에 이메일과 Telegram 을 연결하고, Telegram 대화에서 "결제 · 계약 · 장애 관련 메일이 오면 알려줘"라고 하면
에이전트가 알릴 조건을 저장하고 그 Telegram 대화를 보고 받을 곳으로 정합니다 (웹 콘솔에서 부탁했다면 보고 받을 곳은 콘솔 패널에서 고릅니다).
그 뒤 새 메일이 올 때마다 조용히 판단해서, 조건에 맞는 메일이 있을 때만 보고합니다.

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
