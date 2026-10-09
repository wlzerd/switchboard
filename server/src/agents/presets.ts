import fs from 'node:fs';
import path from 'node:path';
import { ConfigError } from '../errors.ts';
import { validateLimits, type AgentLimits } from '../limits/limits.ts';
import { BASE_PERMISSIONS, validatePermissionSet, type Mode, type PermissionDef, type PermissionSet } from '../permissions/policy.ts';

export interface Preset {
  id: string;
  name: string;
  permissions: PermissionSet;
  message: Mode;
  limits: AgentLimits;
}

/** config/presets.json 을 읽고 검증합니다. 잘못되면 어느 프리셋의 어떤 값인지 알려주고 멈춥니다. */
export function loadPresets(rootDir: string): Map<string, Preset> {
  const file = path.join(rootDir, 'config', 'presets.json');
  let raw: { presets?: Record<string, { name?: unknown; permissions?: unknown; message?: unknown; limits?: unknown }> };
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8')) as typeof raw;
  } catch (err) {
    throw new ConfigError([`config/presets.json 을 읽지 못했습니다: ${(err as Error).message}`]);
  }
  const out = new Map<string, Preset>();
  for (const [id, p] of Object.entries(raw.presets ?? {})) {
    try {
      if (typeof p.name !== 'string' || p.name.trim() === '') throw new Error('name 이 비어 있습니다.');
      if (p.message !== 'allow' && p.message !== 'ask' && p.message !== 'deny') throw new Error(`message 는 allow, ask, deny 중 하나여야 합니다. 받은 값: ${JSON.stringify(p.message)}`);
      out.set(id, { id, name: p.name, permissions: validatePermissionSet(p.permissions, BASE_PERMISSIONS), message: p.message, limits: validateLimits(p.limits) });
    } catch (err) {
      throw new ConfigError([`config/presets.json 의 '${id}' 프리셋: ${(err as Error).message}`]);
    }
  }
  if (!out.has('helper')) throw new ConfigError(["config/presets.json 에 기본 프리셋 'helper' 가 없습니다."]);
  return out;
}

/** 프리셋 권한 + 채널 모듈별 전송 권한(msg.<id>)을 합쳐 에이전트 권한을 만듭니다. */
export function permissionsFromPreset(preset: Preset, defs: readonly PermissionDef[]): PermissionSet {
  const out: PermissionSet = {};
  for (const d of defs) {
    if (d.locked) out[d.key] = { mode: 'deny', scope: [], always: [] };
    else if (d.key.startsWith('msg.')) out[d.key] = { mode: preset.message, scope: [], always: [] };
    else {
      const r = preset.permissions[d.key];
      out[d.key] = r ? { mode: r.mode, scope: [...r.scope], always: [...r.always] } : { mode: 'ask', scope: [], always: [] };
    }
  }
  return out;
}
