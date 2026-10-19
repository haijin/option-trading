# Design: News page (market brief + stories that touch the shortlist)

Written 2026-10-13, autonomous session. Status: stages N1 to N3 BUILT the same day (see "As built" at the end for what
changed against this text); N4 is open.
Prototype: `docs/prototypes/latest-news.html` (also published as a private artifact for the phone).
Relates to: `docs/designs/ai-analysis.md` item 4 (news attribution on triggers) and item 8 (weekly brief);
this page is the surface those rows would appear on. Nothing here feeds a skill.

## What the page is for

The scanner already says "sell the 14 Nov 65 put" and the Today page already lists "News that matters".
What is missing is a place that answers two questions on the phone in under a minute, before the HK open and
before the US open:

1. What is the market doing, and what does that mean for selling puts this week (which side pays, which dates to
   stay clear of)?
2. For each name on my shortlist and each open put, is there a story I should know, and does it support, caution
   against, or block the put the app is recommending?

So every story is read against a concrete standing: the recommended put, the open position, or the reason the
name is waiting. The impact word (Supports, Caution, Blocks, Neutral) is the model's one-line judgement against the
app's own rules, and it always shows which rule it touched (F fundamentals, T timing, E events, P open position)
and the source it came from.

## Page structure (as prototyped)

- Header: "News", as-of time, Refresh.
- Market brief (one card): a two-sentence lead, a scrolling tape (S&P, Nasdaq, HSI futures, VIX, VHSI, UST 10y,
  USDHKD, USDCNH), four tagged bullets (US, HK·CN, Macro, Dates), a green "For put selling" line, and an
  expandable source list with times. Written by the model from the fetched items; every bullet is cited.
- Scope segment: Shortlist (names the latest scan marks sell, plus names that just dropped to wait), Positions
  (open puts), All watched. Window chips: 24h, 3 days, Week. "Hide neutral" toggle.
- One card per name with news in the window: symbol, name, spot and change, standing line coloured by state
  (sell green, open put blue, wait amber, avoid red) with the contract in monospace. Under it, one row per story:
  impact badge, source, time, headline, one-line "so what". Tap to expand: rule keys, citation, buttons
  Source / Ask why (or Full attribution when an attribution verdict exists) / Today › or Positions ›.
- Names with nothing in the window are listed in one quiet row, so the user knows they were checked.
- Footer states the sources and that the impact line is model-written and always linked.

### Past news (added the same day on request)

- **Day navigator** above the brief: previous / next arrows, the day label (Today, or "Mon 12 Oct · yesterday"),
  a calendar button and a search button. A "Back to today" pill appears on any past day. The header says
  "Archive" instead of the fetch time.
- **Calendar**: month grid with up to three dots per day (blocks, caution, supports, neutral) following the current
  scope filter, a faint dot for days that only have a brief, future days disabled, month arrows back as far as
  the data goes. Tap a day to load it.
- **Past day view**: the market brief card shows the briefs written that day with an HK open / US open toggle (or
  "No brief was written" for weekends); the window chips (24h, 3 days, Week, Month) end on the selected day and
  the result line says so ("4 stories in the 3 days to Mon 12 Oct"); the quiet row names the checked names.
- **Standing then vs now**: the impact line was written against the standing the name had on that day, so an
  expanded past item shows "Standing on 9 Oct: Sell · 29 Oct · 150 put" when it differs from today's. The card
  header always shows today's standing, marked "now".
- **Search** across all days ignores the day and window: matches on headline, symbol, name and source, highlights
  the match, and reports "n stories matching 'buyback' across all days, shortlist". Clear returns to the day view.

Nothing is ever deleted: `news_items` and `news_briefs` are kept (not 30 days as first written); the standing
shown to the model is stored on the row (`ai_standing`) so a past day renders exactly what was judged then.
Extra API: `GET /api/news?date=2026-10-12&days=3&scope=...` (date defaults to today), `GET /api/news/days?month=2026-10&scope=...`
for the calendar dots, `GET /api/news/search?q=...&scope=...`, `GET /api/news/brief?date=...` returning every
session that day.

Navigation: News gets a tab. With the Journal tab planned the same day the phone bar reaches nine items, which is
too many; the fallback is a "More" tab holding Tests, Data and Settings. Decide on the real device.

## Data and pipeline

Free sources only, through the existing provider conventions (`src/providers`, replayable HTTP):

| Source | What | How |
|---|---|---|
| Yahoo Finance RSS | per-ticker headlines, US and HK (`feeds.finance.yahoo.com/rss/2.0/headline?s=NKE`, `0700.HK`) | poll |
| HKEXnews | announcements and next-day disclosure returns per stock code (title search) | poll |
| Company IR | results-date notices | via the existing research executor's WebFetch, only in the classify step when a headline mentions a date |
| Own database | spot, change, IV rank, regime, events, open positions, latest recommendation | `DataAccess` and the services already behind Today and Positions |

Tables (migration: next free number; `ai-analysis.md` and `daily-journal.md` each claim one too):

```
news_items
  id, instrument_id (null = market-wide), source text, url text unique, title, snippet, published_at,
  fetched_at, hash   -- kept indefinitely (the page has a day navigator, calendar and search over history)
  ai_impact      text null check in ('supports','caution','blocks','neutral')
  ai_summary     text null (<= 240 chars)
  ai_rules       jsonb null  [{ key: 'f'|'t'|'e'|'p', text }]
  ai_standing    jsonb null  (the standing the model was shown: kind, contract, strike, expiry, dte, otm_pct)
  ai_confidence  smallint null
  ai_known_at    timestamptz null, ai_model, ai_cost_usd
news_briefs
  id, as_of timestamptz, session text check in ('hk_open','us_open','manual'), lead text, bullets jsonb,
  for_puts text, tape jsonb (numbers copied from our own tables, never from the model), citations jsonb
  (urls must be a subset of news_items.url fetched in the last 24h), model, cost_usd
```

Jobs (`src/jobs/scheduler.ts`, registered from `src/server/index.ts` like the research queues):

- `news-fetch`: every 30 minutes in either market's hours, hourly otherwise; active watchlist names plus the
  market feeds; dedupe on url hash; rows are kept, never pruned.
- `news-classify`: after each fetch, for new items on names that are on the shortlist or have an open position
  first, the rest after. One light model call per item (`tools: []`, default `claude-haiku-5-5`, cap $0.05 a
  call, `OT_NEWS_DAILY_BUDGET_USD` default 2). Input: headline, snippet, the name's standing (recommendation or
  position), the next known event, gate and timing verdicts. Output: JSON `{impact, summary, rules[], confidence}`.
- `news-brief`: 07:30 HKT and 21:00 HKT, plus Refresh. One call over the last 24 hours of market-wide items and
  the regime row; the tape numbers come from our tables and are not part of the prompt output.

Validators (same stance as `ai-analysis.md`): enum values only; summary length; every citation url must be one
we fetched; a summary that introduces a number not present in the input or the standing is rejected and the item
stays "unclassified" (shown without a badge, never as Neutral). Model output is data; the page renders it as text.

Scopes:
- shortlist = instruments with a `recommendations` row in the latest scan run whose state is sell, plus
  instruments whose state fell from sell since the previous run (so the story that moved them is still shown);
- positions = `positions.status = 'open'`;
- all = active watchlist.

API: `GET /api/news?scope=shortlist|positions|all&days=1|3|7&neutral=0|1`, `GET /api/news/brief`,
`POST /api/news/refresh` (enqueues fetch, classify, brief). Shapes mirror the prototype's `GROUPS` constant.

## What it does not do

- It never writes to `corporate_events`, `research_verdicts` or any table a skill reads. A results date found in a
  headline is surfaced as a Caution with a "confirm on Data" hint; writing it as an unconfirmed event is
  `ai-analysis.md` stage B2, not this page.
- It never sizes, scores or ranks. The impact word changes nothing in the scan.
- No paid feed. If Yahoo RSS is throttled the page shows the last fetch time and keeps the old items.

## Build order

- N1: tables, fetch job, API and page with items shown unclassified (no model). Already useful on day one.
- N2: classify job and the impact badge, rule keys and standing line.
- N3: market brief card and the two scheduled brief runs.
- N4: "Full attribution" link to `research_verdicts` once `ai-analysis.md` B3 exists; "Ask why" routed through
  `research_runs` kind `ask`.

## As built (2026-10-13, stages N1 to N3)

The sections above are the design as approved. This section lists what the build changed or settled. Where it differs from
the text above, this section wins.

### Storage (migration 0008, `src/db/schema.ts`)

- `news_items` is unique on (`instrument_id`, `hash`) with NULLS NOT DISTINCT, not on `url`. The same Yahoo story is tagged
  to several tickers and the impact is judged against each name's own standing, so it is one row per name; a market-wide story
  (`instrument_id` null) dedupes the same way. `hash` is the SHA-256 of the canonical url (fragment and tracking parameters
  such as `.tsrc` and `utm_*` removed). Check constraints keep `ai_impact` to the four words and `ai_summary` to 240 characters.
- `news_briefs` gained `day` (the Hong Kong calendar day) and a partial unique index on (`day`, `session`) where the session is
  not `manual`: a scheduled session has one brief a day, manual ones accumulate.
- A rejected answer leaves `ai_impact` null but sets `ai_known_at`, `ai_model` and `ai_cost_usd`: that is how the story is not
  offered to the model again and how its cost counts toward the day's budget. To retry one, clear its `ai_known_at`.

### Sources (`src/providers/news`)

- Yahoo Finance RSS per ticker (US `NKE`, HK `0700.HK`); HKEXnews announcement titles per HK code in two steps (the JSONP
  `prefix.do` lookup gives the internal stock id, cached for the process, then `titleSearchServlet.do` over the last 14 days).
  Both response shapes were checked against the live endpoints on 2026-10-13.
- Market-wide feeds (the design left the list open): Yahoo Finance headlines for `^GSPC`, `^IXIC` and `^HSI`, and the CNBC
  markets feed. A feed that fails is reported in the job run and the others still count.
- Company IR pages are not fetched: the classify step has no tools. A results date in a headline surfaces as a Caution only.
- A name that was paused after a put was opened on it is still fetched.

### Jobs

- `news-fetch` ticks at :00 and :30 UTC (`*/30 * * * *`) every day; the :30 tick runs only while Hong Kong or the US market is
  open, so the cadence is hourly otherwise (`newsFetchDue` in `src/core/news.ts`). `news-classify` has no schedule: a fetch that
  stored new stories queues it. `news-brief` is one job with two schedules (07:30 and 21:00 Asia/Hong_Kong, carrying the
  session in the job data) and writes only on a trading day of that session's market. Manual Refresh is the `news-refresh`
  queue (or an in-process run when `OT_JOBS` is off) and runs fetch, classify and a manual brief.
- `src/jobs` may not import `server`, so the model-bound steps reach the jobs through `JobDeps.news` (`NewsJobPorts`), filled in
  by the API process (`NewsService.jobPorts()`). Without it (the CLI) those jobs report that no model is attached.
- Environment: `OT_NEWS_MODEL` (default `claude-haiku-5-5`), `OT_NEWS_DAILY_BUDGET_USD` (default 2, per Hong Kong day, stories
  and briefs together), `OT_AI_AUTO=off` (the schedule never calls the model; Refresh still does). Per-call caps: US$0.05 a
  story, US$0.10 a brief. A call is not made when the day's remaining budget is below its cap. The cost of a rejected brief has
  no row, so the service remembers it in memory for the day. At most 40 stories are judged a run, none older than 7 days; three
  failed calls in a row end the run. A manual brief is not written within 30 minutes of the last one.
- The demo `FakeExecutor` (no scripted reply) is not used for news: nothing is judged and nothing is marked rejected.

### Scopes, standing and API

- Scopes read the database only, never the pipeline: shortlist = the latest stored live scan's recommendations plus names that
  were recommended in the run before it and not in the latest (standing `Wait (was Sell)`); positions = open puts; all = active
  watchlist plus names with an open put. Standing: an open put wins over a recommendation (`Open put`, with OTM % and days from
  the latest close), then `Sell`, then `Avoid` when the latest stored quality gate FAILs, else `Wait`.
- `GET /api/news?scope=&date=&days=1|3|7|30&neutral=0|1`: `neutral=0` hides Neutral stories. A window is the `days` Hong Kong days
  ending on `date` (a future date is read as today); today with one day is the rolling last 24 hours. The standing now is on the
  name's card; each item carries the standing then (`standingThen`) and when it was judged (`judgedAt`), and the page labels the
  line with the judged day, which is the story's own day when the story is judged promptly.

### Validators

- The answer is exactly one fenced `json` block, parsed with a strict zod schema (unknown keys rejected). Besides the enum,
  length and rule-key checks: no link in any string, and no number in the summary or the rule texts that is not in the input the
  model was given (the story, the standing, the event, the verdicts; numbers compare after removing thousands separators and
  trailing zeros). The prompt tells the model to write the summary as a clause that reads after "Supports:".
- The brief is validated the same way, plus: one to four bullets with different tags, each citing one to four story ids from the
  list it was shown (a made-up source cannot get in: a cited id that was not offered rejects the brief), and no `tape` key. A
  rejected brief is retried once with the reason, then dropped. Stored citations are the cited stories' own urls.

### Tape

The tape is copied from our own tables and the model never writes it: S&P 500 (the SPY bar's day change; SPY is an ETF so no
level is shown), HSI (level and change), VIX, VHSI, USDHKD and USDCNY. Gaps against the prototype, all because the series are
not stored: VHSI has no free daily history (Yahoo has a spot quote only, so it appears only when `data/vhsi.csv` seeds it); the
offshore yuan has no Yahoo daily history either (`CNH=X` returns a single bar), so USDCNY is derived from the stored USDHKD and
CNYHKD of the same day; UST 10y and Nasdaq are not stored. A series older than 10 days is left out. No ingest step was added.

### Page

- The page follows the prototype with the app's own tokens (`web/src/styles/news.css`, classes prefixed `news-`); phone targets
  are 44 px and fields 16 px; the phone tab bar now has eight tabs and its labels drop to 9 px under 420 px so none clip.
- Unclassified stories show no badge and "New"; Full attribution and Ask why are disabled with the tooltip "coming with AI
  analysis stage B3" (stage N4 is not built). Everything a feed or the model wrote is rendered as text.
- The mock server (`web/mock/news.ts`) serves the prototype's sample data with Tue 13 Oct 2026 as today, plus two unjudged
  stories.

### Known gaps and next steps

- N4 (Full attribution and Ask why through `research_runs`) is not built, nor is any use of the story rows by a skill.
- Yahoo's per-ticker feeds include loosely related stories (a smoke run against the live feeds showed a JD Sports item under
  NKE), so many stories will judge as Neutral. No relevance filter was built; a cheap first one is to require the ticker or
  the company name in the headline or snippet before a story is attached to a name.
- A rejected story is never retried by itself; a brief that keeps failing is retried on each scheduled session and every half
  hour of manual Refresh, bounded by the budget.
- Adding UST 10y, Nasdaq or VHSI to the tape means storing them first (an `INDEX_SPECS` entry, a recorded fixture, or the CSV seed).
