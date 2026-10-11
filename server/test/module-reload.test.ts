import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseManifest } from '../src/modules/manifest.ts';
import { startHarness, type Harness } from './helpers/harness.ts';

// 기본 제공 모듈은 프로세스를 새로 띄울 때(다시 시작 · 켜기 · 처음 호출 · 비정상 종료 뒤) module.json 을 다시 읽어,
// 서버를 끄지 않아도 바뀐 설정 칸 · 도구 · 허용 도메인을 반영합니다. 직접 설치한 모듈은 승인받은 내용을 그대로 씁니다.

const repoRoot = path.resolve(import.meta.dirname, '..', '..');
const meta = { agentId: null, agentName: null, taskId: null };
let h: Harness;
let mods: string;
let blankDir: string;
const template = JSON.parse(fs.readFileSync(path.join(repoRoot, 'templates', 'blank', 'module.json'), 'utf8')) as Record<string, unknown> & { tools: unknown[] };

function writeManifest(version: string, extra: Record<string, unknown> = {}): void {
  fs.writeFileSync(path.join(blankDir, 'module.json'), JSON.stringify({ ...template, version, ...extra }));
}
const row = () => h.app.store.getModule('blank');
const updates = () => h.app.store.listActivity(200).filter((a) => a.type === 'module.updated' && a.moduleId === 'blank').map((a) => a.text);

beforeAll(async () => {
  mods = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'sb-mods-')));
  blankDir = path.join(mods, 'blank');
  fs.cpSync(path.join(repoRoot, 'templates', 'blank'), blankDir, { recursive: true });
  fs.appendFileSync(path.join(blankDir, 'index.js'), '\n');
  h = await startHarness({ MODULES_DIR: mods });
});
afterAll(async () => {
  await h.app.registry.shutdown();
  await h.close();
  fs.rmSync(mods, { recursive: true, force: true });
});

describe('기본 모듈의 module.json 다시 읽기', () => {
  it('다시 시작하면 바뀐 설정 칸 · 도구를 서버를 끄지 않고 반영하고, 활동에 버전을 남깁니다', async () => {
    expect(row().manifest.version).toBe('0.1.0');
    const echo2 = { name: 'echo2', description: '두 번째 도구', input_schema: { type: 'object' } };
    writeManifest('0.2.0', { env: [{ name: 'BLANK_GREETING', label: '인사말', required: false, secret: false }], tools: [...template.tools, echo2] });
    await h.app.registry.restart('blank');
    expect(row().manifest).toMatchObject({ version: '0.2.0', env: [{ name: 'BLANK_GREETING', label: '인사말' }] });
    expect(row().manifest.tools.map((t) => t.name)).toEqual(['echo', 'echo2']);
    expect(h.app.registry.toolOwners().get('echo2')).toBe('blank');
    expect(h.app.settings.moduleFields(row()).map((f) => f.name)).toEqual(['BLANK_GREETING']);
    expect(updates()[0]).toBe('module.json 다시 읽음 · v0.1.0 → v0.2.0');
  });

  it('바뀐 것이 없으면 다시 저장하거나 활동을 남기지 않습니다', async () => {
    const before = updates().length;
    await h.app.registry.restart('blank');
    expect(updates()).toHaveLength(before);
  });

  it('켤 때도 반영합니다', async () => {
    await h.app.registry.setEnabled('blank', false);
    writeManifest('0.3.0');
    await h.app.registry.setEnabled('blank', true);
    expect(row()).toMatchObject({ enabled: true, manifest: { version: '0.3.0' } });
  });

  it('도구를 불러 처음 띄울 때도 최신 module.json 으로 뜹니다 (실제 모듈 프로세스)', async () => {
    writeManifest('0.4.0');
    expect(await h.app.registry.callTool('blank', 'echo', { text: 'hi' }, meta)).toBe('받은 내용: hi');
    expect(row().manifest.version).toBe('0.4.0');
  }, 30_000);

  it('module.json 이 깨졌거나 id 가 바뀌면 다시 시작하지 않고 이유를 알립니다 (돌던 모듈은 그대로)', async () => {
    fs.writeFileSync(path.join(blankDir, 'module.json'), '{ "id": "blank", ');
    await expect(h.app.registry.restart('blank')).rejects.toThrow("'빈 모듈'의 module.json 을 다시 읽지 못해 시작하지 않았습니다:");
    expect(row().manifest.version).toBe('0.4.0');
    // 멈추지 않았으니 예전 버전으로 계속 답합니다.
    expect(await h.app.registry.callTool('blank', 'echo', { text: 'still' }, meta)).toBe('받은 내용: still');

    writeManifest('0.5.0', { id: 'other' });
    await expect(h.app.registry.restart('blank')).rejects.toThrow("'빈 모듈'의 module.json id 가 'other'(으)로 바뀌어 시작하지 않았습니다. 기본 모듈의 id 는 바꿀 수 없습니다 (지금 'blank').");
    expect(row().manifest.version).toBe('0.4.0');
  }, 30_000);

  it('꺼진 뒤 새로 띄울 때 module.json 이 깨졌으면 시작하지 않고 모듈 상태에 이유를 남깁니다', async () => {
    await h.app.registry.host('blank').stop('user');
    fs.writeFileSync(path.join(blankDir, 'module.json'), 'not json');
    await expect(h.app.registry.callTool('blank', 'echo', { text: 'x' }, meta)).rejects.toThrow('module.json 을 다시 읽지 못해 시작하지 않았습니다');
    expect(row()).toMatchObject({ status: 'failed' });
    expect(row().statusDetail).toContain('module.json 을 다시 읽지 못해 시작하지 않았습니다');
    writeManifest('0.6.0');
  });

  it('직접 설치한 모듈(zip)은 다시 시작해도 승인받은 module.json 을 그대로 씁니다', async () => {
    const dir = fs.mkdtempSync(path.join(mods, 'zip-'));
    fs.cpSync(path.join(repoRoot, 'templates', 'blank'), dir, { recursive: true });
    const approved = parseManifest({ ...template, id: 'zipped', name: '압축 모듈', version: '1.0.0', tools: [{ ...(template.tools[0] as object), name: 'zipped_echo', handler: 'echo' }] }, 'test');
    fs.writeFileSync(path.join(dir, 'module.json'), JSON.stringify(approved));
    h.app.store.upsertModule({ id: 'zipped', kind: 'module', origin: 'zip', dir, manifest: approved, enabled: true, status: 'idle', statusDetail: null, createdBy: null, report: null });
    fs.writeFileSync(path.join(dir, 'module.json'), JSON.stringify({ ...approved, version: '9.9.9', permissions: { net: ['*'], fsWrite: true, childProcess: true } }));
    await h.app.registry.restart('zipped');
    expect(h.app.store.getModule('zipped').manifest).toMatchObject({ version: '1.0.0', permissions: { net: [], childProcess: false } });
  });
});
