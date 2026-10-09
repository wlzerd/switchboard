import { useEffect, useState } from 'react';
import { Shell } from './components/Shell';
import { Toasts } from './components/ui';
import { BrandMark } from './components/Icon';
import { api, errorText, setUnauthorizedHandler } from './lib/api';
import { parseRoute, usePath } from './lib/router';
import { connectEvents, disconnectEvents, loadInitial, toast, useApp } from './lib/store';
import { applyTheme, defaultTheme } from './lib/theme';
import { CanvasPage } from './pages/Canvas';
import { ConsolePage } from './pages/Console';
import { GuardPage } from './pages/Guard';
import { HirePage } from './pages/Hire';
import { LoginPage } from './pages/Login';
import { ModulesPage } from './pages/Modules';
import { ProjectsPage } from './pages/Projects';
import { SettingsPage } from './pages/Settings';
import { ThemePage } from './pages/Theme';

type Auth = 'checking' | 'out' | 'in';

export function App() {
  const [auth, setAuth] = useState<Auth>('checking');
  const [loadError, setLoadError] = useState<string | null>(null);
  const overview = useApp((s) => s.overview);
  const meta = useApp((s) => s.meta);
  const theme = useApp((s) => s.theme);
  const route = parseRoute(usePath());

  useEffect(() => {
    setUnauthorizedHandler(() => setAuth('out'));
    api<{ authenticated: boolean }>('/api/auth/session')
      .then((r) => setAuth(r.authenticated ? 'in' : 'out'))
      .catch((err) => {
        setAuth('out');
        toast(errorText(err), 'error');
      });
  }, []);

  useEffect(() => {
    if (auth !== 'in') return;
    setLoadError(null);
    loadInitial().catch((err) => setLoadError(errorText(err)));
    connectEvents();
    return () => disconnectEvents();
  }, [auth]);

  useEffect(() => {
    const t = theme ?? defaultTheme(meta);
    if (t) applyTheme(t);
  }, [theme, meta]);

  const logout = (): void => {
    void api('/api/auth/logout', { body: {} }).finally(() => setAuth('out'));
  };

  if (auth === 'checking') {
    return (
      <div className="login">
        <span className="brand-mark" style={{ width: 44, height: 44, borderRadius: 12, animation: 'pulse 1.6s infinite' }}>
          <BrandMark size={24} />
        </span>
      </div>
    );
  }
  if (auth === 'out') {
    return (
      <>
        <LoginPage onIn={() => setAuth('in')} />
        <Toasts />
      </>
    );
  }

  let page;
  if (loadError) {
    page = (
      <div className="card card-pad" role="alert">
        <b>화면 정보를 불러오지 못했습니다</b>
        <p className="dim">{loadError}</p>
        <button type="button" className="btn" onClick={() => loadInitial().then(() => setLoadError(null)).catch((err) => setLoadError(errorText(err)))}>
          다시 불러오기
        </button>
      </div>
    );
  } else if (!overview || !meta) {
    page = (
      <div className="empty">
        <span className="spinner" />
      </div>
    );
  } else {
    switch (route.page) {
      case 'console':
        page = <ConsolePage agentId={route.param} />;
        break;
      case 'hire':
        page = <HirePage />;
        break;
      case 'projects':
        page = <ProjectsPage projectId={route.param} />;
        break;
      case 'modules':
        page = <ModulesPage />;
        break;
      case 'settings':
        page = <SettingsPage focus={route.param} />;
        break;
      case 'guard':
        page = <GuardPage agentId={route.param} />;
        break;
      case 'theme':
        page = <ThemePage />;
        break;
      default:
        page = <CanvasPage />;
    }
  }

  return (
    <>
      <Shell route={route} onLogout={logout}>
        {page}
      </Shell>
      <Toasts />
    </>
  );
}
