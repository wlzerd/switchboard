import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { detect, formatBytes, imageSize, imageType, safeName, TEXT_INLINE_MAX } from '../src/attachments/media.ts';
import { SEND_MAX_BLOCKS, STALE_MS } from '../src/attachments/service.ts';
import { buildServer } from '../src/http/server.ts';
import { lastUserText, startHarness, until, type Harness } from './helpers/harness.ts';

/* ───────── 그림 머리 만들기 ───────── */
const PNG_1x1 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC', 'base64');
function png(width: number, height: number): Buffer {
  const b = Buffer.from(PNG_1x1);
  b.writeUInt32BE(width, 16);
  b.writeUInt32BE(height, 20);
  return b;
}
function jpeg(width: number, height: number): Buffer {
  const app0 = Buffer.from([0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00]);
  const sof = Buffer.alloc(19);
  sof.writeUInt16BE(0xffc0, 0);
  sof.writeUInt16BE(17, 2);
  sof[4] = 8;
  sof.writeUInt16BE(height, 5);
  sof.writeUInt16BE(width, 7);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, Buffer.from([0xff, 0xff]), sof, Buffer.from([0xff, 0xd9])]);
}
function gif(width: number, height: number): Buffer {
  const b = Buffer.alloc(13);
  b.write('GIF89a', 0, 'latin1');
  b.writeUInt16LE(width, 6);
  b.writeUInt16LE(height, 8);
  return b;
}
function webpX(width: number, height: number): Buffer {
  const b = Buffer.alloc(30);
  b.write('RIFF', 0, 'latin1');
  b.writeUInt32LE(22, 4);
  b.write('WEBP', 8, 'latin1');
  b.write('VP8X', 12, 'latin1');
  b.writeUInt32LE(10, 16);
  b.writeUIntLE(width - 1, 24, 3);
  b.writeUIntLE(height - 1, 27, 3);
  return b;
}

describe('첨부 형식 판정', () => {
  it.each([
    ['PNG', png(640, 480), 'image/png'],
    ['JPEG', jpeg(1920, 1080), 'image/jpeg'],
    ['GIF', gif(32, 16), 'image/gif'],
    ['WebP', webpX(3000, 2000), 'image/webp'],
  ])('%s: 형식과 크기를 머리에서 읽음', (_n, buf, type) => {
    expect(imageType(buf)).toBe(type);
    expect(imageSize(buf, type)).not.toBeNull();
  });

  it('크기 값', () => {
    expect(imageSize(png(640, 480), 'image/png')).toEqual({ width: 640, height: 480 });
    expect(imageSize(jpeg(1920, 1080), 'image/jpeg')).toEqual({ width: 1920, height: 1080 });
    expect(imageSize(gif(32, 16), 'image/gif')).toEqual({ width: 32, height: 16 });
    expect(imageSize(webpX(3000, 2000), 'image/webp')).toEqual({ width: 3000, height: 2000 });
    // 잘린 머리 · 끝없는 표식은 null (멈춤)
    expect(imageSize(png(1, 1).subarray(0, 20), 'image/png')).toBeNull();
    expect(imageSize(Buffer.from([0xff, 0xd8, ...new Array(64).fill(0xff)]), 'image/jpeg')).toBeNull();
  });

  it('PDF · 텍스트 · 그 밖의 파일 (SVG 는 그림이 아니라 파일)', () => {
    expect(detect('a.pdf', Buffer.from('%PDF-1.7\n...')).kind).toBe('pdf');
    expect(detect('notes.md', Buffer.from('# 제목\n본문')).kind).toBe('text');
    expect(detect('logo.svg', Buffer.from('<svg><script>alert(1)</script></svg>'))).toMatchObject({ kind: 'file', mediaType: 'image/svg+xml' });
    expect(detect('data.bin', Buffer.from([0, 1, 2, 3])).kind).toBe('file');
    expect(detect('big.log', Buffer.alloc(TEXT_INLINE_MAX + 1, 'a')).kind).toBe('file');
    expect(detect('ok.log', Buffer.alloc(TEXT_INLINE_MAX, 'a')).kind).toBe('text');
    expect(detect('broken.txt', Buffer.from([0xc3, 0x28])).kind).toBe('file');
  });

  it.each([
    ['보고서.pdf', '보고서.pdf'],
    ['../../etc/passwd', 'passwd'],
    ['C:\\Users\\kim\\a.png', 'a.png'],
    ['a<b>:c"d|e?f*.txt', 'a_b__c_d_e_f_.txt'],
    ['  공백   많은   이름.txt  ', '공백 많은 이름.txt'],
    ['tab\tnew\nline.txt', 'tabnewline.txt'],
    ['..', null],
    ['', null],
    [42, null],
  ])('이름 %j → %j', (raw, expected) => {
    expect(safeName(raw)).toBe(expected);
  });

  it('긴 이름은 확장자를 살려 120자로', () => {
    const n = safeName(`${'가'.repeat(200)}.xlsx`) as string;
    expect(n).toHaveLength(120);
    expect(n.endsWith('.xlsx')).toBe(true);
  });

  it('크기 표시', () => {
    expect([formatBytes(512), formatBytes(2048), formatBytes(20 * 1024), formatBytes(3.5 * 1024 * 1024)]).toEqual(['512B', '2.0KB', '20KB', '3.5MB']);
  });
});

/* ───────── 서비스 · 실행 · HTTP ───────── */

let h: Harness;
beforeAll(async () => {
  h = await startHarness({ ATTACHMENT_MAX_MB: '1', ATTACHMENTS_PER_MESSAGE: '3', AGENT_QUEUE_MAX: '1' });
});
afterAll(async () => {
  await h.close();
});

const ws = (agentId: string) => path.join(h.app.config.dataDir, 'workspaces', agentId);

describe('첨부 저장 검사', () => {
  it('빈 파일 · 한도 초과 · 비밀 파일 이름 · 비밀값이 든 글 · 너무 큰 그림 · 깨진 그림은 이유와 함께 거절', () => {
    const a = h.addAgent('첨부검사');
    const save = (name: string, data: Buffer) => () => h.app.attachments.save(a, name, data);
    expect(save('a.txt', Buffer.alloc(0))).toThrow("'a.txt'은(는) 빈 파일입니다.");
    expect(save('big.bin', Buffer.alloc(1024 * 1024 + 1))).toThrow("'big.bin'은(는) 1.0MB로 첨부 한도(1MB)를 넘습니다.");
    expect(save('.env', Buffer.from('A=1'))).toThrow("'.env'은(는) 비밀 파일로 보이는 이름이라 첨부하지 않았습니다");
    expect(save('id_rsa', Buffer.from('x'))).toThrow('비밀 파일');
    expect(save('memo.txt', Buffer.from(`줄 하나\n키: sk-ant-api03-${'k'.repeat(30)}`))).toThrow("'memo.txt'에 비밀값(Anthropic API 키)이 들어 있어 첨부하지 않았습니다");
    expect(save('huge.png', png(9000, 100))).toThrow("그림 'huge.png'이(가) 9000×100px로 모델이 받는 최대 크기(8000px)를 넘습니다.");
    expect(save('cut.png', png(10, 10).subarray(0, 20))).toThrow("그림 'cut.png'의 크기를 읽지 못했습니다");
    expect(h.app.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM attachments WHERE agent_id = :id', { id: a.id })?.n).toBe(0);
  });

  it('붙일 첨부 확인: 다른 에이전트 것 · 이미 보낸 것 · 개수 초과', () => {
    const a = h.addAgent('첨부주인');
    const b = h.addAgent('남의것');
    const mine = h.app.attachments.save(a, 'a.txt', Buffer.from('안녕'));
    const other = h.app.attachments.save(b, 'b.txt', Buffer.from('안녕'));
    expect(() => h.app.attachments.take(a, [other.id])).toThrow(`첨부 '${other.id}'을(를) 찾을 수 없습니다`);
    expect(() => h.app.attachments.take(a, 'x')).toThrow('attachments 는 첨부 id 배열이어야 합니다.');
    const four = [mine.id, ...[1, 2, 3].map((i) => h.app.attachments.save(a, `${i}.txt`, Buffer.from(String(i))).id)];
    expect(() => h.app.attachments.take(a, four)).toThrow('메시지 하나에 첨부는 3개까지 붙일 수 있습니다. 지금 4개입니다.');
    const used = h.app.attachments.commit(a, h.app.attachments.take(a, [mine.id]));
    expect(() => h.app.attachments.take(a, [used[0]!.id])).toThrow("'a.txt'은(는) 이미 보낸 첨부입니다.");
  });

  it('보내면 작업 폴더 uploads/<날짜>/ 에 복사하고, 같은 이름은 (2) 를 붙입니다', () => {
    const a = h.addAgent('복사이');
    const now = new Date(2026, 9, 10, 12, 0).getTime();
    const one = h.app.attachments.save(a, '보고서.txt', Buffer.from('첫째'), now);
    const two = h.app.attachments.save(a, '보고서.txt', Buffer.from('둘째'), now);
    const done = h.app.attachments.commit(a, [one, two], now);
    expect(done.map((x) => x.workspacePath)).toEqual(['uploads/2026-10-10/보고서.txt', 'uploads/2026-10-10/보고서 (2).txt']);
    expect(fs.readFileSync(path.join(ws(a.id), 'uploads/2026-10-10/보고서 (2).txt'), 'utf8')).toBe('둘째');
    expect(h.app.store.getAttachment(one.id).usedAt).toBe(now);
  });

  it('보내지 않은 첨부는 하루가 지나면 지우고, 보낸 첨부는 남깁니다', () => {
    const a = h.addAgent('정리이');
    const t0 = Date.now() - STALE_MS - 1000;
    const unsent = h.app.attachments.save(a, 'old.txt', Buffer.from('x'), t0);
    const sent = h.app.attachments.save(a, 'kept.txt', Buffer.from('y'), t0);
    h.app.attachments.commit(a, [sent], t0);
    const removed = h.app.attachments.prune();
    expect(removed).toBeGreaterThanOrEqual(1);
    expect(h.app.store.findAttachment(unsent.id)).toBeNull();
    expect(fs.existsSync(h.app.attachments.filePath(unsent))).toBe(false);
    expect(h.app.store.findAttachment(sent.id)).not.toBeNull();
  });
});

describe('모델에 보내기', () => {
  it('그림은 글보다 앞에 이름표와 함께 실리고, 글 파일은 문서로, 못 보내는 파일은 작업 폴더 경로로 알려 줍니다', async () => {
    const a = h.addAgent('보는이');
    h.scripts.set(a.keyId, () => ({ text: '봤습니다' }));
    const img = h.app.attachments.save(a, '화면.png', PNG_1x1);
    const txt = h.app.attachments.save(a, '로그.txt', Buffer.from('ERROR 42'));
    const bin = h.app.attachments.save(a, '표.xlsx', Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0, 0xff]));
    const files = h.app.attachments.commit(a, h.app.attachments.take(a, [img.id, txt.id, bin.id]));
    const task = h.app.manager.enqueue({ agentId: a.id, source: 'console', sourceLabel: '웹 콘솔', origin: 'console', text: '이 오류 봐줘', reply: null, attachments: files });
    await until(() => h.app.store.getTask(task.id).status === 'done', '작업 끝');
    const msgs = h.calls.get(a.keyId)![0]!.messages;
    const content = msgs.at(-1)!.content as Record<string, unknown>[];
    expect(content.map((b) => b['type'])).toEqual(['text', 'image', 'text', 'document', 'text']);
    expect(content[0]!['text']).toMatch(/^첨부 1: 화면\.png \(작업 폴더 uploads\/\d{4}-\d{2}-\d{2}\/화면\.png 에도 저장됨\)$/);
    expect(content[1]).toEqual({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG_1x1.toString('base64') } });
    expect(content[3]).toEqual({ type: 'document', source: { type: 'text', media_type: 'text/plain', data: 'ERROR 42' }, title: '로그.txt' });
    expect(String(content[4]!['text'])).toContain('이 오류 봐줘');
    expect(String(content[4]!['text'])).toMatch(/첨부 3: 표\.xlsx \(7B\) — 모델에 바로 보낼 수 없는 형식이라 작업 폴더 uploads\/[\d-]+\/표\.xlsx 에만 두었습니다/);
    // 대화 기록에는 내용 대신 참조만 저장합니다.
    const stored = JSON.stringify(h.app.store.listMessages(h.app.store.listThreads(a.id)[0]!.id).at(0)!.content);
    expect(stored).toContain('"type":"attachment"');
    expect(stored).not.toContain(PNG_1x1.toString('base64'));
    // 타임라인의 사용자 메시지에 첨부 목록이 붙습니다.
    const item = h.app.store.listTimeline(h.app.store.listThreads(a.id)[0]!.id, 10).find((i) => i.kind === 'user')!;
    expect((item.data['attachments'] as { name: string }[]).map((x) => x.name)).toEqual(['화면.png', '로그.txt', '표.xlsx']);
  });

  it('요청 한 번에는 최근 첨부부터 그림 · 문서 20개까지만 싣고, 앞의 것과 지워진 것은 경로 안내로 바꿉니다', () => {
    const a = h.addAgent('많이보낸이');
    const history: { role: 'user' | 'assistant'; content: unknown }[] = [];
    let first: { id: string; name: string } | null = null;
    for (let i = 0; i < SEND_MAX_BLOCKS + 2; i += 1) {
      const row = h.app.attachments.save(a, `${i}.png`, PNG_1x1);
      const [done] = h.app.attachments.commit(a, [row]);
      first ??= { id: done!.id, name: done!.name };
      history.push({ role: 'user', content: h.app.attachments.messageContent(`${i}번째`, [done!]) });
      history.push({ role: 'assistant', content: [{ type: 'text', text: 'ok' }] });
    }
    fs.rmSync(h.app.attachments.filePath({ agentId: a.id, id: (history.at(-2)!.content as { id?: string }[])[1]!.id! }));
    const out = h.app.attachments.expand(history);
    const kinds = out.filter((m) => m.role === 'user').map((m) => (m.content as Record<string, unknown>[])[1]!);
    expect(kinds.filter((b) => b['type'] === 'image')).toHaveLength(SEND_MAX_BLOCKS);
    expect(String(kinds[0]!['text'])).toContain(`[첨부 '${first!.name}'은(는) 앞에서 보낸 것이라 이번 요청에는 내용을 다시 싣지 않았습니다. 작업 폴더의 uploads/`);
    expect(String(kinds.at(-1)!['text'])).toContain("의 내용 파일을 찾을 수 없습니다");
    // 입력은 바뀌지 않습니다.
    expect((history[0]!.content as Record<string, unknown>[])[1]!['type']).toBe('attachment');
  });
});

describe('HTTP: 올리기 · 보기 · 지우기 · 보내기', () => {
  let server: FastifyInstance;
  let cookie = '';
  beforeAll(async () => {
    server = await buildServer(h.app);
    const r = await server.inject({ method: 'POST', url: '/api/auth/login', payload: { password: 'harness-test-password' } });
    cookie = String(r.headers['set-cookie']).split(';')[0] ?? '';
  });
  afterAll(async () => {
    await server.close();
  });
  const upload = (agentId: string, name: string, body: Buffer) =>
    server.inject({ method: 'POST', url: `/api/agents/${agentId}/attachments`, headers: { cookie, 'content-type': 'application/octet-stream', 'x-file-name': encodeURIComponent(name) }, payload: body });

  it('그림을 올리고 바로 보이게, 글 파일은 내려받게 (실행되지 않게) 돌려줍니다', async () => {
    const a = h.addAgent('올리는이');
    const up = await upload(a.id, '스크린샷 1.png', PNG_1x1);
    expect(up.statusCode).toBe(201);
    expect(up.json().attachment).toMatchObject({ name: '스크린샷 1.png', kind: 'image', size: PNG_1x1.length, width: 1, height: 1 });
    const img = await server.inject({ method: 'GET', url: `/api/attachments/${up.json().attachment.id}`, headers: { cookie } });
    expect(img.headers['content-type']).toBe('image/png');
    expect(img.headers['content-disposition']).toBe(`inline; filename*=UTF-8''${encodeURIComponent('스크린샷 1.png')}`);
    expect(img.headers['x-content-type-options']).toBe('nosniff');
    expect(img.headers['content-security-policy']).toContain('sandbox');
    expect(img.rawPayload.equals(PNG_1x1)).toBe(true);

    const html = await upload(a.id, 'page.html', Buffer.from('<script>alert(1)</script>'));
    const got = await server.inject({ method: 'GET', url: `/api/attachments/${html.json().attachment.id}`, headers: { cookie } });
    expect(got.headers['content-type']).toBe('text/plain; charset=utf-8');
    expect(String(got.headers['content-disposition'])).toMatch(/^attachment;/);
    // 로그인 없이는 볼 수 없습니다.
    expect((await server.inject({ method: 'GET', url: `/api/attachments/${up.json().attachment.id}` })).statusCode).toBe(401);
  });

  it('한도를 넘는 파일은 413 과 첨부 한도 문구, JSON 으로 보내면 거절', async () => {
    const a = h.addAgent('큰파일');
    const big = await upload(a.id, 'big.bin', Buffer.alloc(1024 * 1024 + 70 * 1024));
    expect(big.statusCode).toBe(413);
    expect(big.json().error.message).toBe('첨부 파일이 한도(1MB)를 넘습니다.');
    const json = await server.inject({ method: 'POST', url: `/api/agents/${a.id}/attachments`, headers: { cookie }, payload: { a: 1 } });
    expect(json.statusCode).toBe(400);
    expect(json.json().error.message).toBe('파일 내용을 Content-Type: application/octet-stream 으로 보내세요.');
    const form = await server.inject({ method: 'POST', url: `/api/agents/${a.id}/attachments`, headers: { cookie, 'content-type': 'multipart/form-data; boundary=x' }, payload: '--x--' });
    expect(form.statusCode).toBe(415);
    expect(form.json().error.message).toBe('파일 내용을 Content-Type: application/octet-stream 으로 보내세요.');
    // 다른 주소는 그대로 JSON 을 요구합니다.
    const other = await server.inject({ method: 'POST', url: `/api/agents/${a.id}/messages`, headers: { cookie, 'content-type': 'application/octet-stream' }, payload: Buffer.from('x') });
    expect(other.json().error.message).toBe('요청 본문은 JSON 객체여야 합니다.');
  });

  it('보내기 전에는 지울 수 있고, 보낸 뒤에는 지울 수 없습니다. 글 없이 첨부만 보내도 되고, 둘 다 없으면 거절', async () => {
    const a = h.addAgent('보내는이', { paused: true });
    const x = (await upload(a.id, 'x.txt', Buffer.from('x'))).json().attachment.id as string;
    expect((await server.inject({ method: 'DELETE', url: `/api/attachments/${x}`, headers: { cookie } })).statusCode).toBe(200);
    const y = (await upload(a.id, 'y.png', PNG_1x1)).json().attachment.id as string;
    const sent = await server.inject({ method: 'POST', url: `/api/agents/${a.id}/messages`, headers: { cookie }, payload: { text: '', attachments: [y] } });
    expect(sent.statusCode).toBe(202);
    expect(sent.json().task.title).toBe('첨부 · y.png');
    const del = await server.inject({ method: 'DELETE', url: `/api/attachments/${y}`, headers: { cookie } });
    expect(del.statusCode).toBe(409);
    const empty = await server.inject({ method: 'POST', url: `/api/agents/${a.id}/messages`, headers: { cookie }, payload: { text: '  ' } });
    expect(empty.json().error.message).toBe('지시 내용을 입력하거나 파일을 첨부하세요.');
  });

  it('대기열이 가득 차 작업을 넣지 못하면 첨부의 보냄 표시와 작업 폴더 사본을 되돌립니다', async () => {
    const a = h.addAgent('가득이', { paused: true });
    expect((await server.inject({ method: 'POST', url: `/api/agents/${a.id}/messages`, headers: { cookie }, payload: { text: '첫 일' } })).statusCode).toBe(202);
    const z = (await upload(a.id, 'z.txt', Buffer.from('z'))).json().attachment.id as string;
    const full = await server.inject({ method: 'POST', url: `/api/agents/${a.id}/messages`, headers: { cookie }, payload: { text: '둘째 일', attachments: [z] } });
    expect(full.statusCode).toBe(429);
    expect(h.app.store.getAttachment(z)).toMatchObject({ usedAt: null, workspacePath: null });
    const day = fs.readdirSync(path.join(ws(a.id), 'uploads'));
    expect(day.flatMap((d) => fs.readdirSync(path.join(ws(a.id), 'uploads', d)))).toEqual([]);
  });

  it('meta 에 화면이 쓰는 첨부 한도가 들어 있습니다', async () => {
    const meta = (await server.inject({ method: 'GET', url: '/api/meta', headers: { cookie } })).json();
    expect(meta.attachments).toEqual({ maxBytes: 1024 * 1024, perMessage: 3, messageMaxBytes: 18 * 1024 * 1024, imageMaxBytes: 7 * 1024 * 1024, imageSendEdge: 2576 });
  });

  it('모델 호출 결과에 그림이 실립니다 (lastUserText 로 확인)', async () => {
    const a = h.addAgent('확인이');
    h.scripts.set(a.keyId, () => ({ text: 'ok' }));
    const id = (await upload(a.id, 'cat.png', PNG_1x1)).json().attachment.id as string;
    await server.inject({ method: 'POST', url: `/api/agents/${a.id}/messages`, headers: { cookie }, payload: { text: '이 그림 설명해줘', attachments: [id] } });
    await until(() => h.calls.get(a.keyId)?.length === 1, '모델 호출');
    expect(lastUserText(h.calls.get(a.keyId)![0]!)).toContain('"type":"image"');
  });
});
