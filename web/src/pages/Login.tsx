import { useState } from 'react';
import { BrandMark } from '../components/Icon';
import { api, ApiError, errorText } from '../lib/api';

export function LoginPage({ onIn }: { onIn: () => void }) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await api('/api/auth/login', { body: { password } });
      onIn();
    } catch (err) {
      setError(errorText(err));
      if (err instanceof ApiError && err.code === 'password_wrong') setPassword('');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login">
      <form
        className="card"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span className="brand-mark">
            <BrandMark />
          </span>
          <span className="brand-name" style={{ fontSize: 17 }}>
            Switchboard
          </span>
        </div>
        <label className="field">
          관리자 비밀번호
          <input className={`input${error ? ' bad' : ''}`} type="password" autoComplete="current-password" autoFocus value={password} onChange={(e) => setPassword(e.target.value)} />
        </label>
        {error ? (
          <span className="err" role="alert">
            {error}
          </span>
        ) : null}
        <button type="submit" className="btn primary" disabled={busy || password === ''}>
          {busy ? <span className="spinner" style={{ borderTopColor: 'var(--onAccent)' }} /> : null}
          로그인
        </button>
      </form>
    </div>
  );
}
