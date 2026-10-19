import { links } from '../../api/endpoints';

/** Google's four-colour "G", inline so the page needs no image request (the CSP allows only same-origin images). */
function GoogleG() {
  return (
    <svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true" focusable="false">
      <path
        fill="#EA4335"
        d="M24 9.5c3.5 0 6.6 1.2 9.1 3.6l6.8-6.8C35.8 2.4 30.3 0 24 0 14.6 0 6.5 5.4 2.6 13.2l7.9 6.1C12.4 13.6 17.7 9.5 24 9.5z"
      />
      <path
        fill="#4285F4"
        d="M46.1 24.5c0-1.6-.1-3.1-.4-4.5H24v9h12.4c-.5 2.9-2.2 5.3-4.6 6.9l7.4 5.7c4.3-4 6.9-9.9 6.9-17.1z"
      />
      <path fill="#FBBC05" d="M10.5 28.7a14.5 14.5 0 0 1 0-9.4l-7.9-6.1a24 24 0 0 0 0 21.6l7.9-6.1z" />
      <path
        fill="#34A853"
        d="M24 48c6.5 0 11.9-2.1 15.9-5.8l-7.4-5.7c-2.1 1.4-4.9 2.3-8.5 2.3-6.3 0-11.6-4.1-13.5-9.8l-7.9 6.1C6.5 42.6 14.6 48 24 48z"
      />
    </svg>
  );
}

/**
 * "Continue with Google". A plain link: the whole round trip is browser navigations (to Google and back), so no script
 * runs and no token ever passes through the page. Disabled, with the reason, until the server has Google credentials.
 */
export function GoogleButton({ enabled }: { enabled: boolean }) {
  if (!enabled) {
    return (
      <div className="login-google">
        <button type="button" className="btn wide google" disabled aria-describedby="google-hint">
          <GoogleG />
          Continue with Google
        </button>
        <p className="note" id="google-hint">
          Google sign-in is not set up on this server yet.
        </p>
      </div>
    );
  }
  return (
    <div className="login-google">
      <a className="btn wide google" href={links.googleStart}>
        <GoogleG />
        Continue with Google
      </a>
    </div>
  );
}
