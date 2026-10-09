import { GUARD_DEFS, runGuards, type GuardEnv, type GuardState } from '../guards/guards.ts';
import { clockOf, evalCondition, fieldText, inWindow, parseRegex, parseWindow, renderReason, type RuleHook, type RuleRuntime } from './rules.ts';
import { regexRunner } from './safe-regex.ts';
import type { HookAction, HookCtx, HookEvent, HookOutcome } from './types.ts';

/**
 * 코드 훅에 두 번째 인자로 넘기는 도우미. 규칙 훅과 같은 방식으로 필드를 읽고 시간대를 계산하므로,
 * 화면의 "코드 보기"를 그대로 파일 훅으로 저장하면 같은 결과가 나옵니다.
 */
export interface HookHelpers {
  /** 규칙 훅의 필드 이름(host, text, path, agent, now, input.a.b …)으로 값을 읽습니다. 없으면 null. */
  field(name: string): string | null;
  /** 환경 변수 값. 비어 있으면 오류를 던져 그 훅을 건너뜁니다 (규칙 훅의 '건너뜀'과 같음). */
  env(name: string): string;
  /** 지금이 'HH:MM-HH:MM' 시간대 안인지 (서버 TZ 기준, 자정을 넘는 구간 가능). 형식이 틀리면 오류. */
  inWindow(window: string): boolean;
  /** 필드 값이 정규식과 맞는지. 문자열은 '/패턴/플래그' 또는 '패턴' 으로 해석합니다. 필드가 없으면 false. */
  matches(name: string, re: RegExp | string): boolean;
  clock(): { hhmm: string; minutes: number; weekday: string };
}

export function hookHelpers(ctx: HookCtx, rt: RuleRuntime): HookHelpers {
  return {
    field: (name) => fieldText(ctx, name, rt.timeZone),
    env: (name) => {
      const v = rt.env(name);
      if (v === undefined || v.trim() === '') throw new Error(`환경 변수 ${name} 이(가) 비어 있습니다.`);
      return v.trim();
    },
    inWindow: (window) => {
      const w = parseWindow(window);
      if (typeof w === 'string') throw new Error(w);
      return inWindow(clockOf(ctx.now, rt.timeZone).minutes, w);
    },
    matches: (name, pattern) => {
      const re = typeof pattern === 'string' ? parseRegex(pattern) : pattern;
      if (typeof re === 'string') throw new Error(re);
      const v = fieldText(ctx, name, rt.timeZone);
      if (v === null) return false;
      // 코드 훅의 정규식도 시간 제한을 두고 별도 스레드에서 돌립니다. 시간이 지나면 오류로 그 훅을 건너뜁니다.
      const r = regexRunner.test(re.source, re.flags, v);
      if (!r.ok) throw new Error(r.error);
      return r.value;
    },
    clock: () => clockOf(ctx.now, rt.timeZone),
  };
}

/** DATA_DIR/hooks/*.mjs 로 관리자가 직접 작성한 코드 훅. */
export interface FileHook {
  id: string;
  file: string;
  name: string;
  event: HookEvent;
  action: HookAction;
  enabled: boolean;
  when: (ctx: HookCtx, h: HookHelpers) => boolean;
  /** 문자열이면 규칙 훅처럼 {필드} 를 실제 값으로 바꿉니다. */
  reason: string | ((ctx: HookCtx, h: HookHelpers) => string);
  modify?: (text: string, ctx: HookCtx, h: HookHelpers) => string;
  source: string;
}

export interface HookEngineOptions {
  guardEnv: GuardEnv;
  guardState: GuardState;
  rules: () => RuleHook[];
  fileHooks: () => FileHook[];
  runtime: RuleRuntime;
}

function modifiableText(ctx: HookCtx): string | null {
  if (ctx.event === 'before_send') return ctx.text;
  if (ctx.event === 'after_tool') return ctx.output ?? null;
  return null;
}

function withText(ctx: HookCtx, text: string): HookCtx {
  if (ctx.event === 'before_send') return { ...ctx, text };
  if (ctx.event === 'after_tool') return { ...ctx, output: text };
  return ctx;
}

export class HookEngine {
  private readonly opts: HookEngineOptions;

  constructor(opts: HookEngineOptions) {
    this.opts = opts;
  }

  /**
   * 1) 기본 금지 조항(끌 수 없음) → 2) 규칙 훅 → 3) 코드 훅 순서로 평가합니다.
   * 차단이 하나라도 나오면 즉시 차단, 확인은 모아서 확인, 수정은 순서대로 누적합니다.
   */
  run(ctx: HookCtx): HookOutcome {
    const guard = runGuards(ctx, this.opts.guardEnv, this.opts.guardState);
    if (guard) return { decision: 'deny', reasons: [guard.reason], by: [`guard:${guard.guard}`], logs: [] };
    return this.runCustom(ctx, this.opts.rules(), this.opts.fileHooks());
  }

  /** 훅 하나만 시험 실행합니다 (기본 금지 조항 제외). */
  test(rule: RuleHook, ctx: HookCtx): HookOutcome {
    return this.runCustom(ctx, [{ ...rule, enabled: true }], []);
  }

  private runCustom(start: HookCtx, rules: RuleHook[], files: FileHook[]): HookOutcome {
    const rt = this.opts.runtime;
    let ctx = start;
    const asks: string[] = [];
    const by: string[] = [];
    const logs: string[] = [];
    let modified = false;

    for (const rule of rules) {
      if (!rule.enabled || rule.event !== ctx.event) continue;
      let matched = true;
      for (const c of rule.conditions) {
        const r = evalCondition(c, ctx, rt);
        if (r.skipped) logs.push(`훅 '${rule.name}': ${r.skipped}`);
        if (!r.matched) {
          matched = false;
          break;
        }
      }
      if (!matched) continue;
      const reason = renderReason(rule.reason, ctx, rt.timeZone);
      if (rule.action === 'deny') return { decision: 'deny', reasons: [reason], by: [`hook:${rule.id}`], logs };
      if (rule.action === 'ask') {
        asks.push(reason);
        by.push(`hook:${rule.id}`);
      } else if (rule.action === 'modify' && rule.modify) {
        const text = modifiableText(ctx);
        const re = parseRegex(rule.modify.find);
        if (text !== null && typeof re !== 'string') {
          const flags = re.flags.includes('g') ? re.flags : `${re.flags}g`;
          const r = regexRunner.replace(re.source, flags, text, rule.modify.replace);
          if (!r.ok) {
            // 가리려던 내용이 그대로 나가지 않도록, 수정하지 못하면 막습니다.
            if (r.timedOut) return { decision: 'deny', reasons: [`훅 '${rule.name}'의 수정 패턴이 시간 안에 끝나지 않아 막았습니다 (${r.error}).`], by: [`hook:${rule.id}`], logs };
            logs.push(`훅 '${rule.name}': ${r.error}`);
            continue;
          }
          const next = r.value;
          if (next !== text) {
            ctx = withText(ctx, next);
            modified = true;
            by.push(`hook:${rule.id}`);
            logs.push(reason);
          }
        }
      } else if (rule.action === 'log') {
        logs.push(reason);
      }
    }

    for (const fh of files) {
      if (!fh.enabled || fh.event !== ctx.event) continue;
      const h = hookHelpers(ctx, rt);
      let matched: boolean;
      try {
        matched = fh.when(ctx, h) === true;
      } catch (err) {
        logs.push(`코드 훅 '${fh.name}'(${fh.file})의 when() 에서 오류가 나 건너뛰었습니다: ${(err as Error).message}`);
        continue;
      }
      if (!matched) continue;
      let reason: string;
      try {
        reason = typeof fh.reason === 'function' ? fh.reason(ctx, h) : renderReason(fh.reason, ctx, rt.timeZone);
      } catch (err) {
        reason = `코드 훅 '${fh.name}'의 reason() 오류: ${(err as Error).message}`;
      }
      if (fh.action === 'deny') return { decision: 'deny', reasons: [reason], by: [`file:${fh.id}`], logs };
      if (fh.action === 'ask') {
        asks.push(reason);
        by.push(`file:${fh.id}`);
      } else if (fh.action === 'modify' && fh.modify) {
        const text = modifiableText(ctx);
        if (text !== null) {
          try {
            const next = fh.modify(text, ctx, h);
            if (typeof next === 'string' && next !== text) {
              ctx = withText(ctx, next);
              modified = true;
              by.push(`file:${fh.id}`);
              logs.push(reason);
            }
          } catch (err) {
            logs.push(`코드 훅 '${fh.name}'의 modify() 에서 오류가 나 수정하지 않았습니다: ${(err as Error).message}`);
          }
        }
      } else if (fh.action === 'log') {
        logs.push(reason);
      }
    }

    const outcome: HookOutcome = { decision: asks.length > 0 ? 'ask' : 'allow', reasons: asks, by, logs };
    if (modified) outcome.text = modifiableText(ctx) ?? undefined;
    return outcome;
  }
}

/** UI용: 기본 금지 조항 목록 */
export function guardList(): typeof GUARD_DEFS {
  return GUARD_DEFS;
}
