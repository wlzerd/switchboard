/**
 * 서버(부모)와 모듈 프로세스(자식) 사이의 IPC 메시지.
 */

export interface InboundMessage {
  /** 채널 안의 대화 대상 (Discord 채널 이름 #ops, Telegram chat id 등) */
  target: string;
  /** 화면에 보일 대상 이름 */
  targetLabel: string;
  userId: string;
  userName: string;
  text: string;
  /** 봇을 직접 부른 메시지(멘션·DM)인지 */
  direct: boolean;
  /** 답장을 이어 붙일 때 쓰는 원본 메시지 id */
  messageId?: string;
}

export interface InitMessage {
  t: 'init';
  id: string;
  kind: 'module' | 'skill';
  dir: string;
  entry: string;
  dataDir: string;
  /** API 에 보이는 도구 이름과 코드에서 내보내는 함수 이름 */
  tools: { name: string; handler: string }[];
  netAllow: string[];
}

export type ParentMessage =
  | InitMessage
  | { t: 'call'; id: number; tool: string; input: unknown; meta: { agentId: string | null; agentName: string | null; taskId: string | null } }
  | { t: 'send'; id: number; target: string; text: string }
  | { t: 'stop' };

export interface SerializedError {
  name: string;
  message: string;
  stack?: string;
}

export type ChildMessage =
  | { t: 'ready'; tools: string[]; canSend: boolean }
  | { t: 'result'; id: number; ok: true; output: string }
  | { t: 'result'; id: number; ok: false; error: SerializedError }
  | { t: 'inbound'; message: InboundMessage }
  | { t: 'log'; level: 'info' | 'warn' | 'error'; msg: string }
  | { t: 'status'; detail: string }
  | { t: 'fatal'; error: SerializedError };
