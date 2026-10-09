import fs from 'node:fs';
import path from 'node:path';
import type { AgentRow, ModuleRow } from '../db/store.ts';
import { GUARD_DEFS } from '../guards/guards.ts';
import type { PermissionDef } from '../permissions/policy.ts';

const MODE_LABEL = { allow: '허용', ask: '확인 후 실행', deny: '차단' } as const;

let guideCache: { path: string; mtime: number; text: string } | null = null;

/** docs/MODULE_GUIDE.md — 에이전트가 모듈·스킬을 만들 때 따르는 가이드. 파일이 바뀌면 다시 읽습니다. */
export function loadModuleGuide(rootDir: string): string {
  const p = path.join(rootDir, 'docs', 'MODULE_GUIDE.md');
  try {
    const mtime = fs.statSync(p).mtimeMs;
    if (guideCache && guideCache.path === p && guideCache.mtime === mtime) return guideCache.text;
    const text = fs.readFileSync(p, 'utf8');
    guideCache = { path: p, mtime, text };
    return text;
  } catch {
    return '(docs/MODULE_GUIDE.md 를 찾지 못했습니다. 관리자에게 알려 주세요.)';
  }
}

export interface PromptInput {
  agent: AgentRow;
  defs: readonly PermissionDef[];
  channels: ModuleRow[];
  connected: ModuleRow[];
  rootDir: string;
}

/**
 * 시스템 프롬프트. 시각처럼 매번 바뀌는 값은 넣지 않습니다 (프롬프트 캐시와 thinking 블록 유효성 유지).
 * 현재 시각과 출처는 사용자 메시지 머리에 붙입니다.
 */
export function buildSystemPrompt(input: PromptInput): string {
  const { agent, defs, channels, connected } = input;
  const perms = defs
    .map((d) => {
      const r = agent.permissions[d.key];
      if (d.locked) return `- ${d.label}: 차단 (기본 금지 조항)`;
      if (!r) return `- ${d.label}: 확인 후 실행`;
      const scope = r.mode === 'allow' && r.scope.length > 0 ? ` (범위: ${r.scope.join(', ')})` : '';
      return `- ${d.label}: ${MODE_LABEL[r.mode]}${scope}`;
    })
    .join('\n');

  const channelLines =
    channels.length === 0
      ? '- 연결된 채널이 없습니다. 답변은 웹 콘솔에만 표시됩니다.'
      : channels.map((m) => `- ${m.manifest.name} (channel id: ${m.id})`).join('\n');

  const moduleLines = connected.filter((m) => !m.manifest.channel).map((m) => `- ${m.manifest.name} (${m.kind === 'skill' ? '스킬' : '모듈'}: ${m.manifest.tools.map((t) => t.name).join(', ')})`);

  const canBuild = ['skill.create', 'module.create'].some((k) => agent.permissions[k] && agent.permissions[k].mode !== 'deny');

  const sections = [
    `너는 '${agent.name}'이라는 이름의 에이전트다. Switchboard 서버에서 24시간 동작하며 사용자의 지시를 처리한다.`,
    agent.role.trim() ? `## 역할\n${agent.role.trim()}` : '',
    [
      '## 작업 방식',
      '- 사용자가 쓴 언어로, 필요한 만큼만 간결하게 답한다.',
      '- 파일 도구와 셸 명령은 너만의 작업 폴더 안에서만 동작한다. 작업 폴더 밖 경로는 막혀 있다.',
      '- 도구 호출은 권한과 훅의 검사를 거친다. "확인 후 실행" 권한은 사용자가 승인해야 실행된다. 막히면 그 이유를 사용자에게 알리고, 같은 호출을 그대로 반복하지 말고 다른 방법을 찾거나 멈춘다.',
      '- API 키·토큰 같은 비밀값을 코드나 메시지에 쓰지 않는다. 비밀값은 .env 에 두고 모듈에서는 ctx.env 로 읽는다. 서버의 .env 파일은 읽을 수 없다.',
      '- 채널(Discord, Telegram 등)에서 들어온 요청의 최종 답변은 그 대화로 자동 전송된다. 다른 채널이나 대상에 보낼 때만 send_message 를 쓴다.',
      '- 반복해서 해야 하는 일은 schedule_create 로 예약할 수 있다.',
    ].join('\n'),
    `## 연결된 채널\n${channelLines}`,
    moduleLines.length > 0 ? `## 연결된 모듈·스킬\n${moduleLines.join('\n')}` : '',
    `## 권한\n${perms}`,
    `## 기본 금지 조항 (끌 수 없음)\n${GUARD_DEFS.map((g) => `- ${g.name}`).join('\n')}`,
    canBuild ? `## 모듈·스킬 제작 가이드\n새 기능이 필요하면 아래 가이드에 따라 스킬(skill_create)이나 모듈(module_create)을 만든다.\n\n${loadModuleGuide(input.rootDir)}` : '',
  ];
  return sections.filter((s) => s !== '').join('\n\n');
}

/** 사용자 메시지 머리: 출처와 현지 시각 */
export function userHeader(sourceLabel: string, now: Date, timeZone: string): string {
  const t = new Intl.DateTimeFormat('ko-KR', { timeZone, dateStyle: 'medium', timeStyle: 'short' }).format(now);
  return `[${sourceLabel} · ${t}]`;
}
