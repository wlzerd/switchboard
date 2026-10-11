import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Markdown } from '../src/components/Markdown';

// 콘솔의 에이전트 답변 마크다운: 문법이 요소로 그려지고, HTML · 위험한 링크 · 바깥 그림은 그대로 실행되거나 불리지 않습니다.

const html = (text: string): string => renderToStaticMarkup(createElement(Markdown, { text }));

describe('마크다운 답변', () => {
  it('제목 · 굵게 · 목록 · 인라인 코드 · 코드 블록 · 인용 · 가로줄을 요소로 그립니다', () => {
    const out = html(['## 요약', '', '**중요**한 점:', '', '- 하나', '- `둘`', '', '1. 첫째', '2. 둘째', '', '```js', 'const a = 1;', '```', '', '> 인용', '', '---'].join('\n'));
    expect(out.startsWith('<div class="md">')).toBe(true);
    expect(out).toContain('<h2>요약</h2>');
    expect(out).toContain('<strong>중요</strong>');
    expect(out).toContain('<ul>\n<li>하나</li>\n<li><code>둘</code></li>\n</ul>');
    expect(out).toContain('<ol>\n<li>첫째</li>\n<li>둘째</li>\n</ol>');
    expect(out).toContain('<pre><code class="language-js">const a = 1;\n</code></pre>');
    expect(out).toContain('<blockquote>\n<p>인용</p>\n</blockquote>');
    expect(out).toContain('<hr/>');
  });

  it('GitHub 확장: 표는 가로로 넘치면 스크롤되는 틀 안에, 취소선 · 체크 목록 · 주소 자동 링크', () => {
    const out = html(['| 이름 | 값 |', '|---|---|', '| a | 1 |', '', '~~옛것~~', '', '- [x] 끝남', '- [ ] 남음', '', 'https://example.com 참고'].join('\n'));
    expect(out).toMatch(/<div class="md-table"><table><thead>\s*<tr>\s*<th>이름<\/th>\s*<th>값<\/th>\s*<\/tr>\s*<\/thead><tbody>\s*<tr>\s*<td>a<\/td>\s*<td>1<\/td>/);
    expect(out).toContain('<del>옛것</del>');
    expect(out).toMatch(/<input type="checkbox" disabled="" checked=""\/> ?끝남/);
    expect(out).toMatch(/<input type="checkbox" disabled=""\/> ?남음/);
    expect(out).toContain('<a href="https://example.com" target="_blank" rel="noopener noreferrer">https://example.com</a>');
  });

  it('마크다운 속 HTML 은 실행하지 않고 글자 그대로 보여 줍니다', () => {
    const out = html('보기: <script>alert(1)</script> 그리고\n\n<div onclick="x()">블록</div>');
    expect(out).not.toMatch(/<script|<div onclick/);
    expect(out).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(out).toContain('&lt;div onclick=&quot;x()&quot;&gt;블록&lt;/div&gt;');
  });

  it('링크는 새 탭으로 열고, javascript: 같은 주소는 비웁니다', () => {
    expect(html('[문서](https://docs.example.com/a?b=1)')).toContain('<a href="https://docs.example.com/a?b=1" target="_blank" rel="noopener noreferrer">문서</a>');
    const evil = html('[누르기](javascript:alert(1)) [데이터](data:text/html,x)');
    expect(evil).not.toContain('javascript:');
    expect(evil).not.toContain('data:text/html');
    expect(evil).toContain('<a href="" target="_blank" rel="noopener noreferrer">누르기</a>');
  });

  it('그림은 바깥 주소를 부르지 않도록 링크로 바꿉니다 (설명이 없으면 주소를 글자로)', () => {
    const out = html('![그래프](https://img.example.com/a.png) ![](https://img.example.com/b.png)');
    expect(out).not.toContain('<img');
    expect(out).toContain('<a href="https://img.example.com/a.png" target="_blank" rel="noopener noreferrer">그래프</a>');
    expect(out).toContain('<a href="https://img.example.com/b.png" target="_blank" rel="noopener noreferrer">https://img.example.com/b.png</a>');
  });

  it('문단 안의 한 줄 바꿈은 그대로 남깁니다 (화면에서는 줄을 바꿔 보여 줌)', () => {
    expect(html('첫 줄\n둘째 줄')).toBe('<div class="md"><p>첫 줄\n둘째 줄</p></div>');
    expect(html('')).toBe('<div class="md"></div>');
  });
});
