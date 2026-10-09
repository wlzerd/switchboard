/**
 * 위임할 때 '누가 이 일을 할 수 있는지'의 판단 근거.
 *  - 시스템 프롬프트의 위임 목록에 붙이는 에이전트별 할 수 있는 일 요약 (권한 · 허용 폴더 · 연결된 도구)
 *  - 권한에 막혔을 때 그 동작을 실제로 할 수 있는 에이전트 (협조 에이전트가 할 수 있으면 먼저)
 * 맡는 쪽에서 다시 막혀 왕복만 하고 실패하는 일을 줄이려는 것입니다.
 */
import path from 'node:path';
import type { AgentRow } from '../db/store.ts';
import { areaOf, displayPath, folderLabel, isInsidePath } from '../permissions/folders.ts';
import { evaluatePermission, type PermissionDef } from '../permissions/policy.ts';

/** 이번 작업에서 권한에 막힌 동작 (위임할 때 맡을 쪽이 할 수 있는지 확인용) */
export interface BlockedAction {
  permission: string;
  label: string;
  target: string | null;
}

export type Ability = 'allow' | 'ask';

export interface Capable {
  agent: AgentRow;
  ability: Ability;
  /** 맡기는 쪽이 정해 둔 협조 에이전트(우선 후보)인지 */
  preferred: boolean;
}

/** 위임 목록에 요약해 보여 줄 권한 (확장 · 관리용 권한은 뺌) */
const SUMMARY_KEYS = ['fs.read', 'fs.write', 'shell.exec', 'pkg.install', 'net.fetch', 'web.search', 'screen.control'];
const SCOPE_SHOWN = 2;

/**
 * 막힌 동작을 peer 가 할 수 있는지: 바로(allow) · 승인 받으면(ask) · 못 함(null).
 * 경로가 맡기는 쪽의 작업 폴더 안이면, 맡는 쪽은 자기 작업 폴더에서 하게 되므로 범위 대신 권한만 봅니다.
 * 그 밖의 경로는 맡는 쪽의 작업 폴더나 허용 폴더 안이어야 합니다 (쓰기는 읽기·쓰기 폴더).
 */
export function abilityFor(peer: AgentRow, def: PermissionDef, target: string | null, ws: { requester: string; peer: string }): Ability | null {
  let t = target;
  if (def.scope === 'path' && t !== null && path.isAbsolute(t)) {
    if (isInsidePath(ws.requester, t)) t = null;
    else {
      const area = areaOf(t, ws.peer, peer.folders);
      if (!area) return null;
      if (def.key === 'fs.write' && area.kind === 'folder' && area.folder.mode === 'read') return null;
    }
  }
  const d = evaluatePermission(def, peer.permissions[def.key], t);
  return d.decision === 'deny' ? null : d.decision;
}

/**
 * 막힌 동작을 할 수 있는 에이전트들. 순서: 협조 에이전트(우선 후보) → 바로 가능 → 승인 필요 → 이름.
 * candidates 는 위임을 받는 에이전트 중 맡길 수 있는 것만 (자기 자신 · 맡겨 온 쪽 제외) 넘깁니다.
 */
export function capableAgents(candidates: readonly AgentRow[], def: PermissionDef, target: string | null, opts: { requester: AgentRow; preferredId: string | null; workspaceOf: (id: string) => string }): Capable[] {
  const out: Capable[] = [];
  const requesterWs = opts.workspaceOf(opts.requester.id);
  for (const p of candidates) {
    const ability = abilityFor(p, def, target, { requester: requesterWs, peer: opts.workspaceOf(p.id) });
    if (ability) out.push({ agent: p, ability, preferred: p.id === opts.preferredId });
  }
  const rank = (c: Capable): number => (c.preferred ? 0 : 2) + (c.ability === 'allow' ? 0 : 1);
  return out.sort((a, b) => rank(a) - rank(b) || a.agent.name.localeCompare(b.agent.name));
}

/** '코딩이(바로 가능 · 협조 에이전트)' 처럼 후보 한 명 */
export function capableLabel(c: Capable): string {
  return `${c.agent.name}(${c.ability === 'allow' ? '바로 가능' : '승인 필요'}${c.preferred ? ' · 협조 에이전트' : ''})`;
}

const clip = (s: string, max: number): string => (s.length > max ? `${s.slice(0, max)}…` : s);

/**
 * 위임 목록 한 줄에 붙이는 할 수 있는 일 요약.
 * 예: 할 수 있음: 파일 읽기 허용, 셸 명령 허용(npm *, git *) · 못 함: HTTP 요청 · 폴더: ~/work(읽기·쓰기) · 도구: GitHub
 */
export function abilitySummary(peer: AgentRow, defs: readonly PermissionDef[], tools: readonly string[], home: string): string {
  const can: string[] = [];
  const cannot: string[] = [];
  for (const key of SUMMARY_KEYS) {
    const def = defs.find((d) => d.key === key);
    if (!def || def.locked) continue;
    const rule = peer.permissions[key];
    if (rule?.mode === 'deny') {
      cannot.push(def.label);
      continue;
    }
    // 설정이 없으면 확인으로 봅니다 (권한 판단과 같음).
    const mode = rule?.mode === 'allow' ? '허용' : '확인';
    const scope = rule && rule.scope.length > 0 ? `(${rule.scope.slice(0, SCOPE_SHOWN).map((s) => clip(s, 40)).join(', ')}${rule.scope.length > SCOPE_SHOWN ? ` 외 ${rule.scope.length - SCOPE_SHOWN}` : ''})` : '';
    can.push(`${def.label} ${mode}${scope}`);
  }
  const parts = [`할 수 있음: ${can.join(', ') || '없음'}`];
  if (cannot.length > 0) parts.push(`못 함: ${cannot.join(', ')}`);
  if (peer.folders.length > 0) parts.push(`폴더: ${peer.folders.map((f) => folderLabel(f, home)).join(', ')}`);
  if (tools.length > 0) parts.push(`도구: ${tools.join(', ')}`);
  return parts.join(' · ');
}

/** 경로 대상은 사람이 읽기 쉽게 (~ 로 줄임) */
export function blockedLabel(b: BlockedAction, home: string): string {
  if (!b.target) return b.label;
  const shown = path.isAbsolute(b.target) ? displayPath(b.target, home) : b.target;
  return `${b.label} · ${clip(shown.replace(/\s+/g, ' '), 80)}`;
}
