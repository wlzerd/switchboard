import { describe, expect, it } from 'vitest';
import { COLUMN, layoutGraph } from '../src/lib/graph';
import type { Overview } from '../src/lib/types';

const overview = (screen: { enabled: boolean; linked: boolean }): Overview =>
  ({
    server: { startedAt: 0, now: 0, tz: 'UTC', tokensToday: 0, approvalsPending: 0, envKey: false },
    agents: [{ id: 'a0', delegation: { accept: false, send: false, supervisorId: null } }],
    modules: [
      { id: 'telegram', status: 'running', computer: false },
      { id: 'computer', status: 'idle', computer: true, enabled: screen.enabled },
    ],
    skills: [],
    builtinNodes: [{ id: 'builtin:fs', label: '파일', tools: [] }],
    edges: [
      { from: 'module:telegram', to: 'a0', kind: 'message' },
      { from: 'a0', to: 'builtin:fs', kind: 'skill' },
      ...(screen.linked ? [{ from: 'a0', to: 'module:computer', kind: 'skill' as const }] : []),
    ],
  }) as unknown as Overview;

describe('화면 제어 모듈 배치', () => {
  it('켜져 있으면 오른쪽 줄(도구 쪽) 맨 위, 채널 모듈은 왼쪽 그대로', () => {
    const { nodes } = layoutGraph(overview({ enabled: true, linked: true }));
    const screen = nodes.find((n) => n.id === 'module:computer');
    const fsNode = nodes.find((n) => n.id === 'builtin:fs');
    expect(screen).toMatchObject({ kind: 'screen', x: COLUMN.skill.x });
    expect(screen!.y).toBeLessThan(fsNode!.y);
    expect(nodes.find((n) => n.id === 'module:telegram')).toMatchObject({ kind: 'module', x: COLUMN.module.x });
  });

  it('꺼져 있고 연결도 없으면 숨기고, 꺼져 있어도 연결되어 있으면 보입니다', () => {
    expect(layoutGraph(overview({ enabled: false, linked: false })).nodes.some((n) => n.id === 'module:computer')).toBe(false);
    expect(layoutGraph(overview({ enabled: false, linked: true })).nodes.some((n) => n.id === 'module:computer')).toBe(true);
  });

  it('에이전트 → 화면 선이 남습니다 (숨긴 화면으로 가는 선은 없음)', () => {
    expect(layoutGraph(overview({ enabled: true, linked: true })).edges.map((e) => e.id)).toContain('a0->module:computer');
    expect(layoutGraph(overview({ enabled: false, linked: false })).edges.map((e) => e.id)).not.toContain('a0->module:computer');
  });
});
