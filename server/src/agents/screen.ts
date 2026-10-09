/**
 * 화면 제어(Claude 컴퓨터 사용 도구 묶음 computer_toolset_20260801)의 서버 쪽 규칙.
 * 동작 요약 · 제한 시간 · 화면 잠금 · 스크린샷 보관처럼 상태가 적은 부분만 두어 경계값을 그대로 시험합니다.
 */
import fs from 'node:fs';
import path from 'node:path';

export const COMPUTER_TOOLSET = 'computer_toolset_20260801';
export const TOOLSET_NAME = 'computer';

/** 앞선 동작이 실패했을 때 같은 차례의 나머지 동작에 돌려주는 문구 (API 가 정한 문구 그대로) */
export const HALT_TEXT = 'Not executed: an earlier computer action in this turn failed.';

export const COMPUTER_ACTIONS: ReadonlySet<string> = new Set([
  'screenshot',
  'zoom',
  'left_click',
  'right_click',
  'middle_click',
  'double_click',
  'triple_click',
  'left_click_drag',
  'mouse_move',
  'left_mouse_down',
  'left_mouse_up',
  'cursor_position',
  'scroll',
  'type',
  'key',
  'hold_key',
  'wait',
]);

/** 화면에 보이는 스크린샷 기록을 에이전트마다 이만큼 남깁니다 */
export const SCREENS_KEEP = 200;

const LABEL: Record<string, string> = {
  left_click: '클릭',
  right_click: '오른쪽 클릭',
  middle_click: '가운데 클릭',
  double_click: '더블 클릭',
  triple_click: '세 번 클릭',
};
const SCROLL: Record<string, string> = { up: '위', down: '아래', left: '왼쪽', right: '오른쪽' };

function xy(v: unknown): string {
  return Array.isArray(v) && v.length === 2 && v.every((n) => typeof n === 'number') ? `(${v[0]}, ${v[1]})` : '';
}

function clipText(s: string, max: number): string {
  const flat = s.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

/** 타임라인 · 승인 카드에 보일 한 줄 요약 */
export function screenSummary(action: string, input: Record<string, unknown>): string {
  const text = typeof input['text'] === 'string' ? input['text'] : '';
  const mods = text ? ` + ${text}` : '';
  switch (action) {
    case 'screenshot':
      return '화면 보기';
    case 'zoom':
      return Array.isArray(input['region']) ? `확대해서 보기 [${(input['region'] as unknown[]).join(', ')}]` : '확대해서 보기';
    case 'left_click':
    case 'right_click':
    case 'middle_click':
    case 'double_click':
    case 'triple_click':
      return `${LABEL[action]} ${xy(input['coordinate']) || '(지금 위치)'}${mods}`.trim();
    case 'left_click_drag':
      return `끌기 ${xy(input['start_coordinate'])} → ${xy(input['coordinate'])}${mods}`;
    case 'mouse_move':
      return `마우스 이동 ${xy(input['coordinate'])}`;
    case 'left_mouse_down':
      return '왼쪽 버튼 누름';
    case 'left_mouse_up':
      return '왼쪽 버튼 뗌';
    case 'cursor_position':
      return '마우스 위치 확인';
    case 'scroll': {
      const dir = SCROLL[String(input['scroll_direction'])] ?? String(input['scroll_direction'] ?? '');
      const at = xy(input['coordinate']);
      return `스크롤 ${dir} ${typeof input['scroll_amount'] === 'number' ? input['scroll_amount'] : 3}${at ? ` ${at}` : ''}${mods}`;
    }
    case 'type':
      return `입력 "${clipText(text, 40)}"`;
    case 'key':
      return `키 ${text}${typeof input['repeat'] === 'number' && input['repeat'] > 1 ? ` ×${input['repeat']}` : ''}`;
    case 'hold_key':
      return `키 누르고 있기 ${text} ${typeof input['duration'] === 'number' ? `${input['duration']}초` : ''}`.trim();
    case 'wait':
      return `기다리기 ${typeof input['duration'] === 'number' ? `${input['duration']}초` : ''}`.trim();
    default:
      return action;
  }
}

/** 훅 · 기본 금지 조항이 검사할 글자 (입력하는 글자, 누르는 키) */
export function typedText(action: string, input: Record<string, unknown>): string | null {
  if (action === 'type' || action === 'key' || action === 'hold_key') return typeof input['text'] === 'string' ? input['text'] : null;
  return null;
}

const BASE_TIMEOUT_MS = 30_000;

/** 동작 하나의 제한 시간: 기다리기 · 키 누르고 있기는 그 시간만큼, 긴 글자 입력은 글자 수만큼 늘립니다. */
export function screenTimeoutMs(action: string, input: Record<string, unknown>): number {
  const d = typeof input['duration'] === 'number' && Number.isFinite(input['duration']) ? Math.max(0, Math.min(300, input['duration'])) : 0;
  if (action === 'wait' || action === 'hold_key') return BASE_TIMEOUT_MS + d * 1000;
  if (action === 'type' && typeof input['text'] === 'string') return BASE_TIMEOUT_MS + Math.min(input['text'].length, 10_000) * 30;
  return BASE_TIMEOUT_MS;
}

export interface ScreenHolder {
  taskId: string;
  agentId: string;
  agentName: string;
  since: number;
}

/** 화면 하나는 한 번에 한 작업만 씁니다. 작업이 끝나면 풀립니다. */
export class ScreenLocks {
  private readonly held = new Map<string, ScreenHolder>();

  acquire(moduleId: string, owner: Omit<ScreenHolder, 'since'>, now = Date.now()): { ok: true } | { ok: false; holder: ScreenHolder } {
    const cur = this.held.get(moduleId);
    if (cur && cur.taskId !== owner.taskId) return { ok: false, holder: cur };
    if (!cur) this.held.set(moduleId, { ...owner, since: now });
    return { ok: true };
  }

  /** 작업이 끝날 때: 그 작업이 잡고 있던 화면을 모두 풉니다. 푼 모듈 id 목록을 돌려줍니다. */
  releaseTask(taskId: string): string[] {
    const out: string[] = [];
    for (const [moduleId, h] of this.held) {
      if (h.taskId === taskId) {
        this.held.delete(moduleId);
        out.push(moduleId);
      }
    }
    return out;
  }

  holder(moduleId: string): ScreenHolder | null {
    return this.held.get(moduleId) ?? null;
  }
}

/** /api/screens 로 돌려줄 수 있는 파일 이름 */
export const SCREEN_FILE_RE = /^[A-Za-z0-9_-]{1,80}\.(?:jpg|png)$/;
export const SCREEN_AGENT_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** 스크린샷을 에이전트 폴더에 저장하고, 오래된 것부터 지워 keep 개만 남깁니다. 화면에서 쓸 상대 경로를 돌려줍니다. */
export function saveScreenshot(rootDir: string, agentId: string, taskId: string, image: { data: string; mediaType: string }, now = Date.now(), keep = SCREENS_KEEP): string {
  if (!SCREEN_AGENT_RE.test(agentId)) throw new Error(`스크린샷을 저장할 에이전트 id 가 올바르지 않습니다: ${agentId}`);
  const dir = path.join(rootDir, agentId);
  fs.mkdirSync(dir, { recursive: true });
  const ext = image.mediaType === 'image/png' ? 'png' : 'jpg';
  const safeTask = taskId.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40) || 'task';
  let name = `${now}-${safeTask}.${ext}`;
  for (let n = 1; fs.existsSync(path.join(dir, name)); n += 1) name = `${now}-${safeTask}-${n}.${ext}`;
  fs.writeFileSync(path.join(dir, name), Buffer.from(image.data, 'base64'));
  // 파일 이름이 시각으로 시작하므로 이름순 = 시간순입니다.
  const files = fs.readdirSync(dir).filter((f) => SCREEN_FILE_RE.test(f)).sort();
  for (const f of files.slice(0, Math.max(0, files.length - keep))) fs.rmSync(path.join(dir, f), { force: true });
  return `${agentId}/${name}`;
}
