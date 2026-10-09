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

export interface AgentLimits {
  tokensPerDay: number;
  stepsPerTask: number;
  concurrency: number;
  messagesPerMinute: number;
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
  task: TaskView | null;
  tokensToday: number;
  tokenLimit: number;
  limits: AgentLimits;
  links: { moduleId: string; targets: string[]; trigger: 'direct' | 'all' }[];
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
  tools: { name: string; title: string }[];
  env: { name: string; required: boolean; present: boolean }[];
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
  edges: { from: string; to: string; kind: 'message' | 'skill' | 'new' | 'creating' }[];
}

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
  limitRules: Record<keyof AgentLimits, { label: string; unit: string; min: number; max: number }>;
  efforts: Effort[];
  hookEvents: string[];
  hookFields: Record<string, string[]>;
  hookActions: Record<string, RuleHook['action'][]>;
  conditionOps: string[];
  guards: GuardDef[];
  themes: { presets: { id: string; name: string; tokens: ThemeTokens }[]; default: { preset: string; radius: number; font: Theme['font']; density: Theme['density']; motion: Theme['motion'] } };
  tz: string;
  envKey: boolean;
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
}

export interface ApprovalView {
  id: string;
  agentId: string;
  taskId: string | null;
  kind: string;
  title: string;
  detail: { permission: string | null; target: string | null; rule: string; tool: string | null; input: string | null; moduleId?: string };
  status: 'pending' | 'approved' | 'denied' | 'expired';
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
  kind: 'user' | 'agent' | 'tool' | 'approval' | 'hook' | 'block' | 'skill' | 'system' | 'error';
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
  | { type: 'edge.pulse'; from: string; to: string; kind: 'message' | 'skill' }
  | { type: 'approval.created'; approval: ApprovalView }
  | { type: 'approval.resolved'; approval: ApprovalView }
  | { type: 'module.status'; moduleId: string; status: ModuleStatus; detail: string | null }
  | { type: 'skill.created'; skillId: string; agentId: string | null }
  | { type: 'graph.changed' }
  | { type: 'theme.changed'; theme: Theme };
