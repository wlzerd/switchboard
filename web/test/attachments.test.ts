import { describe, expect, it } from 'vitest';
import { attachmentsOf, attachmentUrl, countError, DEFAULT_LIMITS, encodeSteps, fitSize, formatBytes, isPastedName, pastedName, renameFor, shrinkPlan, sizeError, totalError } from '../src/lib/attachments';

const MB = 1024 * 1024;
const L = DEFAULT_LIMITS;

describe('그림 줄이기 판단', () => {
  it.each([
    [4000, 3000, { width: 2576, height: 1932, scaled: true }],
    [1500, 6000, { width: 644, height: 2576, scaled: true }],
    [2576, 2576, { width: 2576, height: 2576, scaled: false }],
    [2577, 10, { width: 2576, height: 10, scaled: true }],
    // 아주 가늘어도 1px 아래로 내려가지 않음
    [20000, 1, { width: 2576, height: 1, scaled: true }],
  ])('%i×%i → %j', (w, h, want) => {
    expect(fitSize(w, h, 2576)).toEqual(want);
  });

  it('모델이 그대로 보는 크기 · 무게면 손대지 않고, 크거나 무겁거나 모델이 못 읽는 형식이면 다시 만듦', () => {
    expect(shrinkPlan('image/png', 2 * MB, { width: 1920, height: 1080 }, L)).toBeNull();
    expect(shrinkPlan('image/png', 2 * MB, { width: 3840, height: 2160 }, L)).toEqual({ width: 2576, height: 1449, type: 'image/png' });
    expect(shrinkPlan('image/jpeg', 8 * MB, { width: 2000, height: 1500 }, L)).toEqual({ width: 2000, height: 1500, type: 'image/jpeg' });
    expect(shrinkPlan('image/webp', 7 * MB, { width: 2576, height: 100 }, L)).toBeNull();
    // 아이폰 사진(HEIC)은 크기가 작아도 JPEG 로
    expect(shrinkPlan('image/heic', 1 * MB, { width: 1000, height: 800 }, L)).toEqual({ width: 1000, height: 800, type: 'image/jpeg' });
    // 움직이는 GIF · SVG · 그림이 아닌 파일은 그대로 (서버가 판단)
    expect(shrinkPlan('image/gif', 30 * MB, { width: 9000, height: 9000 }, L)).toBeNull();
    expect(shrinkPlan('image/svg+xml', 1000, { width: 5000, height: 5000 }, L)).toBeNull();
    expect(shrinkPlan('application/pdf', 1000, { width: 5000, height: 5000 }, L)).toBeNull();
  });

  it('인코딩 순서: 원래 형식 먼저, 그다음 JPEG 품질을 낮춰 가며', () => {
    expect(encodeSteps('image/png')).toEqual([
      { type: 'image/png', quality: 0.9 },
      { type: 'image/jpeg', quality: 0.9 },
      { type: 'image/jpeg', quality: 0.8 },
      { type: 'image/jpeg', quality: 0.7 },
    ]);
    expect(encodeSteps('image/jpeg').map((s) => s.quality)).toEqual([0.9, 0.8, 0.7]);
    expect(encodeSteps('image/webp')[0]).toEqual({ type: 'image/webp', quality: 0.9 });
  });

  it.each([
    ['IMG_0001.HEIC', 'image/jpeg', 'IMG_0001.jpg'],
    ['photo.jpeg', 'image/jpeg', 'photo.jpeg'],
    ['photo.JPG', 'image/jpeg', 'photo.JPG'],
    ['shot.png', 'image/png', 'shot.png'],
    ['shot.png', 'image/jpeg', 'shot.jpg'],
    ['art.webp', 'image/jpeg', 'art.jpg'],
    ['noext', 'image/jpeg', 'noext.jpg'],
    ['.hidden', 'image/png', '.hidden.png'],
    ['a.b.tiff', 'image/jpeg', 'a.b.jpg'],
  ] as const)('형식이 바뀌면 확장자도: %s (%s) → %s', (name, type, want) => {
    expect(renameFor(name, type)).toBe(want);
  });
});

describe('붙여넣은 그림 이름', () => {
  it('브라우저가 주는 image.png 만 바꿉니다', () => {
    expect(['image.png', 'image.PNG', 'image.jpeg', 'image.jpg', 'image.gif', 'image.webp'].every(isPastedName)).toBe(true);
    expect(['image.png.txt', 'my image.png', 'image', 'images.png', '스크린샷.png'].some(isPastedName)).toBe(false);
  });

  it('붙인 시각으로 이름을 짓고, 한 번에 여러 장이면 번호를 붙입니다', () => {
    const t = new Date(2026, 9, 10, 9, 5, 7);
    expect(pastedName('image.png', t, 0)).toBe('붙여넣기 09-05-07.png');
    expect(pastedName('image.JPEG', t, 1)).toBe('붙여넣기 09-05-07-2.jpeg');
  });
});

describe('한도 검사 문구 (서버와 같은 문구)', () => {
  it('개수', () => {
    expect(countError(9, 1, L)).toBeNull();
    expect(countError(9, 2, L)).toBe('메시지 하나에 첨부는 10개까지 붙일 수 있습니다. 지금 11개입니다.');
    expect(countError(0, 11, L)).toBe('메시지 하나에 첨부는 10개까지 붙일 수 있습니다. 지금 11개입니다.');
  });

  it('파일 하나 · 메시지 합계', () => {
    expect(sizeError('a.zip', 10 * MB, L)).toBeNull();
    expect(sizeError('a.zip', 10 * MB + 1, L)).toBe("'a.zip'은(는) 10.0MB로 첨부 한도(10MB)를 넘습니다.");
    expect(totalError([9 * MB, 9 * MB], L)).toBeNull();
    expect(totalError([9 * MB, 9 * MB, 1], L)).toBe('첨부를 모두 합쳐 18.0MB로 한 번에 보낼 수 있는 18.0MB를 넘습니다. 나눠서 보내세요.');
    expect(totalError([], L)).toBeNull();
  });

  it('크기 표시', () => {
    expect([0, 1023, 1024, 10 * 1024 - 1, 10 * 1024, MB - 1, MB, 7.25 * MB].map(formatBytes)).toEqual(['0B', '1023B', '1.0KB', '10.0KB', '10KB', '1024KB', '1.0MB', '7.3MB']);
  });
});

describe('타임라인의 첨부 목록', () => {
  it('모양이 맞는 것만 꺼내고, 크기 정보가 없거나 이상하면 null', () => {
    const data = {
      text: '봐줘',
      attachments: [
        { id: 'att_1', name: '화면.png', kind: 'image', size: 2048, width: 640, height: 480 },
        { id: 'att_2', name: '표.xlsx', kind: 'file', size: 10, width: null, height: null },
        { id: 'att_3', name: '이상한.png', kind: 'image', size: 5, width: 0, height: -3 },
        { id: 'att_4', name: 'x', kind: 'video', size: 1 },
        { id: 5, name: 'y', kind: 'file', size: 1 },
        { id: 'att_6', name: 'z', kind: 'text' },
        null,
        'att_7',
      ],
    };
    expect(attachmentsOf(data)).toEqual([
      { id: 'att_1', name: '화면.png', kind: 'image', size: 2048, width: 640, height: 480 },
      { id: 'att_2', name: '표.xlsx', kind: 'file', size: 10, width: null, height: null },
      { id: 'att_3', name: '이상한.png', kind: 'image', size: 5, width: null, height: null },
    ]);
    expect(attachmentsOf({ text: '글만' })).toEqual([]);
    expect(attachmentsOf({ attachments: 'att_1' })).toEqual([]);
  });

  it('내용 주소는 id 를 그대로 경로에 넣지 않습니다', () => {
    expect(attachmentUrl('att_abc')).toBe('/api/attachments/att_abc');
    expect(attachmentUrl('../x?y')).toBe('/api/attachments/..%2Fx%3Fy');
  });
});
