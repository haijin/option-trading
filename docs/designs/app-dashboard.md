# Design: Home desk and the five modules (app redesign proposal)

Written 2026-10-17, approved 2026-10-18. Status: D1–D4 BUILT 2026-10-18. See "As built" at the end.
Prototype: `docs/prototypes/app-dashboard.html` (static sample data, light and dark, phone frames and one laptop frame).
Relates to: `docs/designs/sell-put-scanner.md` (Puts), `docs/designs/leaders-pullback.md` (Leaders),
`docs/designs/latest-news.md` (News), `src/server/research/skills.ts` (Research), `src/core/alerts.ts` and
`corporate_events` (Reminders).

## The brief

"Redesign the overall app, have a Dashboard to show me the overview of each module: 1. Option opportunities (short put),
2. Stock leaders (good fundamentals with a recent drop), 3. Key news, 4. Research, 5. Reminders (shortlist stock key
news, results announcement dates). Show me the prototypes first."

## What Home is for

The user opens the app on a phone before the HK open (about 08:30 HKT) and before the US open (about 21:00 HKT) and
wants, in under a minute: when the next market opens, what regime and capital they are working with, and the state of
each module, with the one number per module that decides whether to open it. Everything on Home is a summary of a page
that already exists (or, for Reminders, a new page); Home computes nothing of its own.

## Home, top to bottom

1. **Header**: the date as the title ("Friday 17 October"), the session under it ("Before the HK open"), a bell with
   the count of reminders due today, and a More button (Watchlist, Positions, Journal, Backtests, Data, Settings).
2. **Session clock** (the one memorable element): a 24-hour band in Hong Kong time with the HK morning and afternoon
   sessions (09:30 to 12:00, 13:00 to 16:00) and the US session (21:30 to 04:00, drawn across midnight), a "now"
   marker, and the line "HK opens in 50 min". Under it, per market: the S0 regime chip (bull calm, neutral, panic) with
   the volatility index and the deploy cap, and a deployed-capital meter against that cap. Tapping a meter opens
   Positions. Data: `GET /api/overview` already carries regime, deployed and asOf.
3. **Puts to sell**: count of ideas, the top three rows (rank, symbol, contract in monospace, delta, annualised return,
   cushion, days to expiry, size), a footer distribution bar sell / wait / avoid / open with the counts and the scan time.
   Data: the latest stored scan (`GET /api/scan`), the same rows the Today page shows. "Run scan" moves from every
   header into this panel and the Puts page.
4. **Leaders at support**: count of Setups, three rows each with the drop from the high, base length, the support in
   play, the quality screen as a seven-segment bar ("quality 7 of 7") and the stop distance, a Setup or Watch chip.
   Footer: watch count, new today, dropped, posture. Data: `GET /api/leaders/today` plus the quality-screen verdict per
   name (the local `quality-screen` skill, already computed for watched names; run it for shortlist names in the leaders
   scan job).
5. **Key news**: the morning brief lead and tape, then three stories with the impact word (Blocks, Caution, Supports,
   Neutral), ticker, source, time, headline and the one-line "so what". Header count is the number of blocking stories.
   Data: `GET /api/news/brief` and `GET /api/news?scope=shortlist&days=1`.
6. **Research**: runs in progress with a step bar, then the latest reports with the verdict in one chip (quality pass
   or fail, thesis intact, "buy below 520"), the week's cost. Data: `GET /api/research/runs` and the stored reports.
   The verdict chip needs a short `verdict` string extracted per skill (quality screen: pass n of 7; checklist: its
   final grade; thesis tracker: intact / review / broken; memo: the price conclusion line).
7. **Reminders**: today's items, then the next week, with the date in a mono column, the line, why it concerns the user
   (open put, recommended put, watched name), and a tag: Results, Expiry, Alert, Key news, Ex-dividend. Footer: how
   many more in 30 days and where they are sent.

Each panel has the same shape: name, the one number, "Open", rows, footer. Every ticker opens that stock on its page.
Laptop: same panels in two columns (Puts and Leaders left, Reminders and News right, Research full width), five rows
each, the session clock and the regime and capital block in the header, the rail with every page.

## Navigation

Phone tab bar goes from nine tabs to five: Home, Puts (was Today), Leaders, News, Research. Reminders sits behind the
bell in the header with a badge; Watchlist, Positions, Journal, Backtests, Data and Settings move to a More sheet. The
desktop rail keeps every page. `#/today` keeps working as an alias of `#/puts`.

## Reminders (new module)

One list built from four sources, all already stored:

| Source | Rows | Tag | Relevance line |
|---|---|---|---|
| `corporate_events` (earnings, ex_dividend, agm, split, ...) for watched names | next 30 days, HK dates marked unconfirmed until the board-meeting notice | Results, Ex-dividend | open put expiring after it, recommended put inside the window, or watched |
| `positions` (open puts) | expiry dates, grouped by market expiry day | Expiry | contracts settling, spot distance |
| position alerts (`src/core/alerts.ts`: profit50, dte21, stop2x, assignment_risk, itm, near_strike, earnings_before_expiry, new_earnings_date) | from the latest mark | Alert | the alert text |
| classified news items with impact Blocks or Caution on shortlist names and open puts, last 24 h | | Key news | the standing then |

API: `GET /api/reminders?days=30` returning `{ asOf, today: ReminderView[], upcoming: ReminderView[] }` with
`ReminderView { date, time?, market, symbol, kind, title, why, level, href }`. The page adds a 14-day strip with dots
by kind and kind filters. Delivery reuses the alert channels (Telegram, email) at 08:00 HKT: one message with the
day's reminders, no new configuration.

## Visual identity

The prototype drops the WhatsApp palette and Inter for one action colour (pine) and Schibsted Grotesk, with Spline
Sans Mono for tickers, contracts and aligned numbers. Semantic colours keep one meaning across modules: green is a
verdict in the user's favour (sell, pass, supports), amber a date or a wait, red blocks and alerts, blue money at work
(open puts, expiries). Phone-first at 390 px, light and dark, bottom tabs, one pane at a time, bottom-sheet modals all
stay. If the user prefers the current look, the Home layout and Reminders work on the existing tokens unchanged.

## Open points for the review

- Leaders: the brief says "good fundamentals with a recent drop"; the built list is the momentum method. The prototype
  shows both on each row and gates Setup on the quality screen. Decide whether to drop the momentum requirement.
- Tab bar: five tabs plus a bell. Alternative: keep Reminders as a tab and fold Research under More.
- Research verdict strings: needs a small per-skill extractor; until then the chip shows "report ready".
- HK results dates are often unknown (Yahoo); the Reminders page says "date unconfirmed" and the TODO for a HKEX
  board-meeting source becomes more valuable.

## Stages, if approved

- D1 Home page and nav change (five tabs, bell, More sheet), panels reading the existing endpoints; Puts is Today renamed.
- D2 Reminders endpoint and page; the 08:00 digest on the alert channels.
- D3 Restyle: tokens, type, the shared panel and row components applied to Puts, Leaders, News, Research.
- D4 Research verdict extraction; quality screen on Leaders rows; laptop layout polish.

## As built (D1, 2026-10-18)

- Routes: `home` is the default, `puts` replaces `today` (`#/today...` still parses as an alias), `reminders` is a page.
  `web/src/lib/route.ts`, tests in `route.test.ts`.
- Navigation: five tabs (`NAV_ITEMS`), the More sheet (`MORE_ITEMS`, `layout/MoreSheet.tsx`, a Modal: a bottom sheet on a
  phone) with the theme switch and sign-out in its footer, the desktop rail with every page (`RAIL_ITEMS`). The top bar
  shows the bell with the count due today and the More button; Run scan appears only on the Puts page and in the Home
  Puts panel. On Home the title is the day in Hong Kong and the regime strip is left out (the session card carries it).
- Home: `pages/home/` (HomePage, SessionCard, HomePanel, PutsPanel, LeadersPanel, NewsPanel, ResearchPanel,
  RemindersPanel), styles in `styles/dashboard.css`. Phones read three rows per panel, a laptop five, with the two-column
  grid from 1100 px. Data: the overview context, `GET /api/scan`, `GET /api/leaders`,
  `GET /api/news?scope=shortlist&days=1`, `GET /api/news/brief?date=today`, `GET /api/research/runs` (new client call
  `researchRunsAll`, no new server route), `GET /api/skills` for the skill names. Research rows say "report ready" or
  "failed" until D4 adds a verdict. Leaders rows show the drop from the high, the base length, the support in play, the
  3-month return and the stop; the quality screen comes with D4.
- Session clock: `lib/sessions.ts` (pure, tested): HK 09:30 to 12:00 and 13:00 to 16:00; US 21:30 to 04:00 HKT while New
  York is on daylight time, 22:30 to 05:00 otherwise; weekends and the Monday-morning gap handled; holidays not known.
- Reminders, first version, no server change: `lib/reminders.ts` (pure, tested) builds the list from the open puts
  (expiries, alerts), the data status (results dates, with the open or recommended put as the relevance line) and the
  shortlist news of the last day (Blocks and Caution). `state/reminders.tsx` fetches once for the bell, the Home panel and
  `pages/reminders/RemindersPage.tsx` (fourteen-day strip, kind filters, grouped list). The D2 endpoint replaces the
  builder's inputs and adds ex-dividend days and HKEX notices; the UI stays.
- Visual identity: D1 keeps the existing tokens (WhatsApp palette, Inter). The pine and Schibsted Grotesk direction is D3.
- Verified on the mock API in a browser at 390 and 1320 px; `pnpm web:build` done and the service serves the new bundle.
  Not yet verified against the live server with real data.

## As built (D2, 2026-10-18)

- `GET /api/reminders?days=30` — `src/server/routes.ts` route, `RemindersService` (`src/server/services/reminders-service.ts`),
  core query `buildRemindersView(db, today, days)` in `src/db/reminders.ts`. Five sources: results dates, ex-dividend events,
  put expiries, position alerts (cushion < 5% or DTE ≤ 20), blocking news. Types in `src/core/reminders.ts` so both the db
  layer and the server can import them without violating `noRestrictedImports`.
- Digest job: `runRemindersDigestJob` in `src/jobs/jobs.ts`; `RemindersJobPorts.digest` provided by `RemindersService`;
  scheduled at 08:00 HKT (`reminders-digest` in `JOB_DEFS`).
- CLI: `pnpm cli reminders [--days N] [--notify]` in `src/cli/commands/reminders.ts`.
- Mock: `web/mock/reminders.ts` (`buildMockReminders`), registered at `GET /api/reminders` in `web/mock/routes.ts`.
- Web: `api.reminders(days, signal)` in `web/src/api/endpoints.ts`; `state/reminders.tsx` fetches from endpoint; `ex_dividend`
  added to the kind filter in `RemindersPage.tsx`. `lib/reminders.ts` stripped of the client-side builder, keeps utilities.
- Tests: `tests/server/reminders-api.test.ts`; `web/src/lib/reminders.test.ts` (utility tests only).
- Deviation: `news` reminders (blocking HKEX notices) come from the news table, not from a separate client-side fetch.
  Pre-existing `news-jobs.test.ts` assertions updated to include the D1 06:00 morning brief schedule.

## As built (D3, 2026-10-18)

- Fonts: `@fontsource-variable/schibsted-grotesk` + `@fontsource/spline-sans-mono` (400, 500) replace Inter + JetBrains Mono.
  Imported in `web/src/main.tsx`.
- Tokens in `web/src/styles.css`: `--accent #2d6a4f` (light) / `#52b788` (dark); `--brand`, `--ok`, `--header` updated to pine.
  Dark mode uses GitHub-dark-inspired neutrals. `--sans: "Schibsted Grotesk Variable"`, `--mono: "Spline Sans Mono"`.
- Deviation: "shared panel components applied to Puts, Leaders, News, Research" (component lifting) deferred; scope was already
  wide and the visual tokens achieve the design intent without restructuring the page components.

## As built (D4, 2026-10-18)

- Research verdict: `verdict: string | null` on `ResearchRunView` (api-types.ts). Computed in `toView()` (manager.ts) from
  `result.screen` for quality-screen runs → `"pass N of M"` or `"fail N of M"`. AI-skill runs have `verdict: null` (extracting
  from markdown files at list-call time was ruled out; a future PR adds a DB column populated at save time). The `ReportRow`
  chip in `ResearchPanel.tsx` shows the verdict when present, otherwise "report ready".
- Leaders quality field: `quality: { pass: number; total: number } | null` added to `LeaderCandidateView` (leaders/types.ts);
  always `null` in `candidateView()` (leaders/view.ts) pending a future PR that loads per-candidate statements. `LeadersPanel`
  renders the field when non-null.
- Mock: `toView()` in `web/mock/research.ts` computes verdict from `rec.report.screen` for quality-screen runs.

## As built (Home layout pass, 2026-10-19)

The user found the page messy and not "full page". Same modules, endpoints and numbers; the layout changed. Decisions and
measurements are in `DECISIONS.md` (2026-10-19, Home page redesign).

- Laptop (1100 px and up): one screen, no page scroll. A fixed-height grid fills the window: the session strip on top, then
  Puts (tall) | Leaders over Key news | Reminders over Research. Each panel's rows (`.hm-body`) scroll inside the panel.
  The 1240 px cap is removed.
- Phone and tablet: a glance bar under the session card (`GlanceBar.tsx`) with one figure per module; a tap scrolls to the
  panel. The session card shows each market in one cell. A tablet gets two columns with equal-height rows.
- Each panel file exports a `*Summary(resource)` that feeds the header pill and the glance tile
  (`summaries.test.ts`). `HomePanel` wraps the rows in `.hm-body` and gives the section an id (`hm-<panel>`).
- Home's CSS grid block is the last section of `styles/dashboard.css` so its overrides win without specificity hacks.
- Fixes: `.sk` clash with the Research page renamed `.skn`; new `--title` token for text that must stay readable in dark mode.
