import { createRoot } from 'react-dom/client';
import App from './App.tsx';
import './index.css';

declare global {
  interface Window {
    __SVL_DEV_DIAGNOSTICS__?: {
      hmrState: 'active' | 'disabled' | 'proxy_unavailable';
      hmrMessage?: string;
      detectedAt?: string;
    };
  }
}

if (import.meta.env.DEV && typeof window !== 'undefined') {
  window.__SVL_DEV_DIAGNOSTICS__ = window.__SVL_DEV_DIAGNOSTICS__ || { hmrState: 'active' };
  let hmrNoticeLogged = false;

  window.addEventListener('unhandledrejection', (event) => {
    const reason = event.reason;
    const msg =
      typeof reason === 'string'
        ? reason
        : reason instanceof Error
          ? reason.message
          : String(reason?.message || reason || '');
    const stack = reason instanceof Error ? String(reason.stack || '') : '';

    const isViteHmrWsFailure =
      msg.includes('WebSocket closed without opened') &&
      !msg.includes('/ws/svl') &&
      !stack.includes('svlSyncStore');

    if (isViteHmrWsFailure) {
      event.preventDefault();
      window.__SVL_DEV_DIAGNOSTICS__ = {
        hmrState: 'proxy_unavailable',
        hmrMessage: msg,
        detectedAt: new Date().toISOString(),
      };
      window.dispatchEvent(new CustomEvent('svl:hmr-diagnostic', { detail: window.__SVL_DEV_DIAGNOSTICS__ }));
      if (!hmrNoticeLogged) {
        hmrNoticeLogged = true;
        console.info(
          '[SVL Dev Diagnostic] Vite HMR WebSocket został zamknięty przez warstwę proxy środowiska podglądu (brak wpływu na aplikacyjny kanał synchronizacji /ws/svl).',
        );
      }
    }
  });
}

createRoot(document.getElementById('root')!).render(<App />);

