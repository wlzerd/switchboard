import type { AgentRow } from '../db/store.ts';

/** 도구 한 번 호출에 필요한 실행 정보 */
export interface ToolEnv {
  agent: AgentRow;
  workspace: string;
  threadId: string;
  taskId: string;
  signal: AbortSignal;
  /** 작업이 들어온 채널 (답장 대상). 콘솔 작업이면 null. */
  reply: { moduleId: string; target: string } | null;
}

/** 훅·권한 판단과 타임라인 표시에 쓰는 요약 */
export interface Described {
  permission: string | null;
  target: string | null;
  command?: string | null;
  paths?: string[];
  url?: string | null;
  host?: string | null;
  method?: string | null;
  text?: string | null;
  summary: string;
}

export interface BuiltinTool {
  name: string;
  title: string;
  description: string;
  input_schema: Record<string, unknown>;
  /** 권한 판단 전에 입력을 해석합니다. 해석 단계에서 막아야 할 문제는 예외로 알립니다. */
  describe(input: Record<string, unknown>, env: ToolEnv): Promise<Described> | Described;
  run(input: Record<string, unknown>, env: ToolEnv): Promise<string>;
}
