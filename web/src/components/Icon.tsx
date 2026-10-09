/** 선 아이콘 (직접 그린 단순한 도형) */
const PATHS: Record<string, string> = {
  graph: 'M5.5 9a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5zM18.5 9a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5zM12 20.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5zM8 6.5h8M6.8 8.7l3.9 7M17.2 8.7l-3.9 7',
  terminal: 'M6 4h12a3 3 0 0 1 3 3v10a3 3 0 0 1-3 3H6a3 3 0 0 1-3-3V7a3 3 0 0 1 3-3zM7.5 9.5l3 2.5-3 2.5M13 15h3.5',
  cube: 'M12 3l8 4.5v9L12 21l-8-4.5v-9zM4 7.5l8 4.5 8-4.5M12 12v9',
  shield: 'M12 3l7 3v5.5c0 4.4-3 8.1-7 9.5-4-1.4-7-5.1-7-9.5V6zM9 12l2 2 4-4',
  shieldAlert: 'M12 3l7 3v5.5c0 4.4-3 8.1-7 9.5-4-1.4-7-5.1-7-9.5V6zM12 8.5v4M12 15.5h.01',
  palette: 'M12 3a9 9 0 1 0 0 18c1.1 0 1.7-.8 1.7-1.6 0-.9-.6-1.3-.6-2.1 0-.9.7-1.5 1.6-1.5H17a4 4 0 0 0 4-4C21 6.9 17 3 12 3zM7.5 11h.01M10.5 7.3h.01M15 7.6h.01',
  plus: 'M12 5v14M5 12h14',
  minus: 'M5 12h14',
  search: 'M11 17.5a6.5 6.5 0 1 0 0-13 6.5 6.5 0 0 0 0 13zM20 20l-4.2-4.2',
  bell: 'M6 16v-5a6 6 0 1 1 12 0v5l1.5 2h-15zM10 20.5a2 2 0 0 0 4 0',
  user: 'M12 12a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7zM5 20c1.2-3.5 4-5 7-5s5.8 1.5 7 5',
  logout: 'M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3M10 17l5-5-5-5M15 12H4',
  chat: 'M4 6.5A2.5 2.5 0 0 1 6.5 4h11A2.5 2.5 0 0 1 20 6.5v8a2.5 2.5 0 0 1-2.5 2.5H10l-4.5 3.5V17A2.5 2.5 0 0 1 4 14.5zM9 10.5h.01M15 10.5h.01',
  plane: 'M21 3L10.5 13.5M21 3l-6.5 18-4-7.5L3 9.5z',
  git: 'M6 7.5a2 2 0 1 0 0-4 2 2 0 0 0 0 4zM6 20.5a2 2 0 1 0 0-4 2 2 0 0 0 0 4zM18 10a2 2 0 1 0 0-4 2 2 0 0 0 0 4zM6 7.5v9M18 10c0 4-4 5.5-10.5 7',
  rss: 'M6 19.6a1.6 1.6 0 1 0 0-3.2 1.6 1.6 0 0 0 0 3.2zM4.5 11.5a8 8 0 0 1 8 8M4.5 4.5a15 15 0 0 1 15 15',
  doc: 'M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8zM14 3v5h5M9 13h6M9 17h4',
  link: 'M9.5 14.5l5-5M11 6.5l1.2-1.2a4 4 0 0 1 5.6 5.6L16.6 12M13 17.5l-1.2 1.2a4 4 0 0 1-5.6-5.6L7.4 12',
  globe: 'M12 20.5a8.5 8.5 0 1 0 0-17 8.5 8.5 0 0 0 0 17zM3.5 12h17M12 3.5c2.4 2.5 3.6 5.4 3.6 8.5s-1.2 6-3.6 8.5c-2.4-2.5-3.6-5.4-3.6-8.5s1.2-6 3.6-8.5z',
  code: 'M8.5 7l-5 5 5 5M15.5 7l5 5-5 5',
  folder: 'M3.5 7.5A2 2 0 0 1 5.5 5.5h4l2 2h7a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z',
  bolt: 'M13 3L5 13.5h6L10 21l8-10.5h-6z',
  clock: 'M12 20.5a8.5 8.5 0 1 0 0-17 8.5 8.5 0 0 0 0 17zM12 7.5V12l3 2',
  check: 'M5 12.5l4.5 4.5L19 7.5',
  x: 'M6 6l12 12M18 6L6 18',
  chevronDown: 'M6 9l6 6 6-6',
  chevronRight: 'M9 6l6 6-6 6',
  arrowLeft: 'M19 12H5M11 6l-6 6 6 6',
  arrowRight: 'M5 12h14M13 6l6 6-6 6',
  arrowUp: 'M12 19V5M6 11l6-6 6 6',
  fit: 'M4 9V5h4M16 4h4v4M20 15v4h-4M8 20H4v-4',
  pause: 'M9 6v12M15 6v12',
  play: 'M8 5.5v13l11-6.5z',
  lock: 'M7 11h10a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2zM8 11V8a4 4 0 0 1 8 0v3',
  key: 'M8 19a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM11 12l8-8M16 7l2.5 2.5M14 9l2 2',
  upload: 'M12 16V4M7 9l5-5 5 5M4 16v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3',
  download: 'M12 4v12M7 11l5 5 5-5M4 20h16',
  clip: 'M20 11.5l-7.8 7.8a5 5 0 0 1-7.1-7.1l8.1-8.1a3.4 3.4 0 0 1 4.8 4.8l-8 8a1.7 1.7 0 0 1-2.4-2.4l7.3-7.3',
  refresh: 'M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7',
  trash: 'M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3',
  eye: 'M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z',
  stop: 'M7 7h10v10H7z',
  logs: 'M5 6h14M5 10h14M5 14h9M5 18h6',
};

export type IconName = keyof typeof PATHS;

export function Icon({ name, size = 18, stroke = 1.8, className, title }: { name: IconName | string; size?: number; stroke?: number; className?: string; title?: string }) {
  const d = PATHS[name] ?? PATHS['cube'];
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden={title ? undefined : true} role={title ? 'img' : undefined} className={className} style={{ flex: 'none', fill: 'none', stroke: 'currentColor', strokeWidth: stroke, strokeLinecap: 'round', strokeLinejoin: 'round' }}>
      {title ? <title>{title}</title> : null}
      <path d={d} />
    </svg>
  );
}

export function BrandMark({ size = 18 }: { size?: number }) {
  return <Icon name="graph" size={size} stroke={2.2} />;
}
