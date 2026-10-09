import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeImapFlow, server } from './helpers/fake-imap.ts';
import type { InboundMessage } from '../src/modules/protocol.ts';

// 이메일 모듈의 연결 · 감시 · 알림 · 도구를 가짜 IMAP 으로 돌립니다 (본문 해석은 실제 mailparser, 상태 파일은 실제 디스크).
vi.mock('imapflow', async () => {
  const m = await import('./helpers/fake-imap.ts');
  return { ImapFlow: m.FakeImapFlow };
});

type EmailModule = {
  activate(ctx: unknown): Promise<void>;
  deactivate(): Promise<void>;
  tools: { email_search(input: unknown): Promise<string>; email_read(input: unknown): Promise<string> };
};

let mod: EmailModule;
let dataDir: string;
let emitted: InboundMessage[] = [];
let logs: string[] = [];
const PASSWORD = 'app-pass-1234';
const baseEnv = { EMAIL_IMAP_HOST: 'imap.gmail.com', EMAIL_USER: 'me@example.com', EMAIL_PASSWORD: PASSWORD };

function ctx(env: Record<string, string> = baseEnv) {
  return {
    id: 'email',
    env,
    dataDir,
    log: { info: (m: string) => logs.push(`info ${m}`), warn: (m: string) => logs.push(`warn ${m}`), error: (m: string) => logs.push(`error ${m}`) },
    emit: (m: InboundMessage) => emitted.push(m),
    fetch,
    meta: null,
  };
}

const statePath = (): string => path.join(dataDir, 'state.json');
const readState = (): { mailbox: string; uidValidity: string; lastUid: number } => JSON.parse(fs.readFileSync(statePath(), 'utf8'));
const client = (): FakeImapFlow => FakeImapFlow.instances[FakeImapFlow.instances.length - 1] as FakeImapFlow;

beforeAll(async () => {
  mod = (await import('../../modules/email/index.js')).default as unknown as EmailModule;
});

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-email-'));
  server.reset();
  emitted = [];
  logs = [];
});

afterEach(async () => {
  await mod.deactivate();
  vi.useRealTimers();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

afterAll(() => {
  vi.restoreAllMocks();
});

/** 시작 직후의 첫 확인(기준점 잡기)까지 */
async function start(env?: Record<string, string>): Promise<void> {
  await mod.activate(ctx(env));
  await vi.waitFor(() => expect(fs.existsSync(statePath())).toBe(true));
}

describe('처음 켤 때', () => {
  it('지금 있는 메일은 알리지 않고 기준점만 잡으며, 편지함은 읽기 전용으로 엽니다', async () => {
    server.add('예전 메일 1');
    server.add('예전 메일 2');
    server.add('예전 메일 3');
    await start();
    expect(readState()).toEqual({ mailbox: 'INBOX', uidValidity: '100', lastUid: 3 });
    expect(emitted).toEqual([]);
    expect(client().openedReadOnly).toBe(true);
    expect(logs.some((l) => l.includes('지금 있는 메일은 건너뛰고'))).toBe(true);
  });

  it('로그인 거부는 고칠 곳을 알려 주고 비밀번호는 드러내지 않습니다', async () => {
    server.failAuth = true;
    const err = await mod.activate(ctx()).then(
      () => null,
      (e: Error) => e,
    );
    expect(err?.message).toContain('EMAIL_PASSWORD');
    expect(err?.message).toContain('앱 비밀번호');
    expect(err?.message).toContain('Invalid credentials');
    expect(err?.message).not.toContain(PASSWORD);
  });

  it('없는 편지함은 이름을 짚어 알려 줍니다', async () => {
    const err = await mod.activate(ctx({ ...baseEnv, EMAIL_MAILBOX: 'Nope' })).then(
      () => null,
      (e: Error) => e,
    );
    expect(err?.message).toContain("편지함 'Nope'이(가) 서버에 없습니다");
  });
});

describe('새 메일', () => {
  it('도착하면 잠깐 모았다가 조용한 알림 하나로 넘기고, 기준점을 옮깁니다', async () => {
    server.add('예전 메일');
    await start();
    server.add('결제 실패 안내', { text: '카드 승인이 거절되었습니다. 결제 수단을 확인하세요.', attachment: '영수증.pdf' });
    client().notifyExists();
    // 2초 모으는 동안 다른 메일이 오면 한 알림으로 묶입니다.
    await vi.advanceTimersByTimeAsync(1000);
    server.add('회의 일정 변경');
    client().notifyExists();
    await vi.advanceTimersByTimeAsync(1500);
    await vi.waitFor(() => expect(emitted).toHaveLength(1));

    const n = emitted[0] as InboundMessage;
    expect(n).toMatchObject({ target: 'INBOX', targetLabel: '받은편지함', userId: 'email', direct: true, quiet: true });
    expect(n.text.split('\n')[0]).toBe('[새 메일 2통 · 받은편지함]');
    expect(n.text).toContain('제목: 결제 실패 안내');
    expect(n.text).toContain('보낸 사람: Boss <boss@example.com>');
    expect(n.text).toContain('첨부 1개: 영수증.pdf');
    expect(n.text).toContain('미리보기: 카드 승인이 거절되었습니다.');
    expect(readState().lastUid).toBe(3);
    // 미리보기는 앞부분만 받아 옵니다.
    const preview = client().fetches.find((f) => typeof f.query['source'] === 'object');
    expect(preview?.query['source']).toEqual({ maxLength: 64 * 1024 });
  });

  it('새 메일이 없는데 EXISTS 가 와도(n:* 가 마지막 메일을 돌려줌) 알리지 않습니다', async () => {
    server.add('하나');
    server.add('둘');
    await start();
    client().emit('exists', { path: 'INBOX', count: 3, prevCount: 2 });
    await vi.advanceTimersByTimeAsync(2500);
    await vi.waitFor(() => expect(client().fetches.some((f) => f.range === '3:*')).toBe(true));
    expect(emitted).toEqual([]);
    expect(readState().lastUid).toBe(2);
  });

  it('한꺼번에 많이 오면 최근 10통만 자세히, 나머지는 개수와 uid 범위로', async () => {
    await start();
    for (let i = 1; i <= 12; i += 1) server.add(`메일 ${i}`);
    client().notifyExists();
    await vi.advanceTimersByTimeAsync(2500);
    await vi.waitFor(() => expect(emitted).toHaveLength(1));
    const text = (emitted[0] as InboundMessage).text;
    expect(text.split('\n')[0]).toBe('[새 메일 12통 · 받은편지함]');
    expect(text).toContain('그 밖에 먼저 온 메일 2통 (uid 1~2)');
    expect(text).not.toContain('제목: 메일 2\n');
    expect(text).toContain('제목: 메일 12');
    const preview = client().fetches.find((f) => typeof f.query['source'] === 'object');
    expect(preview?.range.split(',')).toHaveLength(10);
  });

  it('꺼져 있던 동안 온 메일은 다시 켤 때 알립니다', async () => {
    server.add('예전');
    await start();
    await mod.deactivate();
    server.add('꺼진 동안 1');
    server.add('꺼진 동안 2');
    await mod.activate(ctx());
    await vi.waitFor(() => expect(emitted).toHaveLength(1));
    expect((emitted[0] as InboundMessage).text.split('\n')[0]).toBe('[새 메일 2통 · 받은편지함]');
  });

  it('서버가 UID 를 새로 매기면(UIDVALIDITY 변경) 쏟아내지 않고 기준점을 다시 잡습니다', async () => {
    server.add('a');
    await start();
    await mod.deactivate();
    server.uidValidity = 200n;
    server.add('b');
    server.add('c');
    await mod.activate(ctx());
    await vi.waitFor(() => expect(readState().uidValidity).toBe('200'));
    expect(readState().lastUid).toBe(3);
    expect(emitted).toEqual([]);
    expect(logs.some((l) => l.startsWith('warn') && l.includes('UIDVALIDITY'))).toBe(true);
  });
});

describe('연결이 끊길 때', () => {
  it('5초 뒤 다시 연결하고, 다시 연결한 뒤 온 메일도 알립니다', async () => {
    await start();
    const first = client();
    first.close();
    await vi.advanceTimersByTimeAsync(5000);
    await vi.waitFor(() => expect(FakeImapFlow.instances).toHaveLength(2));
    await vi.waitFor(() => expect(logs.some((l) => l.includes('다시 연결했습니다'))).toBe(true));
    server.add('재연결 뒤 메일');
    client().notifyExists();
    await vi.advanceTimersByTimeAsync(2500);
    await vi.waitFor(() => expect(emitted).toHaveLength(1));
  });

  it('다시 연결할 때 로그인이 거부되면 계속 시도하지 않고 프로세스를 끝냅니다 (계정 잠김 방지)', async () => {
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    try {
      await start();
      server.failAuth = true;
      client().close();
      await vi.advanceTimersByTimeAsync(5000);
      await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(1));
      expect(logs.some((l) => l.startsWith('error') && l.includes('로그인을 거부'))).toBe(true);
    } finally {
      exit.mockRestore();
    }
  });

  it('끈 뒤에는 다시 연결하지 않습니다', async () => {
    await start();
    await mod.deactivate();
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(FakeImapFlow.instances).toHaveLength(1);
  });
});

describe('도구', () => {
  it('email_search: 조건이 없으면 최근 메일을 최근 것부터, 조건이 있으면 검색', async () => {
    server.add('첫째');
    server.add('결제 안내');
    server.add('셋째', { seen: true });
    await start();
    const recent = await mod.tools.email_search({ limit: 2 });
    expect(recent.split('\n')[0]).toBe("'받은편지함'의 최근 메일 2통 (전체 3통). 본문은 email_read 에 uid 를 넣어 읽으세요.");
    expect(recent.split('\n').slice(1).map((l) => /uid (\d+)/.exec(l)?.[1])).toEqual(['3', '2']);
    const found = await mod.tools.email_search({ subject: '결제' });
    expect(found).toContain('uid 2');
    expect(found).not.toContain('uid 1 ');
    await expect(mod.tools.email_search({ since: '2026-02-30' })).rejects.toThrow('달력에 없는 날짜');
  });

  it('email_read: 본문 · 첨부를 읽고, 없는 uid 는 다시 찾으라고 알려 줍니다', async () => {
    server.add('계약서', { text: '첨부한 계약서를 검토해 주세요.', attachment: 'contract.pdf' });
    await start();
    const out = await mod.tools.email_read({ uid: 1 });
    expect(out).toContain('[메일 uid 1 · 받은편지함]');
    expect(out).toContain('첨부 1개: contract.pdf (application/pdf');
    expect(out).toContain('첨부한 계약서를 검토해 주세요.');
    expect(out).toMatch(/<<<본문 ([0-9a-f]{8})>>>[\s\S]*<<<본문 끝 \1>>>/);
    // 모듈이 직접 판단한 오류는 '메일 서버 오류'로 감싸지 않고 그대로 돌려줍니다.
    await expect(mod.tools.email_read({ uid: 999 })).rejects.toThrow(/^uid 999 메일이 '받은편지함'에 없습니다/);
    await expect(mod.tools.email_read({ uid: 0 })).rejects.toThrow('uid 는 1 이상의 정수');
  });

  it('연결이 끊긴 동안 도구를 부르면 다시 연결 중이라고 알려 줍니다', async () => {
    await start();
    client().close();
    await expect(mod.tools.email_search({})).rejects.toThrow('다시 연결하는 중');
  });
});
