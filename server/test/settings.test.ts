import { describe, expect, it } from 'vitest';
import type { Config } from '../src/config/env.ts';
import { encryptSecret } from '../src/crypto/secrets.ts';
import { Db } from '../src/db/sqlite.ts';
import { Store, type ModuleRow } from '../src/db/store.ts';
import { parseManifest } from '../src/modules/manifest.ts';
import { isSecretField, SettingsService } from '../src/settings/service.ts';

const KEY = Buffer.alloc(32, 7);
const OTHER_KEY = Buffer.alloc(32, 8);

function setup(env: Record<string, string | undefined> = {}) {
  const store = new Store(new Db(':memory:'));
  const config = { secretsKey: KEY, adminPassword: 'x'.repeat(12), sessionSecret: 's'.repeat(40), anthropicApiKey: null } as unknown as Config;
  const settings = new SettingsService({ config, store, env: () => env });
  const manifest = parseManifest(
    {
      id: 'mailer',
      name: '메일',
      version: '1.0.0',
      license: 'MIT',
      channel: { label: '메일', send: false },
      env: [
        { name: 'MAIL_HOST', label: '서버', required: true, secret: false },
        { name: 'MAIL_PASSWORD', label: '비밀번호', required: true },
        { name: 'MAIL_PORT', required: false },
      ],
    },
    'test',
  );
  const row: ModuleRow = store.upsertModule({ id: manifest.id, kind: 'module', origin: 'builtin', dir: '/tmp/x', manifest, enabled: true, status: 'stopped', statusDetail: null, createdBy: null, report: null });
  return { store, settings, row, env };
}

describe('비밀값 판별', () => {
  it.each([
    ['DISCORD_BOT_TOKEN', undefined, true],
    ['EMAIL_PASSWORD', undefined, true],
    ['NOTION_API_KEY', undefined, true],
    ['SOME_SECRET', undefined, true],
    ['EMAIL_IMAP_HOST', undefined, false],
    ['EMAIL_MAILBOX', undefined, false],
    ['COMPUTER_MAX_EDGE', undefined, false],
    ['DISCORD_BOT_TOKEN', false, false],
    ['EMAIL_USER', true, true],
  ])('%s (secret=%s) → %s', (name, secret, expected) => {
    expect(isSecretField({ name, secret })).toBe(expected);
  });
});

describe('모듈 설정 저장 · 읽기', () => {
  it('비밀값은 암호화해 두고 끝 4자리만 따로, 일반 값은 그대로 둡니다', () => {
    const { store, settings, row } = setup();
    settings.saveModule(row, { MAIL_HOST: ' imap.example.com ', MAIL_PASSWORD: 'app-password-1234' });
    const saved = new Map(store.listModuleSettings(row.id).map((r) => [r.name, r]));
    expect(saved.get('MAIL_HOST')).toMatchObject({ value: 'imap.example.com', cipher: null });
    expect(saved.get('MAIL_PASSWORD')?.value).toBeNull();
    expect(saved.get('MAIL_PASSWORD')?.cipher).not.toContain('app-password');
    expect(saved.get('MAIL_PASSWORD')?.last4).toBe('1234');
    expect(settings.resolveModule(row.manifest)).toEqual({ values: { MAIL_HOST: 'imap.example.com', MAIL_PASSWORD: 'app-password-1234' }, missing: [], problems: [] });
  });

  it('DB 값이 .env 값보다 먼저이고, DB 값을 지우면 .env 값으로 돌아갑니다', () => {
    const { settings, row } = setup({ MAIL_HOST: 'env.example.com', MAIL_PASSWORD: 'env-pass' });
    expect(settings.resolveModule(row.manifest).values).toEqual({ MAIL_HOST: 'env.example.com', MAIL_PASSWORD: 'env-pass' });
    settings.saveModule(row, { MAIL_HOST: 'db.example.com' });
    expect(settings.resolveModule(row.manifest).values['MAIL_HOST']).toBe('db.example.com');
    settings.saveModule(row, { MAIL_HOST: null });
    expect(settings.resolveModule(row.manifest).values['MAIL_HOST']).toBe('env.example.com');
    settings.saveModule(row, { MAIL_HOST: '   ' });
    expect(settings.resolveModule(row.manifest).values['MAIL_HOST']).toBe('env.example.com');
  });

  it('필수 값이 없으면 이름을, 저장한 비밀값을 풀 수 없으면(SECRETS_KEY 바뀜) 정확한 이유를 돌려줍니다', () => {
    const { store, settings, row } = setup();
    expect(settings.resolveModule(row.manifest).missing).toEqual(['MAIL_HOST', 'MAIL_PASSWORD']);
    store.setModuleSetting(row.id, 'MAIL_PASSWORD', { value: null, cipher: encryptSecret('old', OTHER_KEY), last4: 'old' });
    const r = settings.resolveModule(row.manifest);
    expect(r.problems).toEqual([expect.stringContaining("저장된 '비밀번호'(MAIL_PASSWORD)을(를) 풀 수 없습니다. SECRETS_KEY 가 저장할 때와 달라졌습니다")]);
    expect(settings.moduleFields(row).find((f) => f.name === 'MAIL_PASSWORD')?.source).toBe('locked');
    expect(settings.missingFields(row)).toEqual(['MAIL_HOST', 'MAIL_PASSWORD']);
  });

  it('하나라도 잘못되면 아무것도 저장하지 않습니다', () => {
    const { store, settings, row } = setup();
    expect(() => settings.saveModule(row, { MAIL_HOST: 'ok.example.com', MAIL_PORT: 'a\nb' })).toThrow("'MAIL_PORT' 값에 줄바꿈이나 NUL 문자를 넣을 수 없습니다");
    expect(() => settings.saveModule(row, { MAIL_HOST: 'ok', NOPE: 'x' })).toThrow("'메일' 모듈에는 'NOPE' 설정이 없습니다");
    expect(() => settings.saveModule(row, { MAIL_PORT: 993 })).toThrow('값은 문자열이어야 합니다');
    expect(() => settings.saveModule(row, { MAIL_PORT: 'x'.repeat(4001) })).toThrow('4,000자까지');
    expect(() => settings.saveModule(row, ['MAIL_HOST'])).toThrow('{ 이름: 값 } 형태의 객체');
    expect(store.listModuleSettings(row.id)).toEqual([]);
    expect(settings.saveModule(row, { MAIL_PORT: 'x'.repeat(4000) })).toEqual(['MAIL_PORT']);
  });

  it('화면에 보일 상태: 비밀값은 값 대신 끝 4자리, .env 에도 남았으면 표시', () => {
    const { settings, row } = setup({ MAIL_PASSWORD: 'env-secret-9876', MAIL_PORT: '993' });
    settings.saveModule(row, { MAIL_PORT: '143' });
    const f = new Map(settings.moduleFields(row).map((x) => [x.name, x]));
    expect(f.get('MAIL_HOST')).toMatchObject({ source: 'empty', value: null, required: true });
    expect(f.get('MAIL_PASSWORD')).toMatchObject({ source: 'env', value: null, last4: '9876', secret: true });
    expect(f.get('MAIL_PORT')).toMatchObject({ source: 'db', value: '143', envAlso: true });
  });

  it('.env 에서 DB 로 옮기기: .env 에만 있는 값만, 비밀값은 암호화해서', () => {
    const { store, settings, row } = setup({ MAIL_HOST: 'env.example.com', MAIL_PASSWORD: 'env-secret-9876' });
    settings.saveModule(row, { MAIL_HOST: 'db.example.com' });
    expect(settings.importModuleEnv(row)).toEqual(['MAIL_PASSWORD']);
    expect(settings.moduleFields(row).map((x) => x.source)).toEqual(['db', 'db', 'empty']);
    expect(store.listModuleSettings(row.id).find((r) => r.name === 'MAIL_HOST')?.value).toBe('db.example.com');
    expect(settings.importModuleEnv(row)).toEqual([]);
  });

  it('기본 금지 조항이 비교할 비밀값: 비밀 항목만 (서버 주소 같은 일반 값은 넣지 않아 오탐이 없음)', () => {
    const { settings, row } = setup({ MAIL_HOST: 'imap.example.com' });
    settings.saveModule(row, { MAIL_PASSWORD: 'db-secret-1234' });
    expect(settings.secretValues([row])).toEqual(['db-secret-1234']);
  });
});

describe('훅 값 ($env:이름)', () => {
  it('화면에서 넣은 값이 먼저, 지우면 .env', () => {
    const { store, settings } = setup({ QUIET_HOURS: '22:00-08:00' });
    expect(settings.hookVar('QUIET_HOURS')).toBe('22:00-08:00');
    settings.setHookVar('QUIET_HOURS', ' 01:00-02:00 ');
    expect(settings.hookVar('QUIET_HOURS')).toBe('01:00-02:00');
    store.deleteHookVar('QUIET_HOURS');
    expect(settings.hookVar('QUIET_HOURS')).toBe('22:00-08:00');
    expect(settings.hookVar('NONE')).toBeUndefined();
  });

  it.each([
    ['quiet', '1'],
    ['1ABC', '1'],
    [`A${'B'.repeat(64)}`, '1'],
  ])('이름 %s 는 거절', (name, value) => {
    expect(() => setup().settings.setHookVar(name, value)).toThrow('훅 값 이름은');
  });

  it('값: 비었거나 · 1,000자 넘거나 · 줄바꿈이면 거절 (경계: 1,000자는 받음)', () => {
    const { settings } = setup();
    expect(() => settings.setHookVar('A', ' ')).toThrow('비어 있습니다');
    expect(() => settings.setHookVar('A', 'x'.repeat(1001))).toThrow('1,000자까지');
    expect(() => settings.setHookVar('A', 'a\nb')).toThrow('줄바꿈');
    settings.setHookVar('A', 'x'.repeat(1000));
    expect(settings.hookVar('A')).toHaveLength(1000);
  });

  it('훅이 쓰는 값 목록과 출처, .env 에만 있는 값 옮기기', () => {
    const { store, settings } = setup({ QUIET_HOURS: '22:00-08:00' });
    store.saveHook({ id: 'h1', name: '야간 발송 보류', event: 'before_send', enabled: true, action: 'deny', conditions: [{ field: 'now', op: 'in_window', value: '$env:QUIET_HOURS' }, { field: 'text', op: 'contains', value: '$env:MISSING' }], reason: 'r', modify: null });
    expect(settings.hookVars()).toEqual([
      { name: 'MISSING', value: null, source: 'empty', usedBy: ['야간 발송 보류'] },
      { name: 'QUIET_HOURS', value: '22:00-08:00', source: 'env', usedBy: ['야간 발송 보류'] },
    ]);
    expect(settings.importHookVars()).toEqual(['QUIET_HOURS']);
    expect(settings.hookVars().find((v) => v.name === 'QUIET_HOURS')?.source).toBe('db');
  });
});

describe('.env 읽기 전용 보기', () => {
  it('비밀값은 값을 보이지 않고 설정됨만, SECRETS_KEY 는 지문 앞 8자리, 새 항목은 표시', () => {
    const { settings } = setup();
    const items = settings.envGroups().flatMap((g) => g.items);
    const by = new Map(items.map((i) => [i.key, i]));
    expect(by.get('ADMIN_PASSWORD')?.value).toBe('설정됨');
    expect(by.get('SESSION_SECRET')?.value).toBe('설정됨');
    expect(by.get('SECRETS_KEY')?.value).toMatch(/^설정됨 · [0-9a-f]{4} [0-9a-f]{4}$/);
    expect(by.get('ANTHROPIC_API_KEY')).toMatchObject({ value: '비어 있음', tone: 'muted' });
    expect(items.filter((i) => i.isNew).map((i) => i.key).sort()).toEqual(['ACTIVITY_KEEP', 'AGENT_QUEUE_MAX', 'DELEGATION_MAX_ROUNDS']);
    expect(JSON.stringify(items)).not.toContain('xxxxxxxxxxxx');
  });
});
