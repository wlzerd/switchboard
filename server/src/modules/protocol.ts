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
  /**
   * 조용한 판단: 사람이 보낸 대화가 아니라 감시 결과(새 메일 등)일 때 true.
   * 에이전트가 알릴 것이 있다고 판단할 때만 화면과 보고 채널에 나타나고, 원래 채널로 답장하지 않습니다.
   */
  quiet?: boolean;
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
  /** 화면 제어 모듈에 동작 하나 (Claude 컴퓨터 사용 도구 묶음의 동작 이름과 입력 그대로) */
  | { t: 'computer'; id: number; action: string; input: unknown }
  | { t: 'stop' };

/** 화면 제어 결과 이미지 (스크린샷 · 확대) */
export interface ImagePayload {
  data: string;
  mediaType: 'image/png' | 'image/jpeg';
}

export interface SerializedError {
  name: string;
  message: string;
  stack?: string;
}

export type ChildMessage =
  | { t: 'ready'; tools: string[]; canSend: boolean }
  | { t: 'result'; id: number; ok: true; output: string; image?: ImagePayload | null }
  | { t: 'result'; id: number; ok: false; error: SerializedError }
  | { t: 'inbound'; message: InboundMessage }
  | { t: 'log'; level: 'info' | 'warn' | 'error'; msg: string }
  | { t: 'status'; detail: string }
  | { t: 'fatal'; error: SerializedError };
