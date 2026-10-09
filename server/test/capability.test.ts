import { describe, expect, it } from 'vitest';
import { abilityFor, abilitySummary, blockedLabel, capableAgents, capableLabel } from '../src/agents/capability.ts';
import type { AgentRow } from '../src/db/store.ts';
import { BASE_PERMISSIONS, type PermissionDef, type PermissionRule } from '../src/permissions/policy.ts';

const def = (key: string): PermissionDef => BASE_PERMISSIONS.find((d) => d.key === key) as PermissionDef;
const rule = (mode: PermissionRule['mode'], scope: string[] = []): PermissionRule => ({ mode, scope, always: [] });
const agent = (id: string, permissions: Record<string, PermissionRule>, folders: AgentRow['folders'] = []): AgentRow =>
  ({ id, name: id, role: '', permissions, folders, delegation: { accept: true, send: false, supervisorId: null } }) as unknown as AgentRow;
const ws = (id: string): string => `/data/workspaces/${id}`;
const WS = { requester: ws('a'), peer: ws('b') };

describe('막힌 동작을 다른 에이전트가 할 수 있는지', () => {
  it('권한 모드대로: 허용은 바로, 확인은 승인 필요, 차단 · 설정 없음은 각각 못 함 · 승인 필요', () => {
    expect(abilityFor(agent('b', { 'shell.exec': rule('allow') }), def('shell.exec'), 'npm test', WS)).toBe('allow');
    expect(abilityFor(agent('b', { 'shell.exec': rule('ask') }), def('shell.exec'), 'npm test', WS)).toBe('ask');
    expect(abilityFor(agent('b', { 'shell.exec': rule('deny') }), def('shell.exec'), 'npm test', WS)).toBeNull();
    expect(abilityFor(agent('b', {}), def('shell.exec'), 'npm test', WS)).toBe('ask');
  });

  it('허용 범위 밖의 명령은 승인 필요, 잠긴 권한은 누구도 못 함', () => {
    const b = agent('b', { 'shell.exec': rule('allow', ['npm *']) });
    expect(abilityFor(b, def('shell.exec'), 'npm test', WS)).toBe('allow');
    expect(abilityFor(b, def('shell.exec'), 'rm -rf build', WS)).toBe('ask');
    expect(abilityFor(agent('b', { 'secrets.read': rule('allow') }), def('secrets.read'), '/x/.env', WS)).toBeNull();
  });

  it('맡기는 쪽 작업 폴더 안의 경로는 권한만 보고 (맡는 쪽은 자기 작업 폴더에서 함), 그 밖의 경로는 맡는 쪽 폴더 안이어야 함', () => {
    const b = agent('b', { 'fs.read': rule('allow'), 'fs.write': rule('allow', ['~/Documents/**']) }, [
      { path: '/srv/shared', mode: 'write' },
      { path: '/srv/readonly', mode: 'read' },
    ]);
    expect(abilityFor(b, def('fs.write'), `${ws('a')}/report.md`, WS)).toBe('allow');
    expect(abilityFor(b, def('fs.write'), '/srv/shared/out.txt', WS)).toBe('ask');
    expect(abilityFor(b, def('fs.write'), '/srv/readonly/out.txt', WS)).toBeNull();
    expect(abilityFor(b, def('fs.read'), '/srv/readonly/in.txt', WS)).toBe('allow');
    expect(abilityFor(b, def('fs.write'), '/etc/hosts', WS)).toBeNull();
    expect(abilityFor(b, def('fs.write'), `${ws('b')}/note.md`, WS)).toBe('ask');
  });

  it('후보 순서: 협조 에이전트(할 수 있을 때) → 바로 가능 → 승인 필요 → 이름, 못 하는 에이전트는 빠짐', () => {
    const list = [
      agent('도', { 'shell.exec': rule('ask') }),
      agent('가', { 'shell.exec': rule('allow') }),
      agent('나', { 'shell.exec': rule('deny') }),
      agent('라', { 'shell.exec': rule('ask') }),
      agent('마', { 'shell.exec': rule('allow') }),
    ];
    const requester = agent('a', { 'shell.exec': rule('deny') });
    const names = (pref: string | null) => capableAgents(list, def('shell.exec'), 'npm test', { requester, preferredId: pref, workspaceOf: ws }).map(capableLabel);
    expect(names(null)).toEqual(['가(바로 가능)', '마(바로 가능)', '도(승인 필요)', '라(승인 필요)']);
    expect(names('라')).toEqual(['라(승인 필요 · 협조 에이전트)', '가(바로 가능)', '마(바로 가능)', '도(승인 필요)']);
    // 협조 에이전트라도 할 수 없으면 후보에 없습니다.
    expect(names('나')).toEqual(['가(바로 가능)', '마(바로 가능)', '도(승인 필요)', '라(승인 필요)']);
  });
});

describe('위임 목록의 할 수 있는 일 요약', () => {
  const defs = BASE_PERMISSIONS;

  it('허용 · 확인과 범위(두 개까지, 나머지는 개수), 못 하는 일, 폴더, 도구', () => {
    const b = agent(
      'b',
      {
        'fs.read': rule('allow'),
        'fs.write': rule('ask'),
        'shell.exec': rule('allow', ['npm *', 'git *', 'make *']),
        'pkg.install': rule('deny'),
        'net.fetch': rule('deny'),
        'web.search': rule('allow'),
        'screen.control': rule('deny'),
        'module.create': rule('allow'),
      },
      [{ path: '/Users/kim/work/shop', mode: 'write' }],
    );
    expect(abilitySummary(b, defs, ['GitHub', '이메일'], '/Users/kim')).toBe(
      '할 수 있음: 파일 읽기 허용, 파일 쓰기 확인, 셸 명령 허용(npm *, git * 외 1), 웹 검색 허용 · 못 함: 패키지 설치, HTTP 요청, 화면 제어 · 폴더: ~/work/shop(읽기·쓰기) · 도구: GitHub, 이메일',
    );
  });

  it('설정이 없는 권한은 확인으로, 할 수 있는 일이 하나도 없으면 없음', () => {
    expect(abilitySummary(agent('c', {}), defs, [], '/h')).toBe('할 수 있음: 파일 읽기 확인, 파일 쓰기 확인, 셸 명령 확인, 패키지 설치 확인, HTTP 요청 확인, 웹 검색 확인, 화면 제어 확인');
    const none = agent('d', Object.fromEntries(['fs.read', 'fs.write', 'shell.exec', 'pkg.install', 'net.fetch', 'web.search', 'screen.control'].map((k) => [k, rule('deny')])));
    expect(abilitySummary(none, defs, [], '/h')).toBe('할 수 있음: 없음 · 못 함: 파일 읽기, 파일 쓰기, 셸 명령, 패키지 설치, HTTP 요청, 웹 검색, 화면 제어');
  });

  it('막힌 동작 이름: 경로는 ~ 로 줄이고 길면 자름', () => {
    expect(blockedLabel({ permission: 'fs.write', label: '파일 쓰기', target: '/Users/kim/work/a.txt' }, '/Users/kim')).toBe('파일 쓰기 · ~/work/a.txt');
    expect(blockedLabel({ permission: 'screen.control', label: '화면 제어', target: null }, '/h')).toBe('화면 제어');
    expect(blockedLabel({ permission: 'shell.exec', label: '셸 명령', target: `echo ${'x'.repeat(100)}` }, '/h')).toMatch(/^셸 명령 · echo x+…$/);
  });
});
