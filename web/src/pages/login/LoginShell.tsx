import type { ReactNode } from 'react';
import { DISCLAIMER } from '../../api/types';

/** The page the login lives on: one centred card on the app's canvas, with the disclaimer underneath. */
export function LoginShell({ title, subtitle, children }: { title?: string; subtitle?: string; children: ReactNode }) {
  return (
    <div className="login-shell">
      <main className="login-card" aria-labelledby="login-title">
        <header className="login-brand">
          <img src="./icon.svg" alt="" width={44} height={44} />
          <div>
            <h1 id="login-title">{title ?? 'Option Trading'}</h1>
            <p>{subtitle ?? 'Sell-put decision support'}</p>
          </div>
        </header>
        {children}
      </main>
      <p className="login-foot">{DISCLAIMER}</p>
    </div>
  );
}
