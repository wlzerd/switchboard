import { describe, expect, it } from 'vitest';
import { compactTokens, initial, percent, relTime, uptime } from '../src/lib/format';
import { COLUMN, layoutGraph, relatedTo } from '../src/lib/graph';
import { contrast, contrastIssues, readableOn } from '../src/lib/theme';
import type { Overview } from '../src/lib/types';

describe('토큰 표시', () => {
  it.each([
    [0, '0'],
    [999, '999'],
    [1000, '1K'],
    [1049, '1K'],
    [1050, '1.1K'],
    [1250, '1.3K'],
    [99_949, '99.9K'],
    [99_950, '100K'],
    [99_999, '100K'],
    [100_000, '100K'],
    [999_499, '999K'],
    // 반올림하면 1000K 가 되는 구간은 M 으로 (예전에는 '1000K' 로 나왔음)
    [999_500, '1M'],
    [999_999, '1M'],
    [1_000_000, '1M'],
    [1_240_000, '1.24M'],
    [9_994_999, '9.99M'],
    [9_995_000, '10M'],
    // 끝자리 0 을 지우다 10M 이 1M 으로 보이던 버그 (일일 토큰 한도 최댓값이 10,000,000)
    [10_000_000, '10M'],
    [12_000_000, '12M'],
    [20_000_000, '20M'],
    [100_000_000, '100M'],
  ])('%i → %s', (n, want) => {
    expect(compactTokens(n)).toBe(want);
  });
});

describe('기타 형식', () => {
  it('가동 시간: 하루 미만이면 일 표시 없음, 정확히 하루면 1일', () => {
    expect(uptime(86_399_000)).toBe('23:59:59');
    expect(uptime(86_400_000)).toBe('1일 00:00:00');
    expect(uptime(-5)).toBe('00:00:00');
  });

  it('상대 시간 경계', () => {
    expect(relTime(0, 59_999)).toBe('방금');
    expect(relTime(0, 60_000)).toBe('1분 전');
    expect(relTime(0, 3_600_000)).toBe('1시간 전');
    expect(relTime(1000, 0)).toBe('방금');
  });

  it('퍼센트는 0~100 으로 자르고, 한도 0 은 0%', () => {
    expect(percent(150, 100)).toBe(100);
    expect(percent(-1, 100)).toBe(0);
    expect(percent(5, 0)).toBe(0);
  });

  it('첫 글자는 서로게이트 문자도 한 글자로', () => {
    expect(initial('  에코')).toBe('에');
    expect(initial('🦊여우')).toBe('🦊');
    expect(initial('')).toBe('?');
  });
});

describe('색 대비', () => {
  it('흑백 대비는 21:1, 같은 색은 1:1', () => {
    expect(contrast('#000000', '#FFFFFF')).toBeCloseTo(21, 0);
    expect(contrast('#777777', '#777777')).toBe(1);
  });

  it('강조색 위 글자는 대비가 큰 쪽', () => {
    expect(readableOn('#C6F35B')).toBe('#0B0D11');
    expect(readableOn('#2F4BD8')).toBe('#FFFFFF');
  });

  it('읽기 어려운 조합을 찾아낸다', () => {
    const t = { bg: '#000000', panel: '#000000', surface: '#111111', raised: '#222222', line: '#333333', line2: '#444444', text: '#EEEEEE', text2: '#333333', text3: '#555555', accent: '#C6F35B', onAccent: '#FFFFFF', msg: '#6CB6FF', skill: '#FFB547', warn: '#FFB547', danger: '#FF6B6B' };
    const issues = contrastIssues(t);
    expect(issues.some((m) => m.startsWith('보조 글자와 카드'))).toBe(true);
    expect(issues.some((m) => m.startsWith('강조색 위 글자'))).toBe(true);
    expect(issues.some((m) => m.startsWith('본문 글자'))).toBe(false);
  });
});

describe('그래프 배치', () => {
  const overview = (agents: number, modules: number, skills: number): Overview =>
    ({
      server: { startedAt: 0, now: 0, tz: 'UTC', tokensToday: 0, approvalsPending: 0, envKey: false },
      agents: Array.from({ length: agents }, (_, i) => ({ id: `a${i}` })),
      modules: Array.from({ length: modules }, (_, i) => ({ id: `m${i}`, status: 'running' })),
      skills: Array.from({ length: skills }, (_, i) => ({ id: `s${i}` })),
      builtinNodes: [{ id: 'builtin:web', label: '웹', tools: [] }],
      edges: [
        { from: 'module:m0', to: 'a0', kind: 'message' },
        { from: 'a0', to: 'skill:s0', kind: 'new' },
        { from: 'a0', to: 'builtin:web', kind: 'skill' },
        { from: 'a0', to: 'skill:없음', kind: 'skill' },
      ],
    }) as unknown as Overview;

  it('세 줄의 x 위치와, 가장 긴 줄 기준 세로 가운데 정렬', () => {
    const { nodes } = layoutGraph(overview(1, 3, 1));
    const agent = nodes.find((n) => n.id === 'a0');
    const mods = nodes.filter((n) => n.kind === 'module');
    expect(agent?.x).toBe(COLUMN.agent.x);
    expect(mods.map((m) => m.x)).toEqual([0, 0, 0]);
    const tall = 3 * COLUMN.module.height + 2 * COLUMN.module.gap;
    expect(agent?.y).toBe((tall - COLUMN.agent.height) / 2);
  });

  it('없는 노드를 가리키는 선은 버리고, 쓰는 내장 도구만 노드로 만든다', () => {
    const { nodes, edges } = layoutGraph(overview(1, 1, 1));
    expect(edges.map((e) => e.id)).toEqual(['module:m0->a0', 'a0->skill:s0', 'a0->builtin:web']);
    expect(nodes.filter((n) => n.kind === 'builtin')).toHaveLength(1);
  });

  it('사용자가 옮긴 위치를 우선한다', () => {
    const { nodes } = layoutGraph(overview(1, 0, 0), { a0: { x: 5, y: 7 } });
    expect(nodes[0]).toMatchObject({ x: 5, y: 7 });
  });

  it('빈 화면', () => {
    const { nodes, edges } = layoutGraph(overview(0, 0, 0));
    expect(nodes).toEqual([]);
    expect(edges).toEqual([]);
  });

  it('선택한 노드와 바로 이어진 노드만 관련으로 본다', () => {
    const { edges } = layoutGraph(overview(1, 1, 1));
    expect([...(relatedTo('a0', edges) ?? [])].sort()).toEqual(['a0', 'builtin:web', 'module:m0', 'skill:s0']);
    expect(relatedTo(null, edges)).toBeNull();
  });
});
