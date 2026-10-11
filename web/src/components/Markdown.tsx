import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';

/**
 * 에이전트 답변의 마크다운: 제목 · 목록 · 코드 · 인용 · 표 · 취소선 · 체크 목록 · 주소 자동 링크 (GitHub 확장 포함).
 * HTML 문자열로 끼워 넣지 않고 React 요소로 그립니다. 마크다운 속 HTML 은 실행하지 않고 글자 그대로 보여 주고,
 * 링크는 새 탭으로 열며(javascript: 같은 주소는 렌더러가 비움), 그림은 바깥 주소를 저절로 부르지 않도록 링크로 바꿉니다.
 */

type MdNode = { type: string; children?: MdNode[] };

/** 마크다운 속 HTML 을 글자로 바꿉니다 (트리는 재귀 대신 스택으로 돕니다). */
function htmlAsText() {
  return (tree: MdNode): void => {
    const stack: MdNode[] = [tree];
    while (stack.length > 0) {
      const node = stack.pop() as MdNode;
      if (node.type === 'html') node.type = 'text';
      if (node.children) stack.push(...node.children);
    }
  };
}

const PLUGINS = [remarkGfm, htmlAsText];

const COMPONENTS: Components = {
  a: ({ href, children }) => (
    <a href={href} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  ),
  img: ({ src, alt }) =>
    typeof src === 'string' && src !== '' ? (
      <a href={src} target="_blank" rel="noopener noreferrer">
        {alt || src}
      </a>
    ) : (
      <>{alt}</>
    ),
  table: ({ children }) => (
    <div className="md-table">
      <table>{children}</table>
    </div>
  ),
};

export function Markdown({ text }: { text: string }) {
  return (
    <div className="md">
      <ReactMarkdown remarkPlugins={PLUGINS} components={COMPONENTS}>
        {text}
      </ReactMarkdown>
    </div>
  );
}
