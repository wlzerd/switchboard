// 모듈 연결 방식: 에이전트가 모듈 · 스킬을 자신에게 연결할 때 사람의 승인이 필요한지. 설정 화면에서 고르고 DB 설정에 둡니다.
//  - manual(수동): 연결할 때마다 사용자가 승인합니다. 에이전트가 만든 모듈 · 스킬도 만든 에이전트에게 저절로 붙지 않습니다.
//  - semi(반자동): 에이전트가 만든 모듈 · 스킬은 바로 연결하고, 그 밖(기본 제공 · Git · zip · 템플릿)은 승인을 받습니다.
//  - auto(자동): 모두 바로 연결합니다.
// 어느 방식이든 에이전트의 '모듈 연결' 권한이 차단이면 연결을 요청할 수 없습니다. 허용 · 확인과 '항상 허용' 목록 대신 이 방식이 승인을 정합니다.
import type { ModuleOrigin, Store } from '../db/store.ts';
import { ValidationError } from '../errors.ts';

export const CONNECT_MODES = ['manual', 'semi', 'auto'] as const;
export type ConnectMode = (typeof CONNECT_MODES)[number];
/** 기본: 반자동 (에이전트가 만든 모듈은 만든 에이전트에게 바로 붙고 나머지는 승인을 받던 지금까지의 동작과 가장 가까움) */
export const CONNECT_MODE_DEFAULT: ConnectMode = 'semi';
export const CONNECT_MODE_SETTING = 'module-connect-mode';
export const CONNECT_MODE_LABEL: Record<ConnectMode, string> = { manual: '수동', semi: '반자동', auto: '자동' };

const ORIGIN_LABEL: Record<ModuleOrigin, string> = { builtin: '기본 제공', git: 'Git 설치', zip: 'zip 설치', template: '템플릿', agent: '에이전트 제작' };

function isMode(v: unknown): v is ConnectMode {
  return typeof v === 'string' && (CONNECT_MODES as readonly string[]).includes(v);
}

export function parseConnectMode(v: unknown): ConnectMode {
  if (isMode(v)) return v;
  throw new ValidationError('module_connect_mode', `모듈 연결 방식은 manual(수동) · semi(반자동) · auto(자동) 중 하나여야 합니다. 받은 값: ${JSON.stringify(v) ?? String(v)}`);
}

/** 저장된 방식. 없거나 알 수 없는 값이면 기본값 */
export function readConnectMode(store: Pick<Store, 'getSetting'>): ConnectMode {
  const v = store.getSetting<unknown>(CONNECT_MODE_SETTING);
  return isMode(v) ? v : CONNECT_MODE_DEFAULT;
}

/** 승인 없이 연결해도 되면 null, 아니면 승인 카드에 적을 이유 */
export function connectApproval(mode: ConnectMode, origin: ModuleOrigin): string | null {
  if (mode === 'auto' || (mode === 'semi' && origin === 'agent')) return null;
  if (mode === 'manual') return "모듈 연결 방식이 '수동'이라 연결할 때마다 승인이 필요합니다.";
  return `모듈 연결 방식이 '반자동'이라 에이전트가 만들지 않은 모듈(${ORIGIN_LABEL[origin]})은 승인이 필요합니다.`;
}
