# Security policy

Option Trading is a local-first personal tool: it listens on `127.0.0.1`, keeps one user's data in a PostgreSQL database on their
own machine, and never places orders. Even so, it has a login, session handling, file uploads (journal images) and runs a
command-line model executor, so reports are welcome.

## Supported versions

Only the latest commit on `main` (the project is pre-1.0 and has no release branches).

## Reporting a vulnerability

Please do **not** open a public issue for a vulnerability.

1. Open the **Security** tab of this repository and choose **Report a vulnerability** (a private GitHub security advisory).
2. If that option is not available, open a public issue titled "Security contact request" with **no details**, and a private channel
   will be arranged.

Include what you found, the commit you tested, the steps to reproduce it, and the impact you expect. Never include a real
`.env`, API keys, session cookies, or your own portfolio or journal data; sample values are enough.

This is a personal project, so there is no response-time guarantee, but reports are read and acknowledged on a best-effort basis,
and fixes are credited if you want to be.

## What is in scope

- Authentication and session handling: login, the first-run setup code, email links, Google sign-in, rate limits, cookie flags.
- The request guards: `Host` and origin checks, the JSON content-type rule on writes, the unauthenticated surface (`/api/health`).
- Injection and traversal: SQL, path traversal in journal assets and report files, server-side request forgery through the data
  providers, unsafe rendering of stored or model-generated text.
- The model executor: anything that lets text from a web page, news item or model answer run a tool, write a file or spend money
  beyond the configured caps.
- Secrets leaking into logs, API responses or the built UI.

## What is out of scope

- Exposing the app to the internet without a reverse proxy, `APP_URL` and a first account created beforehand, or running with
  `OT_AUTH=off` (both are described in the README's security notes).
- Vulnerabilities in third-party services and tools (Yahoo, moomoo OpenD, the Claude Code CLI, PostgreSQL, Node.js); report those to
  their owners.
- Wrong or late market data, and trading losses. This is decision support, not advice.
