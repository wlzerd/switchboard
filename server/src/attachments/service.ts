/**
 * 콘솔 첨부 (이미지 · 파일).
 *  - 올리기: 내용으로 종류를 정하고 한도 · 비밀 파일 · 비밀값을 검사해 DATA_DIR/attachments/<에이전트>/<id> 에 둡니다.
 *  - 보내기: 에이전트 작업 폴더 uploads/<날짜>/ 에도 복사해(도구로 다룰 수 있게) 보냄 표시를 합니다.
 *  - 대화 기록에는 내용 대신 참조만 저장하고, 모델에 보낼 때 최근 것부터 한도 안에서만 실제 내용으로 펼칩니다
 *    (기록 전체를 요청마다 다시 보내므로 그림을 그대로 쌓으면 요청 크기 32MB 를 금방 넘음).
 *  - 보내지 않은 채 하루가 지난 첨부는 지웁니다 (쌓이지 않게).
 */
import fs from 'node:fs';
import path from 'node:path';
import type { Config } from '../config/env.ts';
import type { AgentRow, AttachmentRow, Store } from '../db/store.ts';
import { ConflictError, ValidationError } from '../errors.ts';
import { isSecretFileName, type GuardLists } from '../guards/guards.ts';
import { findSecret } from '../guards/secrets.ts';
import type { HistoryMessage } from '../agents/history.ts';
import { detect, formatBytes, IMAGE_MAX_BYTES, IMAGE_MAX_EDGE, safeName, textOf } from './media.ts';

/** 보내지 않은 첨부를 지우기까지의 시간 */
export const STALE_MS = 24 * 60 * 60 * 1000;
const PRUNE_BATCH = 50;
/** 요청 한 번에 펼쳐 싣는 첨부 내용의 합 (원본 기준). 요청 본문 32MB 와 base64(4/3배)를 생각해 18MB */
export const SEND_BUDGET_BYTES = 18 * 1024 * 1024;
/** 요청 한 번에 싣는 그림 · 문서 수. 20개를 넘으면 API 가 그림마다 2000px 제한을 걸어서 20개까지 */
export const SEND_MAX_BLOCKS = 20;
/** 메시지 하나에 붙이는 첨부의 합. 이보다 크면 한 번에 실을 수 없습니다 */
export const MESSAGE_MAX_BYTES = SEND_BUDGET_BYTES;

export interface AttachmentDeps {
  config: Config;
  store: Store;
  lists: GuardLists;
  knownSecrets: () => string[];
}

/** 화면 · 타임라인에 보이는 첨부 */
export interface AttachmentView {
  id: string;
  name: string;
  kind: AttachmentRow['kind'];
  size: number;
  width: number | null;
  height: number | null;
}

export function attachmentView(a: AttachmentRow): AttachmentView {
  return { id: a.id, name: a.name, kind: a.kind, size: a.size, width: a.width, height: a.height };
}

/** 대화 기록에 저장하는 참조 블록 (모델에 보낼 때 펼침) */
interface RefBlock {
  type: 'attachment';
  id: string;
  agentId: string;
  name: string;
  kind: 'image' | 'pdf' | 'text';
  mediaType: string;
  size: number;
  path: string | null;
}

const isRef = (b: unknown): b is RefBlock => typeof b === 'object' && b !== null && (b as { type?: unknown }).type === 'attachment';

function ymd(now: number): string {
  const d = new Date(now);
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export class AttachmentService {
  private readonly d: AttachmentDeps;

  constructor(deps: AttachmentDeps) {
    this.d = deps;
  }

  private agentDir(agentId: string): string {
    return path.join(this.d.config.dataDir, 'attachments', agentId);
  }

  /** 내용 파일 경로. 사용자가 정한 이름은 경로에 쓰지 않습니다 (id 로만) */
  filePath(a: Pick<AttachmentRow, 'agentId' | 'id'>): string {
    return path.join(this.agentDir(a.agentId), a.id);
  }

  private workspaceOf(agentId: string): string {
    return path.join(this.d.config.dataDir, 'workspaces', agentId);
  }

  /** 보내지 않은 채 하루가 지난 첨부를 지웁니다 (한 번에 조금씩) */
  prune(now = Date.now()): number {
    const stale = this.d.store.staleAttachments(now - STALE_MS, PRUNE_BATCH);
    for (const a of stale) {
      fs.rmSync(this.filePath(a), { force: true });
      this.d.store.deleteAttachment(a.id);
    }
    return stale.length;
  }

  /** 올린 파일 하나를 검사해 저장합니다 */
  save(agent: AgentRow, rawName: unknown, data: Buffer, now = Date.now()): AttachmentRow {
    this.prune(now);
    const name = safeName(rawName);
    if (!name) throw new ValidationError('attachment_name', '파일 이름이 비어 있거나 쓸 수 없는 글자뿐입니다.');
    if (data.length === 0) throw new ValidationError('attachment_empty', `'${name}'은(는) 빈 파일입니다.`);
    const max = this.d.config.attachmentMaxMb * 1024 * 1024;
    if (data.length > max) throw new ValidationError('attachment_large', `'${name}'은(는) ${formatBytes(data.length)}로 첨부 한도(${this.d.config.attachmentMaxMb}MB)를 넘습니다.`, { size: data.length, max });
    if (isSecretFileName(name, this.d.lists)) {
      throw new ValidationError('attachment_secret_name', `'${name}'은(는) 비밀 파일로 보이는 이름이라 첨부하지 않았습니다 (기본 금지 조항 · 비밀 파일).`);
    }
    const found = detect(name, data);
    if (found.kind === 'image') {
      if (data.length > IMAGE_MAX_BYTES) throw new ValidationError('attachment_image_large', `그림 '${name}'이(가) ${formatBytes(data.length)}로 모델이 받는 한도(${formatBytes(IMAGE_MAX_BYTES)})를 넘습니다. 크기를 줄여 다시 첨부하세요.`);
      if (found.width === null || found.height === null) throw new ValidationError('attachment_image_broken', `그림 '${name}'의 크기를 읽지 못했습니다. 파일이 손상되었을 수 있습니다.`);
      if (found.width > IMAGE_MAX_EDGE || found.height > IMAGE_MAX_EDGE) {
        throw new ValidationError('attachment_image_edge', `그림 '${name}'이(가) ${found.width}×${found.height}px로 모델이 받는 최대 크기(${IMAGE_MAX_EDGE}px)를 넘습니다. 크기를 줄여 다시 첨부하세요.`);
      }
    }
    // 글로 보낼 파일은 서버가 가진 비밀값이 들어 있으면 보내지 않습니다 (기본 금지 조항 · 비밀값 유출과 같은 기준).
    if (found.kind === 'text') {
      const hit = findSecret(textOf(data) ?? '', this.d.knownSecrets());
      if (hit) throw new ValidationError('attachment_secret', `'${name}'에 비밀값(${hit.kind})이 들어 있어 첨부하지 않았습니다 (기본 금지 조항 · 비밀값 유출). 그 값을 지운 뒤 다시 첨부하세요.`);
    }
    const row = this.d.store.insertAttachment({ agentId: agent.id, name, kind: found.kind, mediaType: found.mediaType, size: data.length, width: found.width, height: found.height }, now);
    try {
      fs.mkdirSync(this.agentDir(agent.id), { recursive: true });
      fs.writeFileSync(this.filePath(row), data);
    } catch (err) {
      this.d.store.deleteAttachment(row.id);
      throw err;
    }
    return row;
  }

  /** 보내기 전의 첨부를 지웁니다 (보낸 것은 대화 기록이 쓰므로 지우지 않음) */
  remove(id: string): void {
    const a = this.d.store.getAttachment(id);
    if (a.usedAt !== null) throw new ConflictError('attachment_used', `'${a.name}'은(는) 이미 보낸 첨부라 지울 수 없습니다.`);
    fs.rmSync(this.filePath(a), { force: true });
    this.d.store.deleteAttachment(a.id);
  }

  /** 에이전트를 지울 때 첨부 내용도 지웁니다 (DB 행은 함께 지워짐) */
  removeAgent(agentId: string): void {
    fs.rmSync(this.agentDir(agentId), { recursive: true, force: true });
  }

  /** 메시지에 붙일 첨부: 이 에이전트의 것, 아직 보내지 않은 것, 개수 · 합계 한도 안 */
  take(agent: AgentRow, raw: unknown): AttachmentRow[] {
    if (raw === undefined || raw === null) return [];
    if (!Array.isArray(raw) || raw.some((x) => typeof x !== 'string')) throw new ValidationError('attachments_type', 'attachments 는 첨부 id 배열이어야 합니다.');
    const ids = [...new Set(raw as string[])];
    if (ids.length > this.d.config.attachmentsPerMessage) {
      throw new ValidationError('attachments_many', `메시지 하나에 첨부는 ${this.d.config.attachmentsPerMessage}개까지 붙일 수 있습니다. 지금 ${ids.length}개입니다.`);
    }
    const out: AttachmentRow[] = [];
    let total = 0;
    for (const id of ids) {
      const a = this.d.store.findAttachment(id);
      if (!a || a.agentId !== agent.id) throw new ValidationError('attachment_missing', `첨부 '${id}'을(를) 찾을 수 없습니다. 하루가 지나 지워졌다면 다시 첨부하세요.`);
      if (a.usedAt !== null) throw new ValidationError('attachment_used', `'${a.name}'은(는) 이미 보낸 첨부입니다. 다시 보내려면 새로 첨부하세요.`);
      if (!fs.existsSync(this.filePath(a))) throw new ValidationError('attachment_missing', `'${a.name}'의 내용 파일이 없습니다. 다시 첨부하세요.`);
      total += a.size;
      out.push(a);
    }
    if (total > MESSAGE_MAX_BYTES) {
      throw new ValidationError('attachments_total', `첨부를 모두 합쳐 ${formatBytes(total)}로 한 번에 보낼 수 있는 ${formatBytes(MESSAGE_MAX_BYTES)}를 넘습니다. 나눠서 보내세요.`);
    }
    return out;
  }

  /** 보낼 때: 작업 폴더 uploads/<날짜>/ 에 복사하고 보냄 표시를 합니다. 같은 이름이 있으면 (2) 처럼 붙입니다 */
  commit(agent: AgentRow, list: readonly AttachmentRow[], now = Date.now()): AttachmentRow[] {
    const relDir = path.join('uploads', ymd(now));
    const absDir = path.join(this.workspaceOf(agent.id), relDir);
    fs.mkdirSync(absDir, { recursive: true });
    const out: AttachmentRow[] = [];
    for (const a of list) {
      const ext = path.extname(a.name);
      const stem = a.name.slice(0, a.name.length - ext.length);
      let name = a.name;
      for (let n = 2; fs.existsSync(path.join(absDir, name)) && n < 1000; n += 1) name = `${stem} (${n})${ext}`;
      fs.copyFileSync(this.filePath(a), path.join(absDir, name));
      const rel = path.join(relDir, name).split(path.sep).join('/');
      this.d.store.markAttachmentUsed(a.id, rel, now);
      out.push({ ...a, usedAt: now, workspacePath: rel });
    }
    return out;
  }

  /** 작업을 넣지 못했을 때 보냄 표시를 되돌리고 작업 폴더 사본을 지웁니다 */
  rollback(agent: AgentRow, list: readonly AttachmentRow[]): void {
    for (const a of list) {
      if (a.workspacePath) fs.rmSync(path.join(this.workspaceOf(agent.id), a.workspacePath), { force: true });
      this.d.store.markAttachmentUnused(a.id);
    }
  }

  /**
   * 대화 기록에 저장할 user 메시지 내용. 첨부가 없으면 글 그대로.
   * 그림 · 문서는 글보다 앞에 두고 '첨부 n: 이름' 으로 이름을 붙입니다 (모델이 여러 장을 구분해 부를 수 있게).
   * 모델에 바로 보낼 수 없는 파일은 작업 폴더 경로만 알려 줍니다.
   */
  messageContent(text: string, list: readonly AttachmentRow[]): unknown {
    if (list.length === 0) return text;
    const blocks: unknown[] = [];
    const notes: string[] = [];
    list.forEach((a, i) => {
      const where = a.workspacePath ? `작업 폴더 ${a.workspacePath}` : '작업 폴더';
      if (a.kind === 'file') {
        notes.push(`첨부 ${i + 1}: ${a.name} (${formatBytes(a.size)}) — 모델에 바로 보낼 수 없는 형식이라 ${where} 에만 두었습니다. 필요하면 도구로 다루세요.`);
        return;
      }
      blocks.push({ type: 'text', text: `첨부 ${i + 1}: ${a.name} (${where} 에도 저장됨)` });
      const ref: RefBlock = { type: 'attachment', id: a.id, agentId: a.agentId, name: a.name, kind: a.kind, mediaType: a.mediaType, size: a.size, path: a.workspacePath };
      blocks.push(ref);
    });
    blocks.push({ type: 'text', text: [text, ...notes].filter((s) => s.trim() !== '').join('\n\n') });
    return blocks;
  }

  /**
   * 모델에 보내기 직전: 참조 블록을 실제 내용으로 바꿉니다. 최근 메시지의 첨부부터 한도(크기 · 개수) 안에서만 싣고,
   * 나머지와 지워진 첨부는 작업 폴더 경로를 알려 주는 글로 바꿉니다. 입력은 바꾸지 않습니다.
   */
  expand(history: readonly HistoryMessage[]): HistoryMessage[] {
    let budget = SEND_BUDGET_BYTES;
    let slots = SEND_MAX_BLOCKS;
    const out: HistoryMessage[] = new Array(history.length);
    for (let i = history.length - 1; i >= 0; i -= 1) {
      const m = history[i] as HistoryMessage;
      if (m.role !== 'user' || !Array.isArray(m.content) || !m.content.some(isRef)) {
        out[i] = m;
        continue;
      }
      out[i] = {
        role: 'user',
        content: (m.content as unknown[]).map((b) => {
          if (!isRef(b)) return b;
          const later = `${b.path ? `작업 폴더의 ${b.path} 에 있으니 필요하면 도구로 다시 읽으세요` : '다시 첨부해야 볼 수 있습니다'}`;
          if (slots <= 0 || b.size > budget) return { type: 'text', text: `[첨부 '${b.name}'은(는) 앞에서 보낸 것이라 이번 요청에는 내용을 다시 싣지 않았습니다. ${later}.]` };
          let data: Buffer;
          try {
            data = fs.readFileSync(this.filePath({ agentId: b.agentId, id: b.id }));
          } catch {
            return { type: 'text', text: `[첨부 '${b.name}'의 내용 파일을 찾을 수 없습니다. ${later}.]` };
          }
          budget -= data.length;
          slots -= 1;
          if (b.kind === 'image') return { type: 'image', source: { type: 'base64', media_type: b.mediaType, data: data.toString('base64') } };
          if (b.kind === 'pdf') return { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: data.toString('base64') }, title: b.name };
          return { type: 'document', source: { type: 'text', media_type: 'text/plain', data: data.toString('utf8') }, title: b.name };
        }),
      };
    }
    return out;
  }
}
