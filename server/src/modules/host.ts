import { fork, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { Config } from '../config/env.ts';
import type { ModuleRow, ModuleStatus } from '../db/store.ts';
import { ModuleError } from '../errors.ts';
import type { Logger } from '../log.ts';
import type { Manifest } from './manifest.ts';
import type { ChildMessage, ImagePayload, InboundMessage, ParentMessage } from './protocol.ts';

/** 재시작 대기 시간: 1초, 2초, 4초 … 최대 maxMs. attempt 는 1부터. */
export function restartDelayMs(attempt: number, baseMs = 1000, maxMs = 60_000): number {
  if (attempt < 1) return baseMs;
  const exp = Math.min(30, attempt - 1);
  return Math.min(maxMs, baseMs * 2 ** exp);
}

/**
 * 창(windowMs) 안의 비정상 종료 횟수가 max 를 넘으면 포기합니다.
 * max=5 → 5번째 종료까지는 다시 띄우고 6번째에서 멈춥니다. max=0 → 첫 종료에서 멈춥니다.
 */
export function shouldGiveUp(crashTimes: readonly number[], now: number, max: number, windowMs: number): boolean {
  const recent = crashTimes.filter((t) => now - t < windowMs).length;
  return recent > max;
}

export interface HostDeps {
  config: Config;
  log: Logger;
  runnerPath: string;
  readDirs: string[];
  envFor: (manifest: Manifest) => { env: Record<string, string>; missing: string[] };
  onStatus: (id: string, status: ModuleStatus, detail: string | null) => void;
  onInbound: (id: string, msg: InboundMessage) => void;
  onLog: (id: string, level: 'info' | 'warn' | 'error', line: string) => void;
}

interface Reply {
  output: string;
  image: ImagePayload | null;
}

interface Pending {
  resolve: (reply: Reply) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

const LOG_LINES = 300;

export class ModuleHost {
  readonly id: string;
  private row: ModuleRow;
  private readonly deps: HostDeps;
  private child: ChildProcess | null = null;
  private ready: Promise<void> | null = null;
  private readonly pending = new Map<number, Pending>();
  private seq = 0;
  private crashes: number[] = [];
  private stopping: 'user' | 'idle' | 'shutdown' | 'update' | null = null;
  private idleTimer: NodeJS.Timeout | null = null;
  private restartTimer: NodeJS.Timeout | null = null;
  private lastError: string | null = null;
  readonly logs: string[] = [];
  status: ModuleStatus;

  constructor(row: ModuleRow, deps: HostDeps) {
    this.id = row.id;
    this.row = row;
    this.deps = deps;
    this.status = row.status === 'pending' || row.status === 'rejected' ? row.status : row.manifest.channel ? 'stopped' : 'idle';
  }

  get manifest(): Manifest {
    return this.row.manifest;
  }

  get isChannel(): boolean {
    return this.row.manifest.channel !== null;
  }

  get running(): boolean {
    return this.child !== null && this.child.exitCode === null;
  }

  update(row: ModuleRow): void {
    this.row = row;
  }

  private setStatus(status: ModuleStatus, detail: string | null): void {
    this.status = status;
    this.deps.onStatus(this.id, status, detail);
  }

  private pushLog(level: 'info' | 'warn' | 'error', line: string): void {
    const stamped = `${new Date().toISOString().slice(11, 19)} ${level.toUpperCase()} ${line}`;
    this.logs.push(stamped);
    if (this.logs.length > LOG_LINES) this.logs.splice(0, this.logs.length - LOG_LINES);
    this.deps.onLog(this.id, level, line);
    if (level === 'error') this.lastError = line;
  }

  private execArgv(dataDir: string): string[] {
    if (this.deps.config.moduleSandbox === 'none') return [];
    // 권한 모델은 실제 경로로 비교하므로 심볼릭 링크(/var → /private/var 등)를 풀어서 넘깁니다.
    const real = (p: string): string => {
      try {
        return fs.realpathSync(p);
      } catch {
        return p;
      }
    };
    const args = ['--permission'];
    for (const d of [...this.deps.readDirs, this.row.dir, dataDir]) args.push(`--allow-fs-read=${real(d)}`);
    args.push(`--allow-fs-write=${real(dataDir)}`);
    if (this.row.manifest.permissions.childProcess) args.push('--allow-child-process');
    return args;
  }

  /** 프로세스를 띄우고 activate 가 끝날 때까지 기다립니다. 이미 떠 있으면 바로 돌아옵니다. */
  start(): Promise<void> {
    if (this.row.status === 'pending') {
      return Promise.reject(new ModuleError('module_pending', `모듈 '${this.id}'은(는) 아직 설치 승인을 받지 않았습니다.`, 409));
    }
    if (!this.row.enabled) {
      return Promise.reject(new ModuleError('module_disabled', `모듈 '${this.id}'이(가) 꺼져 있습니다. 모듈 화면에서 켜세요.`, 409));
    }
    if (this.ready && this.running) return this.ready;
    const { env, missing } = this.deps.envFor(this.row.manifest);
    if (missing.length > 0) {
      const msg = `필요한 환경 변수 ${missing.join(', ')} 이(가) .env 에 없어 '${this.row.manifest.name}' 모듈을 시작하지 못했습니다. .env 에 값을 넣은 뒤 모듈 화면에서 '.env 다시 읽기'를 누르세요.`;
      this.setStatus('failed', msg);
      return Promise.reject(new ModuleError('module_env_missing', msg, 409, { missing }));
    }

    const dataDir = path.join(this.deps.config.dataDir, 'module-data', this.id);
    fs.mkdirSync(dataDir, { recursive: true });
    this.stopping = null;
    this.lastError = null;
    this.setStatus('starting', null);

    const child = fork(this.deps.runnerPath, [], {
      cwd: fs.realpathSync(this.row.dir),
      env,
      execArgv: this.execArgv(dataDir),
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      serialization: 'json',
    });
    this.child = child;
    child.stdout?.setEncoding('utf8').on('data', (d: string) => d.split('\n').filter(Boolean).forEach((l) => this.pushLog('info', l)));
    child.stderr?.setEncoding('utf8').on('data', (d: string) => d.split('\n').filter(Boolean).forEach((l) => {
      // Node 의 실험 기능 · 하위 프로세스 허용(--allow-child-process) 경고는 모듈 오류가 아닙니다.
      if (l.includes('ExperimentalWarning') || l.includes('--trace-warnings') || l.includes('SecurityWarning: The flag --allow-child-process')) return;
      this.pushLog('error', l);
    }));

    this.ready = new Promise<void>((resolve, reject) => {
      const timeoutMs = this.deps.config.moduleCallTimeoutMs;
      const timer = setTimeout(() => {
        const msg = `모듈 '${this.id}'이(가) ${Math.round(timeoutMs / 1000)}초 안에 준비되지 않았습니다 (activate 가 끝나지 않음).`;
        this.setStatus('failed', msg);
        child.kill('SIGKILL');
        reject(new ModuleError('module_start_timeout', msg, 504));
      }, timeoutMs);

      child.on('message', (raw) => {
        const m = raw as ChildMessage;
        switch (m.t) {
          case 'ready':
            clearTimeout(timer);
            this.setStatus('running', null);
            this.armIdle();
            resolve();
            return;
          case 'fatal': {
            clearTimeout(timer);
            const msg = `모듈 '${this.id}' 오류: ${m.error.message}`;
            this.pushLog('error', m.error.stack ?? m.error.message);
            this.lastError = m.error.message;
            if (this.status === 'starting') {
              this.setStatus('failed', msg);
              reject(new ModuleError('module_start_failed', msg, 500));
            }
            return;
          }
          case 'result': {
            const p = this.pending.get(m.id);
            if (!p) return;
            this.pending.delete(m.id);
            clearTimeout(p.timer);
            if (m.ok) p.resolve({ output: m.output, image: m.image ?? null });
            else p.reject(new ModuleError('module_tool_error', `모듈 '${this.id}' 실행 오류: ${m.error.message}`, 502, { name: m.error.name }));
            return;
          }
          case 'inbound':
            this.deps.onInbound(this.id, m.message);
            return;
          case 'log':
            this.pushLog(m.level, m.msg);
            return;
          case 'status':
            this.deps.onStatus(this.id, this.status, m.detail);
            return;
        }
      });

      child.on('error', (err) => {
        clearTimeout(timer);
        const msg = `모듈 '${this.id}' 프로세스를 띄우지 못했습니다: ${err.message}`;
        this.setStatus('failed', msg);
        reject(new ModuleError('module_spawn', msg, 500));
      });

      child.on('exit', (code, signal) => {
        clearTimeout(timer);
        if (this.status === 'starting') {
          const msg = `모듈 '${this.id}' 프로세스가 준비 전에 종료되었습니다(${signal ? `신호 ${signal}` : `종료 코드 ${code}`}).${this.lastError ? ` 마지막 오류: ${this.lastError}` : ''}`;
          this.setStatus('failed', msg);
          reject(new ModuleError('module_start_exit', msg, 500));
        }
        this.onExit(child, code, signal);
      });
    });
    // 핸들러를 모두 붙인 뒤 초기화 메시지를 보냅니다.
    child.send(this.initPayload());
    return this.ready;
  }

  private onExit(child: ChildProcess, code: number | null, signal: NodeJS.Signals | null): void {
    if (this.child !== child) return;
    this.child = null;
    this.ready = null;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    const why = signal ? `신호 ${signal}` : `종료 코드 ${code}`;
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new ModuleError('module_exited', `모듈 '${this.id}' 프로세스가 응답 전에 종료되었습니다(${why}).${this.lastError ? ` 마지막 오류: ${this.lastError}` : ''}`, 502));
      this.pending.delete(id);
    }
    if (this.stopping) {
      this.setStatus(this.stopping === 'idle' ? 'idle' : 'stopped', null);
      return;
    }
    if (this.status === 'failed') return;

    const now = Date.now();
    this.crashes = [...this.crashes.filter((t) => now - t < this.deps.config.moduleRestartWindowMinutes * 60_000), now];
    const detail = `비정상 종료(${why})${this.lastError ? `: ${this.lastError}` : ''}`;
    if (shouldGiveUp(this.crashes, now, this.deps.config.moduleRestartMax, this.deps.config.moduleRestartWindowMinutes * 60_000)) {
      this.setStatus('failed', `${this.deps.config.moduleRestartWindowMinutes}분 동안 ${this.crashes.length}번 비정상 종료되어 다시 띄우지 않습니다. 마지막 원인: ${detail}`);
      return;
    }
    this.setStatus('crashed', detail);
    if (this.isChannel) {
      const delay = restartDelayMs(this.crashes.length);
      this.pushLog('warn', `${Math.round(delay / 1000)}초 뒤 다시 시작합니다 (${this.crashes.length}번째)`);
      this.restartTimer = setTimeout(() => {
        this.restartTimer = null;
        this.start().catch((err: Error) => this.deps.log.warn('모듈 재시작 실패', { id: this.id, error: err.message }));
      }, delay);
    }
  }

  private armIdle(): void {
    if (this.isChannel) return;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      if (this.pending.size === 0) void this.stop('idle');
      else this.armIdle();
    }, this.deps.config.moduleIdleTimeoutMs);
  }

  private request(msg: ParentMessage & { id: number }, label: string, timeoutMs = this.deps.config.moduleCallTimeoutMs): Promise<Reply> {
    const child = this.child;
    if (!child || !child.connected) {
      return Promise.reject(new ModuleError('module_not_running', `모듈 '${this.id}' 프로세스가 떠 있지 않습니다.`, 503));
    }
    return new Promise<Reply>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(msg.id);
        reject(new ModuleError('module_call_timeout', `모듈 '${this.id}'의 ${label}이(가) ${Math.round(timeoutMs / 1000)}초 안에 응답하지 않았습니다.`, 504));
      }, timeoutMs);
      this.pending.set(msg.id, { resolve, reject, timer });
      child.send(msg);
    });
  }

  async call(tool: string, input: unknown, meta: { agentId: string | null; agentName: string | null; taskId: string | null }): Promise<string> {
    await this.start();
    this.armIdle();
    this.seq += 1;
    return (await this.request({ t: 'call', id: this.seq, tool, input, meta }, `도구 '${tool}'`)).output;
  }

  async send(target: string, text: string): Promise<string> {
    await this.start();
    this.seq += 1;
    return (await this.request({ t: 'send', id: this.seq, target, text }, '메시지 전송')).output;
  }

  /** 화면 제어 동작 하나. 기다리기 · 키 누르고 있기처럼 오래 걸리는 동작은 timeoutMs 를 늘려서 부릅니다. */
  async computer(action: string, input: unknown, timeoutMs: number): Promise<Reply> {
    await this.start();
    this.armIdle();
    this.seq += 1;
    return this.request({ t: 'computer', id: this.seq, action, input }, `화면 동작 '${action}'`, Math.max(timeoutMs, this.deps.config.moduleCallTimeoutMs));
  }

  /** 프로세스를 내립니다. deactivate 를 기다리되 5초가 지나면 강제로 끝냅니다. */
  async stop(reason: 'user' | 'idle' | 'shutdown' | 'update'): Promise<void> {
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    if (this.idleTimer) clearTimeout(this.idleTimer);
    const child = this.child;
    if (!child) {
      if (reason !== 'idle') this.setStatus(this.isChannel ? 'stopped' : 'idle', null);
      return;
    }
    this.stopping = reason;
    await new Promise<void>((resolve) => {
      const kill = setTimeout(() => {
        child.kill('SIGKILL');
        resolve();
      }, 5000);
      child.once('exit', () => {
        clearTimeout(kill);
        resolve();
      });
      if (child.connected) child.send({ t: 'stop' } satisfies ParentMessage);
      else child.kill('SIGTERM');
    });
  }

  /** 실패 상태에서 사용자가 다시 시작을 누를 때: 비정상 종료 기록을 지웁니다. */
  resetCrashes(): void {
    this.crashes = [];
  }

  initPayload(): ParentMessage {
    const real = (p: string): string => {
      try {
        return fs.realpathSync(p);
      } catch {
        return p;
      }
    };
    return {
      t: 'init',
      id: this.id,
      kind: this.row.kind,
      // 권한 모델은 심볼릭 링크 경로 자체를 읽으려 하면 막으므로 실제 경로를 넘깁니다.
      dir: real(this.row.dir),
      entry: this.row.manifest.entry,
      dataDir: real(path.join(this.deps.config.dataDir, 'module-data', this.id)),
      tools: this.row.manifest.tools.map((t) => ({ name: t.name, handler: t.handler ?? t.name })),
      netAllow: this.row.manifest.permissions.net,
    };
  }
}
