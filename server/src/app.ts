import fs from 'node:fs';
import path from 'node:path';
import { AgentManager } from './agents/manager.ts';
import { loadPresets, type Preset } from './agents/presets.ts';
import { AnthropicService } from './anthropic/service.ts';
import { ApprovalService } from './approvals/service.ts';
import type { Config } from './config/env.ts';
import { Db } from './db/sqlite.ts';
import { Store } from './db/store.ts';
import { EventBus } from './events/bus.ts';
import { GuardState, type GuardEnv, type GuardLists } from './guards/guards.ts';
import { ConfigError } from './errors.ts';
import { HookEngine, type FileHook } from './hooks/engine.ts';
import { loadFileHooks, type FileHookError } from './hooks/files.ts';
import type { Logger } from './log.ts';
import { ModuleRegistry } from './modules/registry.ts';
import { SchedulerService } from './scheduler/service.ts';

export interface App {
  config: Config;
  log: Logger;
  db: Db;
  store: Store;
  bus: EventBus;
  anthropic: AnthropicService;
  registry: ModuleRegistry;
  approvals: ApprovalService;
  hooks: HookEngine;
  guardState: GuardState;
  scheduler: SchedulerService;
  manager: AgentManager;
  presets: Map<string, Preset>;
  fileHooks: { hooks: FileHook[]; errors: FileHookError[] };
  reloadFileHooks: () => Promise<void>;
  startedAt: number;
}

/** 서비스들을 만들어 서로 연결합니다. 네트워크는 아직 열지 않습니다. */
export async function createApp(config: Config, log: Logger): Promise<App> {
  fs.mkdirSync(config.dataDir, { recursive: true });
  for (const d of ['workspaces', 'modules', 'skills', 'module-data', 'hooks', 'tmp']) fs.mkdirSync(path.join(config.dataDir, d), { recursive: true });
  fs.rmSync(path.join(config.dataDir, 'tmp'), { recursive: true, force: true });
  fs.mkdirSync(path.join(config.dataDir, 'tmp'), { recursive: true });

  const db = new Db(path.join(config.dataDir, 'switchboard.db'));
  const store = new Store(db);
  const bus = new EventBus(store);
  const presets = loadPresets(config.rootDir);
  const anthropic = new AnthropicService(config, store, log.child('anthropic'));
  anthropic.syncEnvKey();

  const registry = new ModuleRegistry(config, store, bus, log.child('modules'));
  const approvals = new ApprovalService(config, store, bus, log.child('approvals'));
  approvals.expireLeftovers();
  const failed = store.failUnfinishedTasks('서버가 다시 시작되어 이전 실행의 작업을 중단했습니다.');
  if (failed > 0) log.info('이전 실행에서 끝나지 않은 작업을 정리했습니다', { count: failed });

  const guardLists = loadGuardLists(config.rootDir);
  const guardState = new GuardState();
  const selfHosts = ['localhost', '127.0.0.1', '::1', '0.0.0.0'];
  if (config.publicUrl) selfHosts.push(new URL(config.publicUrl).hostname.toLowerCase());
  const guardEnv: GuardEnv = {
    lists: guardLists,
    knownSecrets: () => {
      const values = anthropic.knownSecretValues();
      for (const k of ['DISCORD_BOT_TOKEN', 'TELEGRAM_BOT_TOKEN', 'SESSION_SECRET', 'ADMIN_PASSWORD', 'SECRETS_KEY']) {
        const v = process.env[k];
        if (v && v.trim()) values.push(v.trim());
      }
      for (const m of store.listModules()) for (const e of m.manifest.env) {
        const v = process.env[e.name];
        if (v && v.trim()) values.push(v.trim());
      }
      return values;
    },
    selfHosts,
    protectedPaths: [path.join(config.dataDir, 'hooks'), path.join(config.rootDir, 'config'), path.join(config.dataDir, 'switchboard.db')],
    floodPerMinute: config.guardFloodPerMinute,
    loopRepeat: config.guardLoopRepeat,
  };

  const app = {
    fileHooks: { hooks: [] as FileHook[], errors: [] as FileHookError[] },
  } as { fileHooks: App['fileHooks'] };
  const hooksDir = path.join(config.dataDir, 'hooks');
  const reloadFileHooks = async (): Promise<void> => {
    app.fileHooks = await loadFileHooks(hooksDir, log.child('hooks'));
  };
  await reloadFileHooks();

  const hooks = new HookEngine({
    guardEnv,
    guardState,
    rules: () => store.listHooks(),
    fileHooks: () => app.fileHooks.hooks,
    runtime: { env: (name) => process.env[name], timeZone: process.env['TZ'] || 'UTC' },
  });

  const scheduler = new SchedulerService(store, bus, log.child('scheduler'));
  const manager = new AgentManager({ config, store, bus, log: log.child('agents'), anthropic, registry, hooks, approvals, guardState, scheduler, presets });

  registry.init();
  manager.init();

  const full: App = {
    config,
    log,
    db,
    store,
    bus,
    anthropic,
    registry,
    approvals,
    hooks,
    guardState,
    scheduler,
    manager,
    presets,
    get fileHooks() {
      return app.fileHooks;
    },
    reloadFileHooks,
    startedAt: Date.now(),
  };
  return full;
}

/** config/guards.json — 기본 금지 조항이 참조하는 목록 */
function loadGuardLists(rootDir: string): GuardLists {
  const file = path.join(rootDir, 'config', 'guards.json');
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
  } catch (err) {
    throw new ConfigError([`config/guards.json 을 읽지 못했습니다: ${(err as Error).message}`]);
  }
  const keys: (keyof GuardLists)[] = ['financeHosts', 'secretFileNames', 'secretFileExtensions', 'secretDirectories', 'shellInterpreters'];
  const out = {} as GuardLists;
  for (const k of keys) {
    const v = raw[k];
    if (!Array.isArray(v) || !v.every((x) => typeof x === 'string')) throw new ConfigError([`config/guards.json 의 ${k} 는 문자열 배열이어야 합니다.`]);
    out[k] = (v as string[]).map((x) => x.toLowerCase());
  }
  return out;
}
