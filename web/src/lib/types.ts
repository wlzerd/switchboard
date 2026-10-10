/** 서버 API 응답 형태 (server/src/http 와 맞춰 둡니다) */

export type Mode = 'allow' | 'ask' | 'deny';
export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';
export type AgentStatus = 'idle' | 'working' | 'waiting' | 'paused' | 'error';
export type ModuleStatus = 'pending' | 'stopped' | 'starting' | 'running' | 'idle' | 'crashed' | 'failed' | 'rejected';
export type StepState = 'done' | 'active' | 'wait' | 'todo' | 'error';
export type TaskStatus = 'queued' | 'running' | 'waiting' | 'done' | 'failed' | 'cancelled';

export interface PermissionRule {
  mode: Mode;
  scope: string[];
  always: string[];
}

export interface TaskStep {
  id: string;
  label: string;
  meta: string;
  state: StepState;
  at: number;
}

export interface TaskView {
  id: string;
  title: string;
  status: TaskStatus;
  steps: TaskStep[];
  error: string | null;
  origin: string;
  finishedAt: number | null;
}

export interface DelegationSettings {
  /** 다른 에이전트가 맡기는 일을 받는지 */
  accept: boolean;
  /** 다른 에이전트에게 일을 맡길 수 있는지 */
  send: boolean;
  /** 협조 에이전트: 맡길 수 있는 에이전트가 여럿일 때 먼저 고르는 우선 후보 (필드 이름은 예전 그대로) */
  supervisorId: string | null;
}

export interface HeartbeatSettings {
  enabled: boolean;
  everyMinutes: number;
  /** 'HH:MM-HH:MM' (서버 TZ). null 이면 하루 종일 */
  activeHours: string | null;
  checklist: string;
}

export interface ReportTarget {
  moduleId: string;
  target: string;
}

export interface AgentLimits {
  tokensPerDay: number;
  stepsPerTask: number;
  concurrency: number;
  messagesPerMinute: number;
}

export interface CacheUsage {
  read: number;
  write: number;
  uncached: number;
}

/** 한도 한 항목의 입력 규칙 (서버 LIMIT_RULES) */
export interface LimitRule {
  label: string;
  unit: string;
  min: number;
  /** null 이면 위쪽 제한 없음 */
  max: number | null;
  /** 0 을 넣으면 한도를 두지 않는 항목이면 그 뜻 ('한도 무제한') */
  zero?: string;
}

export interface AgentView {
  id: string;
  name: string;
  color: string;
  role: string;
  model: string;
  modelName: string | null;
  effort: Effort | null;
  keyLabel: string;
  preset: string;
  paused: boolean;
  status: AgentStatus;
  detail: string | null;
  queued: number;
  /** 대기열 길이(조용한 작업 포함)와 상한 */
  queueLength: number;
  queueMax: number;
  task: TaskView | null;
  tokensToday: number;
  tokenLimit: number;
  /** 오늘 프롬프트 캐시: 읽기 · 쓰기 · 캐시 밖 입력 (사용 기록이 없으면 null) */
  cacheToday: CacheUsage | null;
  limits: AgentLimits;
  links: { moduleId: string; targets: string[]; trigger: 'direct' | 'all' | 'none' }[];
  delegation: DelegationSettings;
  heartbeat: (HeartbeatSettings & { lastAt: number | null }) | null;
  report: ReportTarget | null;
  /** 허용 폴더 (홈은 ~ 로 줄인 경로) */
  folders: { path: string; mode: 'read' | 'write' }[];
  /** 관리 중인 프로젝트 요약 (앞의 20개) */
  projects: { id: string; name: string; displayPath: string; status: ProjectStatus; watch: boolean; isGit: boolean }[];
  projectCount: number;
}

/* ───────── 관리 중인 프로젝트 ───────── */

export type ProjectOrigin = 'instruction' | 'self' | 'delegation' | 'manual';
export type ProjectStatus = 'ok' | 'missing' | 'denied';

export interface ProjectView {
  id: string;
  agentId: string;
  name: string;
  path: string;
  displayPath: string;
  note: string;
  origin: ProjectOrigin;
  originDetail: string;
  watch: boolean;
  auto: boolean;
  createdAt: number;
  lastActivityAt: number | null;
  lastActivity: string | null;
  status: ProjectStatus;
  mode: 'read' | 'write' | null;
  area: string;
  isGit: boolean;
}

export interface GitInfo {
  branch: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  files: { code: string; path: string }[];
  changed: number;
  commit: { hash: string; subject: string; at: number } | null;
}

export interface ProjectEvent {
  id: number;
  projectId: string;
  kind: 'write' | 'read' | 'list' | 'shell' | 'commit';
  label: string;
  detail: string;
  ok: boolean;
  taskId: string | null;
  createdAt: number;
}

export interface ProjectDetail {
  project: ProjectView;
  git: { ok: true; info: GitInfo } | { ok: false; reason: string } | null;
  events: ProjectEvent[];
}

/* ───────── 설정 (env 와 DB) ───────── */

/** db: 화면에서 넣은 값 · env: .env 에서 읽는 값 · empty: 없음 · locked: 저장돼 있지만 SECRETS_KEY 로 풀 수 없음 */
export type FieldSource = 'db' | 'env' | 'empty' | 'locked';

export interface ModuleField {
  name: string;
  label: string;
  description: string;
  required: boolean;
  secret: boolean;
  source: FieldSource;
  value: string | null;
  last4: string | null;
  envAlso: boolean;
  /** 값을 만드는 곳 (토큰 발급 페이지 등) */
  url: string | null;
}

export type LoginOutcome = 'expired' | 'denied' | 'failed' | 'cancelled';

/** 모듈 로그인 (OAuth 기기 로그인): 받은 토큰은 tokenEnv 설정에 들어갑니다 */
export interface LoginView {
  label: string;
  scopes: { value: string; label: string }[];
  clientIdEnv: string;
  tokenEnv: string;
  /** Client ID 가 있어 로그인할 수 있는지 */
  ready: boolean;
  /** 이 앱의 권한을 거둘 수 있는 페이지 */
  manageUrl: string | null;
  /** 지금 토큰이 로그인으로 받은 것일 때 */
  current: { account: string | null; scope: string; at: number } | null;
  /** 사용자가 허락하기를 기다리는 중 */
  pending: { userCode: string; verificationUri: string; expiresAt: number; scope: string } | null;
  /** 마지막으로 끝난 시도 */
  last: { state: LoginOutcome; message: string; at: number } | null;
}

export interface ModuleSettingsView {
  id: string;
  name: string;
  icon: string;
  enabled: boolean;
  status: ModuleStatus;
  statusDetail: string | null;
  channel: boolean;
  computer: boolean;
  fields: ModuleField[];
  missing: string[];
  login: LoginView | null;
}

export interface KeyView {
  id: string;
  label: string;
  source: 'env' | 'stored';
  last4: string;
  users: { id: string; name: string; color: string }[];
}

export interface HookVarView {
  name: string;
  value: string | null;
  source: 'db' | 'env' | 'empty';
  usedBy: string[];
}

export interface SettingsResponse {
  keys: KeyView[];
  modules: ModuleSettingsView[];
  hookVars: HookVarView[];
  envLeft: { moduleId: string | null; name: string }[];
  env: { title: string; items: { key: string; value: string; tone: 'ok' | 'muted' | 'plain'; isNew: boolean }[] }[];
}

export interface InstallCheck {
  label: string;
  level: 'ok' | 'warn' | 'error';
  detail: string;
}

export interface InstallReport {
  checks: InstallCheck[];
  source: string;
  commit: string | null;
  checkedAt: number;
}

export interface ModuleView {
  id: string;
  kind: 'module' | 'skill';
  name: string;
  version: string;
  description: string;
  origin: 'builtin' | 'git' | 'zip' | 'template' | 'agent';
  icon: string;
  enabled: boolean;
  status: ModuleStatus;
  statusDetail: string | null;
  channel: boolean;
  /** 메시지를 보낼 수 있는 채널인지 (받기만 하는 이메일 등은 false) */
  canSend: boolean;
  /** 화면 제어 모듈인지, 지금 화면을 쓰는 에이전트 */
  computer: boolean;
  screenHolder: { taskId: string; agentId: string; agentName: string; since: number } | null;
  tools: { name: string; title: string }[];
  env: { name: string; label: string; required: boolean; present: boolean; source: FieldSource }[];
  /** 필수인데 비었거나 풀 수 없는 설정(이름) · 아직 .env 에서 읽는 설정 */
  settingsMissing: string[];
  envLeft: string[];
  permissions: { net: string[]; fsWrite: boolean; childProcess: boolean };
  license: string;
  createdBy: string | null;
  createdByName: string | null;
  installedAt: number;
  report: InstallReport | null;
  isNew?: boolean;
}

export interface Overview {
  server: { startedAt: number; now: number; tz: string; tokensToday: number; approvalsPending: number; envKey: boolean };
  agents: AgentView[];
  modules: ModuleView[];
  skills: ModuleView[];
  builtinNodes: { id: string; label: string; tools: string[] }[];
  edges: { from: string; to: string; kind: EdgeKind }[];
}

/** message·skill·new·creating: 모듈·스킬 연결 / delegate: 협조 에이전트 관계 / delegating: 진행 중인 위임 */
export type EdgeKind = 'message' | 'skill' | 'new' | 'creating' | 'delegate' | 'delegating';

export interface PermissionDef {
  key: string;
  label: string;
  group: string;
  scope: 'path' | 'command' | 'host' | 'target' | 'manager' | 'none';
  locked?: boolean;
}

export interface ThemeTokens {
  bg: string;
  panel: string;
  surface: string;
  raised: string;
  line: string;
  line2: string;
  text: string;
  text2: string;
  text3: string;
  accent: string;
  onAccent: string;
  msg: string;
  skill: string;
  warn: string;
  danger: string;
}

export interface Theme {
  name: string;
  tokens: ThemeTokens;
  radius: number;
  font: 'plex' | 'noto' | 'system';
  density: 0 | 1 | 2;
  motion: 0 | 1 | 2;
}

export interface GuardDef {
  id: string;
  name: string;
  events: string[];
  conditions: string[];
  reasonTemplate: string;
  hits24h?: number;
}

export interface Meta {
  permissionDefs: PermissionDef[];
  presets: { id: string; name: string; permissions: Record<string, PermissionRule>; message: Mode; limits: AgentLimits }[];
  limitRules: Record<keyof AgentLimits, LimitRule>;
  efforts: Effort[];
  hookEvents: string[];
  hookFields: Record<string, string[]>;
  hookActions: Record<string, RuleHook['action'][]>;
  conditionOps: string[];
  guards: GuardDef[];
  themes: { presets: { id: string; name: string; tokens: ThemeTokens }[]; default: { preset: string; radius: number; font: Theme['font']; density: Theme['density']; motion: Theme['motion'] } };
  tz: string;
  envKey: boolean;
  heartbeat: { minMinutes: number; maxMinutes: number; checklistMax: number };
  attachments: AttachmentLimits;
}

/** 콘솔 첨부 한도 (서버 환경 설정 · Claude API 한도) */
export interface AttachmentLimits {
  /** 파일 하나 */
  maxBytes: number;
  /** 메시지 하나에 붙이는 개수 */
  perMessage: number;
  /** 메시지 하나에 붙이는 합계 */
  messageMaxBytes: number;
  /** 모델이 받는 그림 하나 */
  imageMaxBytes: number;
  /** 모델이 줄이지 않고 보는 긴 변 (올리기 전에 이 크기로 줄임) */
  imageSendEdge: number;
}

export type AttachmentKind = 'image' | 'pdf' | 'text' | 'file';

/** 올린 첨부 (서버가 내용으로 종류를 정함) */
export interface AttachmentView {
  id: string;
  name: string;
  kind: AttachmentKind;
  size: number;
  width: number | null;
  height: number | null;
}

export interface ModelInfo {
  id: string;
  name: string;
  line: string | null;
  createdAt: string | null;
  lifecycle: 'active' | 'deprecated' | 'retired';
  contextTokens: number | null;
  maxOutputTokens: number | null;
  efforts: Effort[];
  adaptiveThinking: boolean;
  compaction: boolean;
  fallback: boolean;
  agents?: number;
}

export interface ThreadView {
  id: string;
  agentId: string;
  source: string;
  title: string;
  createdAt: number;
  updatedAt: number;
}

export interface ScheduleView {
  id: string;
  agentId: string;
  spec: string;
  label: string;
  prompt: string;
  reply: { moduleId: string; target: string } | null;
  enabled: boolean;
  nextRun: number | null;
  lastRun: number | null;
  createdBy: string;
  createdAt: number;
  /** 이전 실행이 안 끝났거나 일시정지 중이라 건너뛴 횟수 */
  skipped: number;
  lastSkippedAt: number | null;
}

export interface ApprovalView {
  id: string;
  agentId: string;
  taskId: string | null;
  kind: string;
  title: string;
  detail: { permission: string | null; target: string | null; rule: string; tool: string | null; input: string | null; moduleId?: string };
  status: 'pending' | 'approved' | 'denied' | 'expired' | 'cancelled';
  decision: 'once' | 'always' | 'deny' | null;
  reason: string | null;
  createdAt: number;
}

export interface ActivityItem {
  id: number;
  ts: number;
  type: string;
  category: 'hook' | 'skill' | 'module' | 'agent' | 'system';
  tone: 'agent' | 'pass' | 'block' | 'wait' | 'new' | 'module' | 'error';
  who: string;
  text: string;
  agentId: string | null;
  moduleId: string | null;
}

export interface TimelineItem {
  id: number;
  threadId: string;
  taskId: string | null;
  kind: 'user' | 'agent' | 'tool' | 'approval' | 'hook' | 'block' | 'skill' | 'system' | 'error' | 'delegate' | 'report' | 'screen' | 'setup';
  data: Record<string, unknown>;
  createdAt: number;
}

export interface RuleHook {
  id: string;
  name: string;
  event: string;
  enabled: boolean;
  action: 'deny' | 'ask' | 'modify' | 'log';
  conditions: { field: string; op: string; value: string }[];
  reason: string;
  modify: { find: string; replace: string } | null;
  code?: string;
}

export interface HookOutcome {
  decision: 'allow' | 'ask' | 'deny';
  reasons: string[];
  by: string[];
  text?: string;
  logs: string[];
}

export interface HooksResponse {
  guards: GuardDef[];
  rules: RuleHook[];
  files: { id: string; file: string; name: string; event: string; action: string; enabled: boolean; source: string }[];
  fileErrors: { file: string; message: string }[];
}

export type ServerEvent =
  | { type: 'activity'; item: ActivityItem }
  | { type: 'agent.status'; agentId: string; status: AgentStatus; detail: string | null }
  | { type: 'agent.delta'; agentId: string; threadId: string; taskId: string; text: string }
  | { type: 'task.update'; task: TaskView & { agentId: string; threadId: string } }
  | { type: 'timeline.add'; agentId: string; item: TimelineItem }
  | { type: 'timeline.update'; agentId: string; item: TimelineItem }
  | { type: 'edge.pulse'; from: string; to: string; kind: 'message' | 'skill' | 'delegate' }
  /** 조용한 작업(하트비트 · 자동 알림)이 보고할 것을 찾았을 때만 */
  | { type: 'report'; agentId: string; text: string; source: string }
  /** 사용자가 직접 누른 하트비트 점검이 끝났을 때 */
  | { type: 'heartbeat.done'; agentId: string; reported: boolean; error: string | null }
  | { type: 'approval.created'; approval: ApprovalView }
  | { type: 'approval.resolved'; approval: ApprovalView }
  | { type: 'module.status'; moduleId: string; status: ModuleStatus; detail: string | null }
  | { type: 'module.login'; moduleId: string; state: 'pending' | 'done' | LoginOutcome }
  | { type: 'skill.created'; skillId: string; agentId: string | null }
  | { type: 'graph.changed' }
  | { type: 'theme.changed'; theme: Theme };
