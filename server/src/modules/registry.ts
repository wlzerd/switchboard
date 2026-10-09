import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Config } from '../config/env.ts';
import type { InstallReport, ModuleOrigin, ModuleRow, ModuleStatus, Store } from '../db/store.ts';
import { ConflictError, ModuleError } from '../errors.ts';
import type { EventBus } from '../events/bus.ts';
import type { Logger } from '../log.ts';
import { ModuleHost } from './host.ts';
import { Installer, type Staged } from './install.ts';
import { parseManifest, type Manifest, type ManifestTool } from './manifest.ts';
import type { InboundMessage } from './protocol.ts';

export interface ModuleTool extends ManifestTool {
  moduleId: string;
  kind: 'module' | 'skill';
}

const here = path.dirname(fileURLToPath(import.meta.url));
const ext = path.extname(fileURLToPath(import.meta.url));

export class ModuleRegistry {
  private readonly config: Config;
  private readonly store: Store;
  private readonly bus: EventBus;
  private readonly log: Logger;
  private readonly hosts = new Map<string, ModuleHost>();
  readonly installer: Installer;
  /** 채널 모듈이 받은 메시지를 에이전트에게 넘기는 함수 (AgentManager 가 연결) */
  onInbound: (moduleId: string, msg: InboundMessage) => void = () => {};

  constructor(config: Config, store: Store, bus: EventBus, log: Logger) {
    this.config = config;
    this.store = store;
    this.bus = bus;
    this.log = log;
    this.installer = new Installer({
      config,
      toolOwners: () => this.toolOwners(),
      moduleExists: (id) => {
        const m = store.findModule(id);
        return m ? { origin: m.origin } : null;
      },
      envHas: (name) => Boolean(process.env[name]?.trim()),
    });
  }

  private readDirs(): string[] {
    // 실행기 코드, 저장소 node_modules (모듈 의존성), 서버 소스(실행기가 불러오는 공용 코드)
    const dirs = [path.resolve(here, '..'), path.join(this.config.rootDir, 'node_modules')];
    return dirs.filter((d) => fs.existsSync(d));
  }

  private envFor(manifest: Manifest): { env: Record<string, string>; missing: string[] } {
    const env: Record<string, string> = { NODE_ENV: process.env['NODE_ENV'] ?? 'production', TZ: process.env['TZ'] ?? '', LANG: process.env['LANG'] ?? 'C.UTF-8' };
    const missing: string[] = [];
    for (const e of manifest.env) {
      const v = process.env[e.name];
      if (v && v.trim() !== '') env[e.name] = v;
      else if (e.required) missing.push(e.name);
    }
    return { env, missing };
  }

  private makeHost(row: ModuleRow): ModuleHost {
    const host = new ModuleHost(row, {
      config: this.config,
      log: this.log.child(`module:${row.id}`),
      runnerPath: path.join(here, `runner${ext}`),
      readDirs: this.readDirs(),
      envFor: (m) => this.envFor(m),
      onStatus: (id, status, detail) => this.onStatus(id, status, detail),
      onInbound: (id, msg) => this.onInbound(id, msg),
      onLog: (id, level, line) => {
        if (level === 'error') this.log.warn(`[module:${id}] ${line}`);
      },
    });
    this.hosts.set(row.id, host);
    return host;
  }

  private onStatus(id: string, status: ModuleStatus, detail: string | null): void {
    const prev = this.store.findModule(id);
    if (!prev) return;
    if (prev.status !== status || prev.statusDetail !== detail) this.store.setModuleStatus(id, status, detail);
    this.bus.emit({ type: 'module.status', moduleId: id, status, detail });
    const name = prev.manifest.name;
    if (status === 'running' && prev.status !== 'running' && prev.manifest.channel) {
      this.bus.activity({ type: 'module.running', category: 'module', tone: 'module', who: name, text: '연결됨', moduleId: id });
    } else if (status === 'crashed') {
      this.bus.activity({ type: 'module.crashed', category: 'module', tone: 'error', who: name, text: detail ?? '비정상 종료', moduleId: id });
    } else if (status === 'failed' && prev.status !== 'failed') {
      this.bus.activity({ type: 'module.failed', category: 'module', tone: 'error', who: name, text: detail ?? '시작 실패', moduleId: id });
    }
  }

  /** 기본 제공 모듈 폴더를 읽어 등록하고, 저장된 모듈들의 실행기를 만듭니다. */
  init(): void {
    if (fs.existsSync(this.config.modulesDir)) {
      for (const e of fs.readdirSync(this.config.modulesDir, { withFileTypes: true })) {
        if (!e.isDirectory()) continue;
        const dir = path.join(this.config.modulesDir, e.name);
        const mPath = path.join(dir, 'module.json');
        if (!fs.existsSync(mPath)) continue;
        try {
          const manifest = parseManifest(JSON.parse(fs.readFileSync(mPath, 'utf8')), `기본 모듈 ${e.name}`);
          const prev = this.store.findModule(manifest.id);
          this.store.upsertModule({
            id: manifest.id,
            kind: 'module',
            origin: 'builtin',
            dir,
            manifest,
            enabled: prev ? prev.enabled : true,
            status: manifest.channel ? 'stopped' : 'idle',
            statusDetail: null,
            createdBy: null,
            report: null,
          });
        } catch (err) {
          this.log.error('기본 모듈을 읽지 못했습니다', { dir, error: (err as Error).message });
        }
      }
    }
    for (const row of this.store.listModules()) {
      if (!fs.existsSync(row.dir)) {
        this.store.setModuleStatus(row.id, 'failed', `모듈 폴더(${row.dir})가 없습니다. 지웠거나 DATA_DIR 이 바뀌었습니다.`);
        continue;
      }
      if (row.status !== 'pending' && row.status !== 'rejected') this.store.setModuleStatus(row.id, row.manifest.channel ? 'stopped' : 'idle', null);
      this.makeHost(this.store.getModule(row.id));
    }
  }

  /** 켜져 있는 채널 모듈을 띄웁니다. 실패해도 서버는 계속 뜹니다 (상태와 이유는 모듈 화면에). */
  async startChannels(): Promise<void> {
    const jobs: Promise<void>[] = [];
    for (const row of this.store.listModules('module')) {
      if (!row.enabled || !row.manifest.channel || row.status === 'pending') continue;
      const host = this.hosts.get(row.id);
      if (!host) continue;
      jobs.push(host.start().catch((err: Error) => this.log.warn('채널 모듈을 시작하지 못했습니다', { id: row.id, error: err.message })));
    }
    await Promise.all(jobs);
  }

  host(id: string): ModuleHost {
    const h = this.hosts.get(id);
    if (!h) {
      const row = this.store.getModule(id);
      return this.makeHost(row);
    }
    return h;
  }

  /** 내장 도구 이름 (모듈·스킬이 쓸 수 없음). AgentManager 가 채웁니다. */
  reservedToolNames = new Set<string>(['web_search', 'web_fetch']);

  toolOwners(): Map<string, string> {
    const map = new Map<string, string>();
    for (const n of this.reservedToolNames) map.set(n, 'builtin');
    for (const m of this.store.listModules()) {
      if (m.status === 'rejected') continue;
      for (const t of m.manifest.tools) map.set(t.name, m.id);
    }
    return map;
  }

  /** 에이전트에 연결된 모듈·스킬의 도구들 (켜져 있고 승인된 것만). */
  toolsFor(agentId: string): ModuleTool[] {
    const out: ModuleTool[] = [];
    for (const link of this.store.listAgentModules(agentId)) {
      const m = this.store.findModule(link.moduleId);
      if (!m || !m.enabled || m.status === 'pending' || m.status === 'rejected') continue;
      for (const t of m.manifest.tools) out.push({ ...t, moduleId: m.id, kind: m.kind });
    }
    return out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  }

  async callTool(moduleId: string, tool: string, input: unknown, meta: { agentId: string | null; agentName: string | null; taskId: string | null }): Promise<string> {
    const out = await this.host(moduleId).call(tool, input, meta);
    const max = 262_144;
    return out.length > max ? `${out.slice(0, max)}\n…(출력이 ${max}자를 넘어 잘랐습니다)` : out;
  }

  async send(moduleId: string, target: string, text: string): Promise<string> {
    const row = this.store.getModule(moduleId);
    if (!row.manifest.channel) throw new ModuleError('module_not_channel', `모듈 '${row.manifest.name}'은(는) 메시지를 보내는 채널 모듈이 아닙니다.`, 400);
    return this.host(moduleId).send(target, text);
  }

  /** 점검을 마친 모듈을 설치합니다. */
  async install(token: string, opts: { kind: 'module' | 'skill'; createdBy: string | null; enabled: boolean; status?: ModuleStatus }): Promise<ModuleRow> {
    const done = this.installer.commit(token, opts.kind);
    return this.register(done.dir, done.manifest, done.origin, done.report, opts);
  }

  register(dir: string, manifest: Manifest, origin: ModuleOrigin, report: InstallReport | null, opts: { kind: 'module' | 'skill'; createdBy: string | null; enabled: boolean; status?: ModuleStatus }): ModuleRow {
    const existing = this.hosts.get(manifest.id);
    if (existing) void existing.stop('update');
    const row = this.store.upsertModule({
      id: manifest.id,
      kind: opts.kind,
      origin,
      dir,
      manifest,
      enabled: opts.enabled,
      status: opts.status ?? (manifest.channel ? 'stopped' : 'idle'),
      statusDetail: null,
      createdBy: opts.createdBy,
      report,
    });
    const host = this.makeHost(row);
    if (row.enabled && row.manifest.channel && row.status !== 'pending') {
      host.start().catch((err: Error) => this.log.warn('새 채널 모듈을 시작하지 못했습니다', { id: row.id, error: err.message }));
    }
    this.bus.emit({ type: 'graph.changed' });
    return row;
  }

  /** 에이전트가 만든 모듈을 승인 대기 상태로 둡니다 (파일은 _pending 폴더에). */
  holdPending(staged: Staged, createdBy: string): ModuleRow {
    if (this.store.findModule(staged.manifest.id)) {
      throw new ConflictError('module_exists', `id '${staged.manifest.id}' 모듈이 이미 있습니다. 다른 id 로 만드세요.`);
    }
    const dest = path.join(this.config.dataDir, 'modules', '_pending', staged.manifest.id);
    fs.rmSync(dest, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.renameSync(staged.dir, dest);
    this.installer.discard(staged.token);
    const row = this.store.upsertModule({
      id: staged.manifest.id,
      kind: 'module',
      origin: 'agent',
      dir: dest,
      manifest: staged.manifest,
      enabled: false,
      status: 'pending',
      statusDetail: '설치 승인 대기',
      createdBy,
      report: staged.report,
    });
    this.bus.emit({ type: 'graph.changed' });
    return row;
  }

  /** 승인: _pending 에서 정식 폴더로 옮기고 켭니다. */
  approvePending(id: string): ModuleRow {
    const row = this.store.getModule(id);
    if (row.status !== 'pending') throw new ConflictError('module_not_pending', `모듈 '${row.manifest.name}'은(는) 승인 대기 상태가 아닙니다 (현재: ${row.status}).`);
    const dest = path.join(this.config.dataDir, 'modules', id);
    fs.rmSync(dest, { recursive: true, force: true });
    fs.renameSync(row.dir, dest);
    const next = this.register(dest, row.manifest, row.origin, row.report, { kind: 'module', createdBy: row.createdBy, enabled: true });
    if (row.createdBy) this.store.connectModule(row.createdBy, id, {});
    this.bus.activity({ type: 'module.installed', category: 'module', tone: 'new', who: row.manifest.name, text: '설치 승인됨 · 켜짐', moduleId: id, agentId: row.createdBy });
    return next;
  }

  rejectPending(id: string): void {
    const row = this.store.getModule(id);
    if (row.status !== 'pending') throw new ConflictError('module_not_pending', `모듈 '${row.manifest.name}'은(는) 승인 대기 상태가 아닙니다 (현재: ${row.status}).`);
    fs.rmSync(row.dir, { recursive: true, force: true });
    this.store.deleteModule(id);
    this.hosts.delete(id);
    this.bus.activity({ type: 'module.rejected', category: 'module', tone: 'block', who: row.manifest.name, text: '설치 거부됨 · 파일 삭제', moduleId: id, agentId: row.createdBy });
    this.bus.emit({ type: 'graph.changed' });
  }

  async setEnabled(id: string, enabled: boolean): Promise<ModuleRow> {
    const row = this.store.getModule(id);
    if (row.status === 'pending') throw new ConflictError('module_pending', `모듈 '${row.manifest.name}'은(는) 설치 승인 전이라 켜고 끌 수 없습니다.`);
    this.store.setModuleEnabled(id, enabled);
    const host = this.host(id);
    host.update(this.store.getModule(id));
    if (!enabled) await host.stop('user');
    else if (row.manifest.channel) {
      host.resetCrashes();
      await host.start().catch((err: Error) => this.log.warn('모듈을 켰지만 시작하지 못했습니다', { id, error: err.message }));
    }
    this.bus.emit({ type: 'graph.changed' });
    return this.store.getModule(id);
  }

  async restart(id: string): Promise<ModuleRow> {
    const host = this.host(id);
    host.update(this.store.getModule(id));
    host.resetCrashes();
    await host.stop('user');
    if (host.isChannel) await host.start();
    return this.store.getModule(id);
  }

  async remove(id: string): Promise<void> {
    const row = this.store.getModule(id);
    if (row.origin === 'builtin') throw new ConflictError('module_builtin', `'${row.manifest.name}'은(는) 기본 제공 모듈이라 지울 수 없습니다. 끄기만 할 수 있습니다.`);
    await this.host(id).stop('user');
    this.hosts.delete(id);
    fs.rmSync(row.dir, { recursive: true, force: true });
    this.store.deleteModule(id);
    this.bus.activity({ type: 'module.removed', category: 'module', tone: 'module', who: row.manifest.name, text: '제거됨', moduleId: id });
    this.bus.emit({ type: 'graph.changed' });
  }

  logs(id: string): string[] {
    return [...this.host(id).logs];
  }

  liveStatus(id: string): ModuleStatus {
    return this.hosts.get(id)?.status ?? this.store.getModule(id).status;
  }

  async shutdown(): Promise<void> {
    await Promise.all([...this.hosts.values()].map((h) => h.stop('shutdown')));
  }
}
