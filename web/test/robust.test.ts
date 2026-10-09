import { describe, expect, it } from 'vitest';
import { slowConstruct } from '../src/lib/guard';
import { originLabel, projectRowView, projectsBy, type ProjectFilter } from '../src/lib/projects';
import { settingsPatch, sourceBadge, stillMissing } from '../src/lib/settings';
import { reconnectDelay } from '../src/lib/store';
import { appendCapped, prependOlder, TIMELINE_KEEP } from '../src/lib/timeline';
import type { ModuleField, ProjectView, TimelineItem } from '../src/lib/types';

const item = (id: number): TimelineItem => ({ id, threadId: 'thr_1', taskId: null, kind: 'user', data: { text: `${id}` }, createdAt: id });
const ids = (list: readonly TimelineItem[]) => list.map((i) => i.id);
const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, k) => item(from + k));

describe('대화 기록 상한', () => {
  it('상한까지는 그대로 붙이고, 넘치면 앞쪽을 버리며 버렸다고 알립니다', () => {
    expect(appendCapped(range(1, 2), item(3), 3)).toEqual({ items: range(1, 3), dropped: false });
    expect(appendCapped(range(1, 3), item(4), 3)).toEqual({ items: range(2, 4), dropped: true });
  });

  it('이미 있는 기록은 다시 붙이지 않습니다', () => {
    expect(ids(appendCapped(range(1, 3), item(2), 3).items)).toEqual([1, 2, 3]);
  });

  it('기본 상한은 TIMELINE_KEEP 이고, 오래 열어 둬도 그 이상 쌓이지 않습니다', () => {
    let list: TimelineItem[] = [];
    for (let i = 1; i <= TIMELINE_KEEP + 50; i += 1) list = appendCapped(list, item(i)).items;
    expect(list).toHaveLength(TIMELINE_KEEP);
    expect(list[0]?.id).toBe(51);
  });

  it('이전 기록을 읽으면 그만큼 상한이 늘어 방금 읽은 기록이 다음 새 메시지에 밀려나지 않습니다', () => {
    const now = range(11, 13);
    const older = prependOlder(now, range(8, 11), 3, 11);
    expect(older).toEqual({ items: range(8, 13), keep: 6 });
    const next = appendCapped(older!.items, item(14), older!.keep);
    expect(ids(next.items)).toEqual([9, 10, 11, 12, 13, 14]);
  });

  it('읽는 사이 맨 앞 기록이 바뀌었으면(앞쪽이 잘렸거나 다른 대화) 붙이지 않습니다', () => {
    expect(prependOlder(range(12, 14), range(8, 10), 3, 11)).toBeNull();
    expect(prependOlder([], range(8, 10), 3, 11)).toBeNull();
  });
});

describe('다시 붙기 간격', () => {
  it.each([
    [0, 1000],
    [1, 1000],
    [2, 2000],
    [3, 4000],
    [4, 8000],
    [5, 15_000],
    [50, 15_000],
    [1e9, 15_000],
  ])('%s번째 → %sms', (retry, ms) => {
    expect(reconnectDelay(retry)).toBe(ms);
  });
});

describe('느려질 수 있는 정규식 (서버와 같은 판단)', () => {
  it.each([
    ['(a)\\1', '역참조'],
    ['(?<x>a)\\k<x>', '역참조'],
    ['foo(?=bar)', '앞 보기'],
    ['foo(?!bar)', '앞 보기'],
  ])('%s → 거절', (source, word) => {
    expect(slowConstruct(source)).toContain(word);
  });

  it.each([
    ['(?<=\\$)\\d+'],
    ['(?<!-)\\d+'],
    ['\\\\1'],
    ['[\\1]'],
    ['[(?=]'],
    ['\\(?=x'],
    ['\\k'],
    ['(?:ab)+'],
    [''],
  ])('%s → 통과', (source) => {
    expect(slowConstruct(source)).toBeNull();
  });
});

const project = (over: Partial<ProjectView>): ProjectView => ({
  id: 'prj_1',
  agentId: 'agt_1',
  name: 'shop',
  path: '/data/ws/shop',
  displayPath: '작업 폴더/shop',
  note: '주문 API',
  origin: 'instruction',
  originDetail: '웹 콘솔',
  watch: false,
  auto: false,
  createdAt: 1,
  lastActivityAt: null,
  lastActivity: null,
  status: 'ok',
  mode: 'write',
  area: '작업 폴더',
  isGit: true,
  ...over,
});

describe('관리 중인 프로젝트 목록', () => {
  const list = [
    project({ id: 'a', name: 'Shop', agentId: 'agt_1', origin: 'instruction' }),
    project({ id: 'b', name: 'blog', path: '/srv/blog', displayPath: '/srv/blog', note: '', agentId: 'agt_2', origin: 'self' }),
    project({ id: 'c', name: 'infra', note: 'SHOP 배포', agentId: 'agt_2', origin: 'manual' }),
  ];
  const all: ProjectFilter = { agent: 'all', origin: 'all', query: '' };

  it('에이전트 · 계기 · 검색어(이름 · 경로 · 메모, 대소문자 무시)로 거르고 순서는 그대로', () => {
    expect(projectsBy(list, all).map((p) => p.id)).toEqual(['a', 'b', 'c']);
    expect(projectsBy(list, { ...all, agent: 'agt_2' }).map((p) => p.id)).toEqual(['b', 'c']);
    expect(projectsBy(list, { ...all, origin: 'self' }).map((p) => p.id)).toEqual(['b']);
    expect(projectsBy(list, { ...all, query: '  shop ' }).map((p) => p.id)).toEqual(['a', 'c']);
    expect(projectsBy(list, { ...all, query: '/SRV' }).map((p) => p.id)).toEqual(['b']);
    expect(projectsBy(list, { agent: 'agt_1', origin: 'manual', query: '' })).toEqual([]);
  });

  it('계기 이름', () => {
    expect([originLabel('instruction'), originLabel('self'), originLabel('delegation'), originLabel('manual')]).toEqual(['사용자 지시', '스스로', '위임', '직접 등록']);
  });

  const hb = (enabled: boolean) => ({ heartbeat: { enabled, everyMinutes: 30, activeHours: null, checklist: '', lastAt: null } });

  it.each([
    ['점검 안 함', { watch: false }, hb(true), false, ''],
    ['점검 · 하트비트 켜짐', { watch: true }, hb(true), true, '점검 30분'],
    ['점검 · 하트비트 꺼짐', { watch: true }, hb(false), false, '하트비트 꺼짐'],
    ['점검 · 하트비트 없음', { watch: true }, { heartbeat: null }, false, '하트비트 꺼짐'],
    ['점검 · 경로 없어짐', { watch: true, status: 'missing' as const }, hb(true), false, '점검 멈춤'],
    ['점검 · 허용 폴더 밖', { watch: true, status: 'denied' as const }, hb(true), false, '점검 멈춤'],
  ])('%s', (_label, over, agent, on, text) => {
    const v = projectRowView(project(over), agent);
    expect(v.watchOn).toBe(on);
    expect(v.watchText).toBe(text);
  });

  it('줄 앞 그림: 없어진 경로 · git · 일반 폴더', () => {
    expect(projectRowView(project({ status: 'missing' }), undefined).tile).toBe('missing');
    expect(projectRowView(project({ isGit: true }), undefined).tile).toBe('git');
    expect(projectRowView(project({ isGit: false }), undefined).tile).toBe('folder');
  });
});

const field = (over: Partial<ModuleField>): ModuleField => ({
  name: 'EMAIL_IMAP_HOST',
  label: 'IMAP 서버',
  description: '',
  required: true,
  secret: false,
  source: 'empty',
  value: null,
  last4: null,
  envAlso: false,
  url: null,
  ...over,
});

describe('모듈 설정 저장 값', () => {
  const host = field({ source: 'db', value: 'imap.example.com' });
  const pass = field({ name: 'EMAIL_PASSWORD', label: '앱 비밀번호', secret: true, source: 'db', last4: '9876' });
  const port = field({ name: 'EMAIL_IMAP_PORT', label: '포트', required: false, source: 'env', value: '993', envAlso: true });

  it('고친 칸만 보내고, 그대로인 칸은 보내지 않습니다', () => {
    expect(settingsPatch([host, pass, port], {})).toEqual({});
    expect(settingsPatch([host], { EMAIL_IMAP_HOST: ' imap.example.com ' })).toEqual({});
    expect(settingsPatch([host], { EMAIL_IMAP_HOST: 'mail.example.com' })).toEqual({ EMAIL_IMAP_HOST: 'mail.example.com' });
  });

  it('비밀값은 새로 입력했을 때만 보냅니다 (빈 칸은 그대로 둠)', () => {
    expect(settingsPatch([pass], { EMAIL_PASSWORD: '' })).toEqual({});
    expect(settingsPatch([pass], { EMAIL_PASSWORD: ' new-pass ' })).toEqual({ EMAIL_PASSWORD: 'new-pass' });
  });

  it('비우면 DB 값만 지우고(null), .env 에서 읽는 값은 지울 수 없어 보내지 않습니다', () => {
    expect(settingsPatch([host], { EMAIL_IMAP_HOST: '  ' })).toEqual({ EMAIL_IMAP_HOST: null });
    expect(settingsPatch([port], { EMAIL_IMAP_PORT: '' })).toEqual({});
    expect(settingsPatch([port], { EMAIL_IMAP_PORT: '143' })).toEqual({ EMAIL_IMAP_PORT: '143' });
  });

  it('저장해도 비는 필수 값', () => {
    const empty = field({});
    const locked = field({ name: 'EMAIL_PASSWORD', label: '앱 비밀번호', secret: true, source: 'locked' });
    expect(stillMissing([empty, locked], {})).toEqual(['IMAP 서버', '앱 비밀번호']);
    expect(stillMissing([empty, locked], { EMAIL_IMAP_HOST: 'x', EMAIL_PASSWORD: 'y' })).toEqual([]);
    // 비밀값 빈 칸은 '그대로'라 저장된 값이 있으면 비지 않습니다.
    expect(stillMissing([pass], { EMAIL_PASSWORD: '' })).toEqual([]);
    // DB 값을 지우면 .env 에 값이 있을 때만 채워집니다.
    expect(stillMissing([host], { EMAIL_IMAP_HOST: '' })).toEqual(['IMAP 서버']);
    expect(stillMissing([{ ...host, envAlso: true }], { EMAIL_IMAP_HOST: '' })).toEqual([]);
    expect(stillMissing([field({ source: 'env', value: 'x' })], { EMAIL_IMAP_HOST: '' })).toEqual([]);
    expect(stillMissing([field({ required: false })], {})).toEqual([]);
  });

  it('값 출처 표시', () => {
    expect(sourceBadge(pass)).toEqual({ text: 'DB · 암호화', tone: 'ok' });
    expect(sourceBadge(host)).toEqual({ text: 'DB', tone: 'msg' });
    expect(sourceBadge(port)).toEqual({ text: '.env에서 읽는 중', tone: 'warn' });
    expect(sourceBadge(field({ source: 'locked', secret: true }))).toEqual({ text: '풀 수 없음 · 다시 입력', tone: 'bad' });
    expect(sourceBadge(field({}))).toEqual({ text: '비어 있음 · 필수', tone: 'bad' });
    expect(sourceBadge(field({ required: false }))).toEqual({ text: '기본값', tone: '' });
  });
});
