/**
 * 실제 서비스(createApp)를 띄우고 모델 호출만 각본대로 답하는 가짜로 바꾼 시험 환경.
 * 에이전트마다 키를 따로 두어 각본(script)을 키로 고릅니다.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp, type App } from '../../src/app.ts';
import { parseConfig } from '../../src/config/env.ts';
import type { AgentRow, DelegationSettings } from '../../src/db/store.ts';
import type { ServerEvent } from '../../src/events/bus.ts';
import { createLogger } from '../../src/log.ts';
import type { PermissionRule } from '../../src/permissions/policy.ts';

const repoRoot = path.resolve(import.meta.dirname, '..', '..', '..');

export type ToolCall = { name: string; input: Record<string, unknown>; toolset?: string };
export type Reply = { text?: string; tool?: ToolCall; tools?: ToolCall[]; error?: Error; stop?: string; wait?: Promise<void> };
export type Params = { system: { text: string }[]; messages: { role: string; content: unknown }[]; tools: { name?: string; type?: string }[] };
export type Script = (p: Params, call: number) => Reply;

export interface Harness {
  app: App;
  root: string;
  events: ServerEvent[];
  scripts: Map<string, Script>;
  calls: Map<string, Params[]>;
  addAgent(name: string, opts?: { delegation?: Partial<DelegationSettings>; permissions?: Record<string, PermissionRule>; deny?: string[]; paused?: boolean }): AgentRow;
  close(): Promise<void>;
}

/** 마지막 user 메시지의 글자 (도구 결과면 그 내용) */
export function lastUserText(p: Params): string {
  const last = [...p.messages].reverse().find((m) => m.role === 'user');
  if (!last) return '';
  if (typeof last.content === 'string') return last.content;
  return JSON.stringify(last.content);
}

export async function until<T>(fn: () => T | null | undefined | false, label: string, ms = 5000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - start > ms) throw new Error(`기다리다 시간 초과: ${label}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

export async function startHarness(extraEnv: Record<string, string> = {}): Promise<Harness> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-harness-'));
  fs.mkdirSync(path.join(root, 'config'));
  for (const f of ['presets.json', 'guards.json', 'themes.json']) fs.copyFileSync(path.join(repoRoot, 'config', f), path.join(root, 'config', f));
  fs.mkdirSync(path.join(root, 'templates'));
  const config = parseConfig(
    {
      ADMIN_PASSWORD: 'harness-test-password',
      SESSION_SECRET: 's'.repeat(40),
      SECRETS_KEY: Buffer.alloc(32, 9).toString('base64'),
      DATA_DIR: path.join(root, 'data'),
      MODULES_DIR: path.join(repoRoot, 'modules'),
      TEMPLATES_DIR: path.join(root, 'templates'),
      LOG_LEVEL: 'error',
      HEARTBEAT_MIN_MINUTES: '5',
      ...extraEnv,
    },
    root,
  );
  const app = await createApp(config, createLogger('error'));
  const scripts = new Map<string, Script>();
  const calls = new Map<string, Params[]>();
  const events: ServerEvent[] = [];
  let toolSeq = 0;
  const fakeClient = (keyId: string) => ({
    beta: {
      messages: {
        stream(params: Params) {
          const list = calls.get(keyId) ?? [];
          list.push(structuredClone(params));
          calls.set(keyId, list);
          const script = scripts.get(keyId);
          if (!script) throw new Error(`키 ${keyId} 의 각본이 없습니다`);
          const r = script(params, list.length);
          const onText: ((t: string) => void)[] = [];
          return {
            on(ev: string, cb: (t: string) => void) {
              if (ev === 'text') onText.push(cb);
              return this;
            },
            async finalMessage() {
              if (r.wait) await r.wait;
              if (r.error) throw r.error;
              const content: Record<string, unknown>[] = [];
              if (r.text) {
                for (const cb of onText) cb(r.text);
                content.push({ type: 'text', text: r.text });
              }
              const tools = r.tools ?? (r.tool ? [r.tool] : []);
              for (const t of tools) {
                toolSeq += 1;
                content.push({ type: 'tool_use', id: `toolu_${toolSeq}`, name: t.name, input: t.input, ...(t.toolset ? { toolset_name: t.toolset } : {}) });
              }
              return { content, stop_reason: r.stop ?? (tools.length > 0 ? 'tool_use' : 'end_turn'), stop_details: null, usage: { input_tokens: 10, output_tokens: 5 } };
            },
          };
        },
      },
    },
  });
  app.anthropic.client = ((keyId: string) => fakeClient(keyId)) as unknown as typeof app.anthropic.client;
  app.anthropic.modelInfo = async () => null;
  app.bus.subscribe((e) => events.push(e));

  let seq = 0;
  return {
    app,
    root,
    events,
    scripts,
    calls,
    addAgent(name, opts = {}) {
      seq += 1;
      const key = app.store.insertKey({ label: `test ${name}`, source: 'stored', cipher: 'x', last4: '0000' }, null);
      const preset = app.presets.get('operator');
      if (!preset) throw new Error('operator 프리셋이 없습니다');
      const permissions: Record<string, PermissionRule> = { ...preset.permissions, ...opts.permissions };
      for (const k of opts.deny ?? []) permissions[k] = { mode: 'deny', scope: [], always: [] };
      return app.store.insertAgent({
        id: `agt_h${seq}`,
        name,
        color: '#C6F35B',
        role: '',
        model: 'claude-opus-5-5',
        effort: null,
        keyId: key.id,
        preset: 'custom',
        permissions,
        limits: preset.limits,
        paused: opts.paused === true,
        delegation: { accept: false, send: false, supervisorId: null, ...opts.delegation },
      });
    },
    async close() {
      app.manager.shutdown();
      // 끝난 작업 뒤에 이어지는 정리(다음 작업 꺼내기 등)가 DB 를 닫은 뒤에 돌지 않게 기다립니다.
      await until(() => app.store.listAgents().every((a) => app.manager.live(a.id).running.length === 0), '작업 정리', 2000);
      app.db.close();
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}
