import { describe, expect, it } from 'vitest';
import { boundHistory, isCleanUserTurn, sanitizeFallbackContent, stripThinking, type HistoryMessage } from '../src/agents/history.ts';
import { validateJson } from '../src/tools/json-schema.ts';

const user = (text: string): HistoryMessage => ({ role: 'user', content: text });
const toolResult = (id: string): HistoryMessage => ({ role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] });
const assistant = (...blocks: Record<string, unknown>[]): HistoryMessage => ({ role: 'assistant', content: blocks });
const think = { type: 'thinking', thinking: '', signature: 's' };

describe('stripThinking', () => {
  it('thinking 만 있던 assistant 메시지는 통째로 빠진다', () => {
    const out = stripThinking([user('a'), assistant(think), user('b')]);
    expect(out).toEqual([user('a'), user('b')]);
  });

  it('도구 호출은 남기고 thinking 만 뺀다', () => {
    const out = stripThinking([assistant(think, { type: 'tool_use', id: 't1', name: 'x', input: {} })]);
    expect(out[0]?.content).toEqual([{ type: 'tool_use', id: 't1', name: 'x', input: {} }]);
  });
});

describe('boundHistory', () => {
  const convo: HistoryMessage[] = [
    user('q1'),
    assistant(think, { type: 'tool_use', id: 't1', name: 'x', input: {} }),
    toolResult('t1'),
    assistant({ type: 'text', text: 'a1' }),
    user('q2'),
    assistant(think, { type: 'text', text: 'a2' }),
  ];

  it('최대 개수 이하면 그대로', () => {
    expect(boundHistory(convo, 6)).toEqual({ messages: convo, trimmed: false });
  });

  it('tool_result 에서 자르지 않고 다음 깨끗한 user 턴에서 자른 뒤 thinking 을 지운다', () => {
    // 뒤에서 4개 = toolResult('t1') 부터지만, 깨끗한 시작은 user('q2')
    const r = boundHistory(convo, 4);
    expect(r.trimmed).toBe(true);
    expect(r.messages[0]).toEqual(user('q2'));
    expect(r.messages[1]?.content).toEqual([{ type: 'text', text: 'a2' }]);
  });

  it('범위 안에 깨끗한 시작이 없으면 그 이전의 가장 가까운 시작을 쓴다', () => {
    const tail: HistoryMessage[] = [user('q'), assistant({ type: 'tool_use', id: 'a', name: 'x', input: {} }), toolResult('a'), assistant({ type: 'tool_use', id: 'b', name: 'x', input: {} }), toolResult('b')];
    const r = boundHistory([user('old'), assistant({ type: 'text', text: 'x' }), ...tail], 2);
    expect(r.messages[0]).toEqual(user('q'));
  });

  it('깨끗한 user 턴 판별', () => {
    expect(isCleanUserTurn(user('x'))).toBe(true);
    expect(isCleanUserTurn(toolResult('a'))).toBe(false);
    expect(isCleanUserTurn({ role: 'user', content: [{ type: 'text', text: 'x' }] })).toBe(true);
  });
});

describe('sanitizeFallbackContent', () => {
  it('마지막 fallback 블록 앞의 thinking·tool_use·짝 없는 server_tool_use 를 뺀다', () => {
    const content = [
      { type: 'thinking', thinking: '' },
      { type: 'text', text: '부분 답' },
      { type: 'server_tool_use', id: 'srv1' },
      { type: 'web_search_tool_result', tool_use_id: 'srv1' },
      { type: 'server_tool_use', id: 'srv2' },
      { type: 'tool_use', id: 'c1' },
      { type: 'fallback', from: { model: 'a' }, to: { model: 'b' } },
      { type: 'thinking', thinking: '' },
      { type: 'text', text: '이어서' },
    ];
    expect(sanitizeFallbackContent(content).map((b) => `${String(b.type)}${b.id ? `:${String(b.id)}` : ''}`)).toEqual([
      'text',
      'server_tool_use:srv1',
      'web_search_tool_result',
      'fallback',
      'thinking',
      'text',
    ]);
  });

  it('fallback 이 없으면 그대로', () => {
    const c = [{ type: 'thinking' }, { type: 'text', text: 'x' }];
    expect(sanitizeFallbackContent(c)).toEqual(c);
  });
});

describe('도구 입력 검증', () => {
  const schema = {
    type: 'object',
    properties: {
      path: { type: 'string', minLength: 1, maxLength: 10 },
      depth: { type: 'integer', minimum: 1, maximum: 3 },
      tags: { type: 'array', items: { type: 'string', enum: ['a', 'b'] }, maxItems: 2 },
    },
    required: ['path'],
    additionalProperties: false,
  };

  it.each([
    [{ path: 'a' }, null],
    [{}, 'input.path: 필수 값이 없습니다.'],
    [{ path: '' }, 'input.path: 1자 이상'],
    [{ path: 'a'.repeat(10) }, null],
    [{ path: 'a'.repeat(11) }, 'input.path: 10자 이하'],
    [{ path: 'a', depth: 0 }, 'input.depth: 1 이상'],
    [{ path: 'a', depth: 3 }, null],
    [{ path: 'a', depth: 1.5 }, 'input.depth: integer 이어야'],
    [{ path: 'a', tags: ['a', 'c'] }, 'input.tags[1]:'],
    [{ path: 'a', tags: ['a', 'b', 'a'] }, '항목은 2개까지'],
    [{ path: 'a', extra: 1 }, 'input.extra: 스키마에 없는 속성'],
  ])('%j → %s', (value, want) => {
    const r = validateJson(value, schema);
    if (want === null) expect(r).toBeNull();
    else expect(r).toContain(want);
  });

  it('number 스키마는 정수도 받는다', () => {
    expect(validateJson(3, { type: 'number' })).toBeNull();
  });

  it('깊게 중첩된 입력도 스택 오버플로 없이 검사한다', () => {
    let value: Record<string, unknown> = {};
    let schema: Record<string, unknown> = { type: 'object', properties: {} };
    const rootV = value;
    const rootS = schema;
    for (let i = 0; i < 5000; i += 1) {
      const nv: Record<string, unknown> = {};
      const ns: Record<string, unknown> = { type: 'object', properties: {} };
      value['n'] = nv;
      (schema['properties'] as Record<string, unknown>)['n'] = ns;
      value = nv;
      schema = ns;
    }
    expect(validateJson(rootV, rootS)).toBeNull();
  });
});

import { danglingToolResults } from '../src/agents/history.ts';

describe('danglingToolResults', () => {
  it('마지막 assistant 의 tool_use 마다 오류 결과를 만든다', () => {
    const r = danglingToolResults([user('q'), assistant({ type: 'text', text: '해볼게요' }, { type: 'tool_use', id: 'a', name: 'x', input: {} }, { type: 'tool_use', id: 'b', name: 'y', input: {} })]);
    expect((r?.content as { tool_use_id: string }[]).map((b) => b.tool_use_id)).toEqual(['a', 'b']);
  });

  it('정상 종료된 기록·도구 없는 답변·빈 기록은 손대지 않는다', () => {
    expect(danglingToolResults([user('q'), assistant({ type: 'text', text: '끝' })])).toBeNull();
    expect(danglingToolResults([user('q')])).toBeNull();
    expect(danglingToolResults([])).toBeNull();
  });
});
