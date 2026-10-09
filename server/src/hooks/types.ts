import type { AllowedFolder } from '../permissions/folders.ts';

export type HookEvent = 'before_tool' | 'after_tool' | 'before_send' | 'on_message' | 'before_install';

export const HOOK_EVENTS: readonly HookEvent[] = ['before_tool', 'after_tool', 'before_send', 'on_message', 'before_install'];

interface BaseCtx {
  agentId: string | null;
  agentName: string | null;
  taskId: string | null;
  now: Date;
}

/** 도구 호출. 실행 전(before_tool)과 후(after_tool)에 같은 형태로 쓰입니다. */
export interface ToolCtx extends BaseCtx {
  event: 'before_tool' | 'after_tool';
  tool: string;
  /** 권한 키(fs.read, shell.exec, net.fetch …) 또는 module:<id>, skill:<id> */
  category: string;
  input: Record<string, unknown>;
  workspace: string;
  /** 셸 명령이 도는 폴더 (없으면 작업 폴더) */
  cwd?: string;
  /** 사용자가 허락한 작업 폴더 밖 폴더 (없으면 작업 폴더만) */
  folders?: readonly AllowedFolder[];
  /** 서버 계정의 홈 (경로 표시용, 없으면 os.homedir()) */
  home?: string;
  command: string | null;
  /** 도구가 건드리는 파일들의 절대 경로 (심볼릭 링크를 푼 값) */
  paths: string[];
  url: string | null;
  host: string | null;
  method: string | null;
  /** 밖으로 나가는 내용 (HTTP 본문, 모듈 도구 입력 등) */
  text: string | null;
  /** after_tool 에서만: 도구 결과 */
  output?: string;
}

export interface SendCtx extends BaseCtx {
  event: 'before_send';
  channel: string;
  target: string;
  text: string;
  /** 에이전트의 분당 메시지 한도 */
  perMinute: number;
}

export interface MessageCtx extends BaseCtx {
  event: 'on_message';
  channel: string;
  target: string;
  user: string;
  text: string;
}

export interface InstallFile {
  path: string;
  content: string;
}

export interface InstallCtx extends BaseCtx {
  event: 'before_install';
  kind: 'module' | 'skill';
  id: string;
  files: InstallFile[];
}

export type HookCtx = ToolCtx | SendCtx | MessageCtx | InstallCtx;

export type HookAction = 'deny' | 'ask' | 'modify' | 'log';

export interface HookOutcome {
  decision: 'allow' | 'ask' | 'deny';
  /** 막거나 확인이 필요한 이유 (사용자와 에이전트에게 그대로 보여줍니다) */
  reasons: string[];
  /** 어떤 가드·훅이 결정했는지 */
  by: string[];
  /** before_send 에서 훅이 바꾼 본문 */
  text?: string;
  /** 기록만 하는 훅이 남긴 메모 */
  logs: string[];
}
