import { useEffect, useState } from 'react';
import { Auth } from './auth/Auth.js';
import { tracedFetch } from './traced-fetch.js';

type Health = 'checking' | 'ok' | 'unavailable';

export function App() {
  const [health, setHealth] = useState<Health>('checking');

  useEffect(() => {
    tracedFetch('/healthz', { headers: { accept: 'application/json' } })
      .then(async (res) => setHealth(res.ok && (await res.json()).status === 'ok' ? 'ok' : 'unavailable'))
      .catch(() => setHealth('unavailable'));
  }, []);

  return (
    <main>
      <h1>GetWorkDone</h1>
      <p>
        API: <span data-testid="api-health">{health}</span>
      </p>
      <Auth />
    </main>
  );
}
