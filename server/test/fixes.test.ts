import fs from 'node:fs';
import { getEventListeners } from 'node:events';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { sleep } from '../src/agents/runtime.ts';
import { LoginLimiter } from '../src/auth/limiter.ts';
import type { Config } from '../src/config/env.ts';
import { Db } from '../src/db/sqlite.ts';
import { Store } from '../src/db/store.ts';
import { wsKeepalive } from '../src/http/server.ts';
import { scanNodeModules } from '../src/modules/license.ts';
import { builtinTools, PIPE_GRACE_MS, type ToolServices } from '../src/tools/builtin.ts';
import type { ToolEnv } from '../src/tools/types.ts';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-fixes-'));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe('① 의존성 라이선스 검사: 자기 자신을 가리키는 링크', () => {
  /** npm 은 "a": "file:." 의존성마다 node_modules/a → .. 링크를 만듭니다. 예전에는 링크 2개만으로 경로가 2^32 개 가까이 늘어 서버가 멈췄습니다. */
  const mod = (links: number): string => {
    const dir = fs.mkdtempSync(path.join(tmp, 'mod-'));
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'm', version: '1.0.0', license: 'MIT' }));
    fs.mkdirSync(path.join(dir, 'node_modules'));
    for (let i = 0; i < links; i += 1) fs.symlinkSync('..', path.join(dir, 'node_modules', `self${i}`));
    return dir;
  };

  it('링크 3개짜리 순환도 바로 끝나고, 같은 패키지는 한 번만 셉니다', () => {
    const t = performance.now();
    const found = scanNodeModules(mod(3));
    expect(performance.now() - t).toBeLessThan(1000);
    expect(found.map((d) => `${d.name}@${d.version}`)).toEqual(['m@1.0.0']);
  });

  it('폴더 수 상한을 넘으면 이유를 담아 멈춥니다 (경계: 상한과 같으면 통과)', () => {
    const dir = fs.mkdtempSync(path.join(tmp, 'deps-'));
    const nm = path.join(dir, 'node_modules');
    // node_modules 3개: 맨 위 + 패키지 a, b 안의 중첩 node_modules
    for (const name of ['a', 'b']) {
      fs.mkdirSync(path.join(nm, name, 'node_modules'), { recursive: true });
      fs.writeFileSync(path.join(nm, name, 'package.json'), JSON.stringify({ name, version: '1.0.0', license: 'MIT' }));
    }
    expect(scanNodeModules(dir, 3)).toHaveLength(2);
    expect(() => scanNodeModules(dir, 2)).toThrow('의존성 폴더(node_modules)가 2개를 넘어');
  });
});

describe('② 셸 명령: 새 세션으로 빠져나간 백그라운드 프로세스가 출력 파이프를 쥐고 있을 때', () => {
  const services = {
    config: { shellTimeoutMs: 20_000, shellOutputMaxBytes: 1024 } as Config,
  } as unknown as ToolServices;
  const shell = builtinTools(services).find((t) => t.name === 'shell_exec');
  const ws = fs.mkdtempSync(path.join(tmp, 'ws-'));
  const env = (signal = new AbortController().signal): ToolEnv => ({ workspace: ws, signal }) as unknown as ToolEnv;
  const pidFile = path.join(tmp, 'held.pid');
  afterAll(() => {
    try {
      process.kill(Number(fs.readFileSync(pidFile, 'utf8')), 'SIGKILL');
    } catch {
      // 이미 끝남
    }
  });

  it('셸이 끝나면 잠깐 뒤 파이프를 끊고 결과를 돌려줍니다 (예전에는 그 프로세스가 끝날 때까지 영원히 기다림)', async () => {
    // perl 이 setsid 로 새 세션을 만들어 프로세스 그룹 종료로도 닿지 않습니다.
    const command = `perl -e 'use POSIX qw(setsid); setsid(); open(my $f, ">", "${pidFile}"); print $f $$; close($f); print "started\\n"; sleep 60' &`;
    const t = Date.now();
    const out = await shell!.run({ command }, env());
    const ms = Date.now() - t;
    expect(ms).toBeGreaterThanOrEqual(PIPE_GRACE_MS - 50);
    expect(ms).toBeLessThan(PIPE_GRACE_MS + 3000);
    expect(out).toContain('종료 코드 0');
    expect(out).toContain('백그라운드 프로세스가 출력을 붙잡고 있어');
    expect(out).toContain('명령 > app.log 2>&1 &');
  });

  it('보통 명령은 기다림 없이 끝나고 붙잡음 안내가 없습니다', async () => {
    const t = Date.now();
    const out = await shell!.run({ command: 'echo hi' }, env());
    expect(Date.now() - t).toBeLessThan(PIPE_GRACE_MS);
    expect(out).toContain('종료 코드 0');
    expect(out).not.toContain('붙잡고');
    expect(out).toContain('hi');
  });

  it('출력이 한도를 넘으면 마지막 조각에서 넘어도 잘렸다고 알립니다 (경계: 정확히 한도면 알리지 않음)', async () => {
    const over = await shell!.run({ command: 'head -c 3000 /dev/zero | tr "\\0" x' }, env());
    expect(over).toContain('출력이 1024바이트를 넘어 잘림');
    const exact = await shell!.run({ command: 'head -c 1024 /dev/zero | tr "\\0" x' }, env());
    expect(exact).not.toContain('잘림');
    expect(exact).toContain('x'.repeat(1024));
  });

  it('작업을 취소하면 바로 멈추고 취소 리스너를 남기지 않습니다', async () => {
    const ac = new AbortController();
    const run = shell!.run({ command: 'sleep 30' }, env(ac.signal));
    setTimeout(() => ac.abort(), 100);
    const out = await run;
    expect(out).toContain('작업이 취소되어 명령을 멈췄습니다');
    expect(getEventListeners(ac.signal, 'abort')).toHaveLength(0);
  });
});

describe('⑩ 로그인 실패 제한', () => {
  it('시간 창이 지나면 실패 횟수를 처음부터 셉니다 (몇 달 전 오타가 쌓이지 않음)', () => {
    const l = new LoginLimiter(3, 60_000, 60_000);
    l.fail('1.1.1.1', 0);
    l.fail('1.1.1.1', 1000);
    // 창 끝(정확히 60초 뒤)부터는 지난 기록
    expect(l.fail('1.1.1.1', 60_000)).toMatchObject({ locked: false, remaining: 2 });
  });

  it('창 안에서는 그대로 쌓여 잠깁니다', () => {
    const l = new LoginLimiter(3, 60_000, 60_000);
    l.fail('1.1.1.1', 0);
    l.fail('1.1.1.1', 1000);
    expect(l.fail('1.1.1.1', 59_999)).toMatchObject({ locked: true });
    expect(l.check('1.1.1.1', 60_000 + 59_998)).toMatchObject({ locked: true });
  });

  it('주소가 끝없이 늘어도 기록 수는 상한을 넘지 않고, 지난 기록부터 지웁니다', () => {
    const l = new LoginLimiter(5, 60_000, 60_000, 100);
    for (let i = 0; i < 1000; i += 1) l.fail(`10.0.${Math.floor(i / 250)}.${i % 250}`, i);
    expect(l.size).toBe(100);
    // 창이 지난 뒤 새 주소가 오면 지난 기록을 먼저 치웁니다.
    l.fail('9.9.9.9', 1_000_000);
    expect(l.size).toBe(1);
  });

  it('가득 차면 지난 기록부터, 그다음 잠기지 않은 기록을 지우고 잠긴 기록은 남깁니다', () => {
    const l = new LoginLimiter(2, 600_000, 1000, 3);
    l.fail('locked', 0);
    l.fail('locked', 0); // 2번 틀려 잠김 (10분)
    l.fail('a', 0);
    l.fail('b', 0);
    l.fail('c', 500); // a · b 는 아직 창(1초) 안 → 잠기지 않은 것 중 먼저 들어온 a 를 지움
    expect(l.size).toBe(3);
    expect(l.check('locked', 500)).toMatchObject({ locked: true });
    expect(l.fail('a', 600)).toMatchObject({ remaining: 1 });
  });

  it('모두 잠겨 있으면 먼저 들어온 기록부터 지웁니다 (기억하는 양은 늘지 않음)', () => {
    const l = new LoginLimiter(1, 600_000, 1000, 2);
    l.fail('x', 0);
    l.fail('y', 0);
    l.fail('z', 0);
    expect(l.size).toBe(2);
    expect(l.check('x', 1)).toMatchObject({ locked: false });
    expect(l.check('z', 1)).toMatchObject({ locked: true });
  });
});

describe('⑪ 실시간 연결 확인', () => {
  const sock = (open = true) => {
    const calls: string[] = [];
    return { calls, s: { readyState: open ? 1 : 3, OPEN: 1, ping: () => calls.push('ping'), terminate: () => calls.push('terminate') } };
  };

  it('답이 있던 연결: 다시 확인을 보내고 답을 기다리는 상태로 바꿉니다', () => {
    const { calls, s } = sock();
    const state = { alive: true };
    expect(wsKeepalive(state, s)).toBe('pinged');
    expect(state.alive).toBe(false);
    expect(calls).toEqual(['ping']);
  });

  it('지난 확인에 답이 없던 연결: 끊습니다 (끊긴 줄 모르고 이벤트를 쌓지 않게)', () => {
    const { calls, s } = sock();
    expect(wsKeepalive({ alive: false }, s)).toBe('terminated');
    expect(calls).toEqual(['terminate']);
  });

  it('이미 닫힌 연결은 건드리지 않습니다', () => {
    const { calls, s } = sock(false);
    expect(wsKeepalive({ alive: false }, s)).toBe('skipped');
    expect(calls).toEqual([]);
  });
});

describe('⑫ 재시도 대기: 다 기다리면 취소 리스너를 뗍니다', () => {
  it('정상으로 끝난 대기 100번 뒤에도 리스너가 쌓이지 않습니다', async () => {
    const ac = new AbortController();
    for (let i = 0; i < 100; i += 1) await sleep(0, ac.signal);
    expect(getEventListeners(ac.signal, 'abort')).toHaveLength(0);
  });

  it('취소되면 바로 깨고, 이미 취소된 신호면 기다리지 않습니다', async () => {
    const ac = new AbortController();
    const t = Date.now();
    const p = sleep(10_000, ac.signal);
    ac.abort();
    await p;
    await sleep(10_000, ac.signal);
    expect(Date.now() - t).toBeLessThan(500);
  });
});

describe('⑨ 활동 기록 보관 개수 · 대화 기록 나눠 읽기', () => {
  const store = new Store(new Db(':memory:'));
  let serial = 0;
  const add = (n: number): void => {
    for (let i = 0; i < n; i += 1) {
      serial += 1;
      store.addActivity({ type: 't', category: 'system', tone: 'pass', who: 'x', text: `${serial}`, agentId: null, moduleId: null, data: null });
    }
  };
  const count = (): number => store.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM activity')?.n ?? -1;

  it('설정하는 순간 넘치는 것을 지우고, 그 뒤로는 100건마다 keep 개만 남깁니다', () => {
    add(250);
    store.configureActivity(120);
    expect(count()).toBe(120);
    add(99);
    expect(count()).toBe(219);
    add(1);
    // 100번째 넣을 때 정리: 정확히 keep 개 (가장 최근 것)
    expect(count()).toBe(120);
    // 남는 것은 가장 최근 120건: 250 + 99 + 1 = 350번째까지 중 231~350번째
    expect(store.listActivity(1)[0]?.text).toBe('350');
    expect(store.listActivity(500).at(-1)?.text).toBe('231');
  });

  it('타임라인: before 보다 앞의 것 중 마지막 limit 개를 시간 순서로', () => {
    store.db.run("INSERT INTO api_keys (id, label, source, cipher, last4, created_at) VALUES ('k', 'k', 'stored', 'x', '0000', 0)");
    store.db.run(
      "INSERT INTO agents (id, name, color, model, key_id, preset, permissions, limits, created_at, updated_at) VALUES ('a', 'a', '#000000', 'm', 'k', 'p', '{}', '{}', 0, 0)",
    );
    const thread = store.getOrCreateThread('a', 'console', '웹 콘솔');
    const ids = Array.from({ length: 10 }, (_, i) => store.addTimeline(thread.id, null, 'user', { text: `${i}` }).id);
    expect(store.listTimeline(thread.id, 3).map((r) => r.data['text'])).toEqual(['7', '8', '9']);
    expect(store.listTimeline(thread.id, 3, ids[7]).map((r) => r.data['text'])).toEqual(['4', '5', '6']);
    // 경계: 맨 앞보다 앞은 비어 있고, 남은 것이 limit 보다 적으면 있는 만큼만
    expect(store.listTimeline(thread.id, 3, ids[0])).toEqual([]);
    expect(store.listTimeline(thread.id, 3, ids[2]).map((r) => r.data['text'])).toEqual(['0', '1']);
  });
});
