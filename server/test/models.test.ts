import { describe, expect, it } from 'vitest';
import { clampMaxTokens, groupModels, summarizeModel, type ModelSummary, type RawModel } from '../src/anthropic/models.ts';

const caps = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  effort: { supported: true, low: { supported: true }, medium: { supported: true }, high: { supported: true }, xhigh: null, max: { supported: true } },
  thinking: { supported: true, types: { adaptive: { supported: true } } },
  context_management: { supported: true, compact_20260112: { supported: true } },
  image_input: { supported: true },
  ...over,
});

const m = (id: string, line: string | null, created: string | null, lifecycle = 'active'): ModelSummary =>
  summarizeModel({ id, display_name: id.toUpperCase(), line, created_at: created, lifecycle, capabilities: caps() } as RawModel);

describe('summarizeModel', () => {
  it('xhigh 가 null 인 모델은 xhigh 를 빼고 나머지 노력 단계를 고른다', () => {
    expect(m('a', 'opus', '2026-01-01T00:00:00Z').efforts).toEqual(['low', 'medium', 'high', 'max']);
  });

  it('effort 미지원이면 단계 목록이 비어 있다', () => {
    const s = summarizeModel({ id: 'x', capabilities: caps({ effort: { supported: false } }) });
    expect(s.efforts).toEqual([]);
  });

  it('capabilities 가 null 이어도 죽지 않는다', () => {
    const s = summarizeModel({ id: 'x', capabilities: null });
    expect(s.adaptiveThinking).toBe(false);
    expect(s.compaction).toBe(false);
  });

  it('display_name 이 비면 id 를 이름으로 쓴다', () => {
    expect(summarizeModel({ id: 'claude-x', display_name: '  ' }).name).toBe('claude-x');
  });

  it('0 이하 토큰 한도는 null 로 본다', () => {
    expect(summarizeModel({ id: 'x', max_tokens: 0, max_input_tokens: -1 })).toMatchObject({ maxOutputTokens: null, contextTokens: null });
  });

  it('allowed_fallback_models 가 빈 배열이면 대체 모델 없음', () => {
    expect(summarizeModel({ id: 'x', allowed_fallback_models: [] }).fallback).toBe(false);
    expect(summarizeModel({ id: 'x', allowed_fallback_models: ['y'] }).fallback).toBe(true);
  });
});

describe('groupModels', () => {
  it('계열마다 가장 최근 active 모델 하나가 최신 목록에 간다', () => {
    const g = groupModels([
      m('opus-old', 'opus', '2025-01-01T00:00:00Z'),
      m('opus-new', 'opus', '2026-01-01T00:00:00Z'),
      m('haiku', 'haiku', '2025-06-01T00:00:00Z'),
    ]);
    expect(g.latest.map((x) => x.id)).toEqual(['opus-new', 'haiku']);
    expect(g.older.map((x) => x.id)).toEqual(['opus-old']);
  });

  it('출시 시각이 같으면 id 사전순으로 결정적이다', () => {
    const t = '2026-01-01T00:00:00Z';
    const a = groupModels([m('b', 'opus', t), m('a', 'opus', t)]);
    const b = groupModels([m('a', 'opus', t), m('b', 'opus', t)]);
    expect(a.latest[0]?.id).toBe('a');
    expect(b.latest[0]?.id).toBe('a');
  });

  it('deprecated 는 최신이 될 수 없고, retired 는 목록에서 빠진다', () => {
    const g = groupModels([
      m('dep', 'sonnet', '2027-01-01T00:00:00Z', 'deprecated'),
      m('act', 'sonnet', '2026-01-01T00:00:00Z'),
      m('ret', 'sonnet', '2028-01-01T00:00:00Z', 'retired'),
    ]);
    expect(g.latest.map((x) => x.id)).toEqual(['act']);
    expect(g.older.map((x) => x.id)).toEqual(['dep']);
  });

  it('계열이 없는 모델은 추측하지 않고 이전 버전에 둔다', () => {
    const g = groupModels([m('mystery', null, '2026-01-01T00:00:00Z')]);
    expect(g.latest).toEqual([]);
    expect(g.older.map((x) => x.id)).toEqual(['mystery']);
  });

  it('출시 시각이 잘못된 모델은 가장 오래된 것으로 본다', () => {
    const g = groupModels([m('bad', 'opus', 'not-a-date'), m('good', 'opus', '2020-01-01T00:00:00Z')]);
    expect(g.latest[0]?.id).toBe('good');
  });

  it('빈 목록', () => {
    expect(groupModels([])).toEqual({ latest: [], older: [] });
  });
});

describe('clampMaxTokens', () => {
  it.each([
    [64000, 128000, 64000],
    [64000, 64000, 64000],
    [64000, 63999, 63999],
    [64000, null, 64000],
  ])('설정 %i, 모델 한도 %s → %i', (conf, cap, want) => {
    expect(clampMaxTokens(conf, { maxOutputTokens: cap })).toBe(want);
  });
});
