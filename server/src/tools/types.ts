import type { AgentRow, ReportTarget } from '../db/store.ts';
import type { TaskSink } from '../agents/sink.ts';

/** 다른 에이전트가 맡긴 작업이면, 끝났을 때 결과를 돌려줄 곳 */
export interface DelegationOrigin {
  fromAgentId: string;
  /** 맡긴 쪽 대화의 위임 카드 (결과가 오면 상태를 바꿈). 맡긴 쪽이 조용한 작업이었다면 null */
  cardId: number | null;
  /** 결과가 오면 맡긴 쪽이 이어서 처리할 작업의 입력 */
  back: {
    source: string;
    sourceLabel: string;
    reply: { moduleId: string; target: string } | null;
    quiet: boolean;
    reportTo: ReportTarget | null;
    chain: string[];
    /** 맡긴 쪽도 누군가에게서 맡은 일이었다면, 그 결과를 돌려줄 의무를 이어받습니다 */
    delegation: DelegationOrigin | null;
    /** 결과를 받은 쪽 작업이 이어받을 왕복 횟수 (같은 일로 같은 에이전트에게 몇 번 맡겼는지) */
    rounds?: Record<string, number>;
  };
}

/** 도구 한 번 호출에 필요한 실행 정보 */
export interface ToolEnv {
  agent: AgentRow;
  workspace: string;
  threadId: string;
  taskId: string;
  signal: AbortSignal;
  /** 작업이 들어온 채널 (답장 대상). 콘솔 작업이면 null. */
  reply: { moduleId: string; target: string } | null;
  /** 대화 스레드 키와 이름 (위임 결과를 같은 대화로 돌려받을 때 씀) */
  source: string;
  sourceLabel: string;
  /** 조용한 작업(하트비트 · 자동 알림)인지 */
  quiet: boolean;
  /** 조용한 작업의 보고를 보낼 곳 */
  reportTo: ReportTarget | null;
  /** 이 작업까지 일을 맡겨 온 에이전트 id 들 */
  chain: string[];
  /** 이 작업이 다른 에이전트가 맡긴 일이면 그 정보 */
  delegation: DelegationOrigin | null;
  /** 이 일의 줄기에서 에이전트별로 맡긴 횟수 (결과를 받고 다시 맡긴 왕복. 같은 작업 안의 서로 다른 일은 따로 셈) */
  rounds: Record<string, number>;
  /** 이 작업 중에 다른 에이전트에게 일을 맡겼는지 (그러면 결과 반환 의무가 후속 작업으로 넘어감) */
  deferred: boolean;
  /** 타임라인 · 활동 · 실시간 이벤트를 남기는 통로 */
  sink: TaskSink;
  /** 이 작업 동안 사용자가 한 번 허락한 권한 (화면 제어는 작업마다 한 번만 묻습니다) */
  grants: Set<string>;
  /** 이 작업의 화면 제어 기록 (타임라인 카드 하나에 이어서 쌓음) */
  screen: ScreenRun | null;
  /** 이 작업에서 이미 '설정 필요' 카드를 띄운 모듈 (같은 모듈은 한 번만) */
  setupShown: Set<string>;
}

export interface ScreenRun {
  cardId: number | null;
  count: number;
  actions: { s: string; ok: boolean }[];
  image: string | null;
}

/** 훅·권한 판단과 타임라인 표시에 쓰는 요약 */
export interface Described {
  permission: string | null;
  target: string | null;
  command?: string | null;
  paths?: string[];
  /** 셸 명령이 도는 폴더 (상대 경로 인자를 이 기준으로 검사) */
  cwd?: string;
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
