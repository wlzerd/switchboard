import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Logger } from '../log.ts';
import type { FileHook } from './engine.ts';
import { HOOK_EVENTS, type HookAction, type HookEvent } from './types.ts';

export interface FileHookError {
  file: string;
  message: string;
}

const ACTIONS: HookAction[] = ['deny', 'ask', 'modify', 'log'];

/**
 * DATA_DIR/hooks/*.mjs 를 읽습니다. 관리자가 직접 쓰는 신뢰된 코드이며, 에이전트는 이 폴더에 쓸 수 없습니다(자기 변경 차단).
 * 파일마다 export default { name, on, action, when(ctx), reason, modify? } 형태여야 합니다.
 */
export async function loadFileHooks(dir: string, log: Logger): Promise<{ hooks: FileHook[]; errors: FileHookError[] }> {
  const hooks: FileHook[] = [];
  const errors: FileHookError[] = [];
  if (!fs.existsSync(dir)) return { hooks, errors };
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.mjs')).sort();
  for (const file of files) {
    const full = path.join(dir, file);
    try {
      const source = fs.readFileSync(full, 'utf8');
      const mod = (await import(`${pathToFileURL(full).href}?v=${fs.statSync(full).mtimeMs}`)) as { default?: Record<string, unknown> };
      const d = mod.default;
      if (!d || typeof d !== 'object') throw new Error('export default 로 훅 객체를 내보내야 합니다.');
      if (typeof d['name'] !== 'string' || d['name'].trim() === '') throw new Error('name 이 비어 있습니다.');
      if (!HOOK_EVENTS.includes(d['on'] as HookEvent)) throw new Error(`on 은 ${HOOK_EVENTS.join(', ')} 중 하나여야 합니다. 받은 값: ${JSON.stringify(d['on'])}`);
      if (!ACTIONS.includes(d['action'] as HookAction)) throw new Error(`action 은 ${ACTIONS.join(', ')} 중 하나여야 합니다. 받은 값: ${JSON.stringify(d['action'])}`);
      if (typeof d['when'] !== 'function') throw new Error('when(ctx) 함수가 필요합니다.');
      if (typeof d['reason'] !== 'string' && typeof d['reason'] !== 'function') throw new Error('reason 은 문자열이나 함수여야 합니다.');
      if (d['action'] === 'modify' && typeof d['modify'] !== 'function') throw new Error('action 이 modify 면 modify(text, ctx) 함수가 필요합니다.');
      hooks.push({
        id: file.replace(/\.mjs$/, ''),
        file,
        name: d['name'],
        event: d['on'] as HookEvent,
        action: d['action'] as HookAction,
        enabled: d['enabled'] !== false,
        when: d['when'] as FileHook['when'],
        reason: d['reason'] as FileHook['reason'],
        modify: d['modify'] as FileHook['modify'],
        source,
      });
    } catch (err) {
      const message = (err as Error).message;
      errors.push({ file, message });
      log.warn('코드 훅을 불러오지 못했습니다', { file, error: message });
    }
  }
  return { hooks, errors };
}
