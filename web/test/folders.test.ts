import { describe, expect, it } from 'vitest';
import { FOLDERS_MAX, folderChanges, folderInputProblem, normalizeFolderInput, type FolderView } from '../src/lib/folders';

describe('허용 폴더 입력', () => {
  it('끝 슬래시와 공백을 지우되 / 와 ~/ 자체는 남깁니다', () => {
    expect(normalizeFolderInput('  ~/Documents/보고서///  ')).toBe('~/Documents/보고서');
    expect(normalizeFolderInput('/')).toBe('/');
    expect(normalizeFolderInput('~/')).toBe('~/');
  });

  it.each([
    ['', '폴더 경로를 입력하세요'],
    ['   ', '폴더 경로를 입력하세요'],
    ['~bob/docs', '다른 사용자의 홈'],
    ['~', '홈 폴더 전체'],
    ['~/', '홈 폴더 전체'],
    ['/', '디스크 전체'],
    ['Documents', '/ 나 ~/ 로 시작'],
    ['C:\\Users\\me', '/ 나 ~/ 로 시작'],
  ])('%j → %s', (raw, want) => {
    expect(folderInputProblem(raw, [])).toContain(want);
  });

  it('같은 폴더를 끝 슬래시만 바꿔 다시 넣으면 거절', () => {
    expect(folderInputProblem('~/docs/', [{ path: '~/docs', mode: 'read' }])).toContain('이미 넣은');
    expect(folderInputProblem('~/docs2', [{ path: '~/docs', mode: 'read' }])).toBeNull();
  });

  it(`개수 경계: ${FOLDERS_MAX - 1}개일 때는 하나 더, ${FOLDERS_MAX}개면 더 못 넣음`, () => {
    const list = (n: number): FolderView[] => Array.from({ length: n }, (_, i) => ({ path: `/data/f${i}`, mode: 'read' }));
    expect(folderInputProblem('/data/new', list(FOLDERS_MAX - 1))).toBeNull();
    expect(folderInputProblem('/data/new', list(FOLDERS_MAX))).toContain(`${FOLDERS_MAX}개까지`);
  });
});

describe('허용 폴더 변경 수', () => {
  const base: FolderView[] = [
    { path: '~/docs', mode: 'read' },
    { path: '/data/x', mode: 'write' },
  ];

  it('같으면 0, 끝 슬래시만 달라도 같은 폴더', () => {
    expect(folderChanges(base, [...base])).toBe(0);
    expect(folderChanges(base, [{ path: '~/docs/', mode: 'read' }, { path: '/data/x', mode: 'write' }])).toBe(0);
  });

  it('추가 · 삭제 · 범위 변경을 하나씩 셉니다', () => {
    expect(folderChanges(base, [...base, { path: '/data/y', mode: 'read' }])).toBe(1);
    expect(folderChanges(base, [base[0] as FolderView])).toBe(1);
    expect(folderChanges(base, [{ path: '~/docs', mode: 'write' }, { path: '/data/x', mode: 'write' }])).toBe(1);
    expect(folderChanges(base, [{ path: '/data/z', mode: 'read' }])).toBe(3);
  });
});
