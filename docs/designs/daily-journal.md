# Design: Daily Journal with AI rewrite

Written 2026-10-13 (autonomous session; choices are logged in DECISIONS.md)
Status: DRAFT, prototype only, nothing built
Prototype: `docs/prototypes/daily-journal.html` (open it in a browser; works at 375 px and on desktop)
Extends: docs/designs/sell-put-app.md (web app), docs/designs/ai-analysis.md (the `claude -p` executor and its rules)

## Problem

The app tells the user what the numbers say. It has no place for what the user thought, did, skipped and learned
that day. The trade journal that exists (`/api/journal/import`, S5's confidence card) is a CSV of fills, not a diary.
The user writes notes elsewhere, on a phone, in a hurry, with typos, and never reads them again.

A daily investment journal in the app should:

- be fast to write on a phone at 16:40 after the HK close and at 22:30 after a US fill;
- hold more than text: a chart screenshot, a table of positions, a checklist for tomorrow, a highlighted lesson;
- let an AI tidy a rough draft without changing what the user meant, what they decided, or any number;
- remember: the entry for a stock shows up on that stock's Research page; lessons are findable later.

## Goals and non-goals

Goals

1. One entry per calendar day per user, rich text, autosaved while typing, usable at 375 px wide.
2. Images (upload, camera, paste a screenshot), tables, headings, bullets, numbered lists, checklists, callouts,
   bold/italic/strike, stock mentions (`0700.HK`, `NKE`) that link to Research.
3. AI rewrite with named modes (Polish, Tighten, Structure, Lessons & actions, Translate to Chinese, Custom).
   The suggestion is shown next to a word diff; nothing changes until the user taps "Use suggestion"; the old
   text goes into History; Undo for 8 seconds after.
4. Images, tables, snapshots and checklists are locked blocks: the model never sees them and cannot change them.
5. Revision history (every accepted AI suggestion, every 10 minutes of typing, every restore).
6. Search by words, stock, tag; month calendar; a Lessons list across entries.
7. "Insert today's snapshot": a frozen copy of open positions (or today's scan picks) as a table inside the entry.

Non-goals (this version)

- Collaboration, sharing, publishing. The journal is private to the signed-in user.
- Multiple entries per day. A day is one document with sections (templates give the sections).
- The journal feeding the scanner. Nothing here is read by S0 to S7; see "What the AI may not do".
- Video, audio, PDF attachments. Images only (PNG, JPEG, WebP, GIF; HEIC converted on upload).
- Offline editing beyond a localStorage draft of the current entry.

## UX (see the prototype)

Navigation: Journal becomes the second tab (Today, Journal, Research, Watch, Positions, Tests, Data, Settings).
Eight tabs fit at 375 px with 10 px labels (the prototype shows it). If it looks crowded on the real device the
fallback is a "More" tab holding Tests and Data; that is a layout change for the whole app, so it is not assumed.

### Journal list (phone: one pane; desktop: left column, 380 px)

- Search box: words, `$NKE`, `#breach`.
- Week strip: seven days, a green dot under days with an entry, today tinted, tap a day to open or start it.
- Summary line: entries this month, lessons, names mentioned, streak.
- Segments: Entries (cards), Month (calendar with a dot coloured by the day's market view), Lessons (every
  paragraph starting with "Lesson:" and every AI-extracted lesson, each linking back to its entry).
- Entry card: date, template chip, Draft chip (not yet "closed"), "AI polished" chip, time, title, two-line
  excerpt, image thumbnail, stock chips, tag chips, word count. Left border: green bullish, red bearish, grey neutral.
- "+ New entry" opens today's entry (creating it if needed) with the template chooser if it is empty.

### Editor (phone: full pane with a fixed toolbar above the tab bar; desktop: right column)

- Header: back, the date, save state ("Saving…" / "Saved 16:42 · 412 words"), a more menu.
- Title (optional), market view segment (Bullish / Neutral / Bearish), tags, detected stock names.
- The document. Block types: heading, paragraph, bullet list, numbered list, checklist, callout (blockquote, used
  for "Lesson:"), table, figure (image with caption), snapshot (app-generated table, read-only).
  Inline marks: bold, italic, strike, stock mention.
- Toolbar: B I S H, bullets, numbered, checklist, callout, table, image, `$` stock, snapshot, undo, "AI rewrite".
  The toolbar sits above the tab bar so it stays reachable above the phone keyboard.
- More menu: History, Apply a template, Export as Markdown, Show on the Research page of each name, Delete.
- Templates: Morning plan, Evening review, Trade note, Weekly review. On an empty entry they fill it; otherwise
  they append.

### AI rewrite (bottom sheet)

1. Choose: six mode cards, a custom instruction box, a switch "Give it today's positions and scan as context"
   (off by default), one line saying how it runs and that nothing is written until accepted.
2. Running: progress lines in the same style as research runs (word count, locked block count, mode, context,
   model, cap). Cancel is always available. The user may close the sheet and keep writing; the result waits.
3. Suggestion: tabs Suggestion (rendered) and Changes (word diff, green inserted, red struck). Cost line: mode,
   model, dollars, seconds, "locked blocks kept 3 of 3". Footer: Keep mine, Try again, Use suggestion.
4. Accept: the document is replaced, a revision is written, a toast offers Undo for 8 seconds.

### History (bottom sheet)

A list of revisions (time, who: You or "AI · Polish (accepted)", what), Current marker, Restore buttons. Restore
appends a new revision; nothing is ever deleted from the list.

## Content model

The editor is TipTap (ProseMirror) with a fixed schema. The ProseMirror JSON document is the stored source of
truth; HTML is never stored or accepted from the client.

Allowed nodes: `doc, paragraph, heading(level 2 only), bulletList, orderedList, listItem, taskList, taskItem,
blockquote, table, tableRow, tableHeader, tableCell, figure(image + caption), snapshot, hardBreak`.
Allowed marks: `bold, italic, strike, stockMention(market, symbol)`.
Anything else is dropped by the server-side schema validator (TipTap's `generateJSON`/schema check runs in Node
too, so the server validates with the same schema the editor uses).

Derived on every save, stored next to the JSON:

- `markdown`: a deterministic Markdown rendering (headings, lists, GFM tables, `![caption](asset:<id>)` for
  figures, `<!-- snapshot:<id> -->` plus the table for snapshots, `$SYMBOL` for mentions). Used for export, for
  the AI prompt, and for the Research page preview.
- `plain`: text for search (`tsvector`, English config; Chinese falls back to trigram on the same column).
- `word_count`, `mentions` (instrument ids found in `stockMention` marks and in bare `$SYMBOL` text).

Stock mention detection runs in the editor (an input rule on `$` and on patterns like `0700.HK`, `NKE`), and the
server re-derives mentions from the JSON so the junction table is never trusted from the client.

## Data model (next free migration number; ai-analysis.md also claims 0008, whichever lands first renumbers)

```sql
create table journal_entries (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references app_users(id) on delete cascade,
  entry_date    date not null,
  title         text,
  template      text check (template in ('morning','evening','trade','weekly','free')),
  market_view   text not null default 'neutral' check (market_view in ('bullish','neutral','bearish')),
  tags          text[] not null default '{}',
  doc           jsonb not null,                 -- ProseMirror JSON, schema-validated
  markdown      text not null default '',
  plain         text not null default '',
  search        tsvector generated always as (to_tsvector('english', coalesce(title,'') || ' ' || plain)) stored,
  word_count    integer not null default 0,
  status        text not null default 'draft' check (status in ('draft','closed')),
  revision_no   integer not null default 1,     -- optimistic concurrency: the client sends the number it loaded
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (user_id, entry_date)
);
create index journal_entries_search_idx on journal_entries using gin (search);
create index journal_entries_user_date_idx on journal_entries (user_id, entry_date desc);

create table journal_revisions (
  id            uuid primary key default gen_random_uuid(),
  entry_id      uuid not null references journal_entries(id) on delete cascade,
  revision_no   integer not null,
  doc           jsonb not null,
  markdown      text not null,
  source        text not null check (source in ('user','ai_accepted','restore','template')),
  ai_run_id     uuid,                            -- set when source = 'ai_accepted'
  created_at    timestamptz not null default now(),
  unique (entry_id, revision_no)
);

create table journal_assets (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references app_users(id) on delete cascade,
  entry_id      uuid references journal_entries(id) on delete set null,  -- null until the entry is saved with it
  kind          text not null default 'image' check (kind in ('image')),
  mime          text not null,
  bytes         integer not null,
  width         integer, height integer,
  sha256        text not null,
  path          text not null,                   -- data/journal/<user>/<yyyy>/<id>.<ext>, relative to the data root
  created_at    timestamptz not null default now()
);

create table journal_entry_instruments (
  entry_id      uuid not null references journal_entries(id) on delete cascade,
  instrument_id bigint not null references instruments(id) on delete cascade,
  primary key (entry_id, instrument_id)
);

create table journal_ai_runs (
  id            uuid primary key default gen_random_uuid(),
  entry_id      uuid not null references journal_entries(id) on delete cascade,
  user_id       uuid not null references app_users(id) on delete cascade,
  mode          text not null check (mode in ('polish','tighten','structure','lessons','translate_zh','translate_en','custom')),
  instruction   text,                            -- custom instruction, max 500 chars
  with_context  boolean not null default false,
  status        text not null check (status in ('queued','running','done','failed','cancelled')),
  input_markdown  text not null,                 -- prose only, locked blocks replaced by placeholders
  output_markdown text,                          -- validated model output, placeholders intact
  output_doc    jsonb,                           -- parsed back to ProseMirror JSON with locked blocks restored
  accepted      boolean,                         -- null until the user decides
  model         text, cost_usd numeric(10,4), duration_ms integer, error text,
  created_at    timestamptz not null default now(), finished_at timestamptz
);
```

Drizzle definitions go into `src/db/schema.ts` as usual; the SQL above is the shape, not the migration.

Snapshots: a `snapshot` node stores `{kind: 'positions'|'scan', asOf, rows}` inline in the document. It is a
copy on purpose: the entry says what the user saw that day, and re-rendering from live tables would rewrite history.

## API (all behind the existing auth gate; every route under `/api/journal/entries` and `/api/journal/assets`)

```
GET    /api/journal/entries?from=&to=&q=&symbol=&tag=&page=      list (cards: no doc, excerpt from plain)
GET    /api/journal/entries/:date                                 one entry by date (404 if none)
PUT    /api/journal/entries/:date                                 create or update {title, template, marketView, tags, doc, revisionNo}
                                                                  409 when revisionNo != stored (client reloads and merges)
POST   /api/journal/entries/:date/close                           status draft -> closed (and back with ?reopen=1)
DELETE /api/journal/entries/:date                                 soft: moves to a 'deleted' status for 30 days (not in list)
GET    /api/journal/entries/:date/revisions                       list
POST   /api/journal/entries/:date/revisions/:no/restore           appends a new revision
GET    /api/journal/entries/:date/export.md                       Markdown with asset links rewritten to absolute app URLs
GET    /api/journal/calendar?month=2026-10                        days with entry, market view, word count
GET    /api/journal/lessons?limit=                                lessons across entries (see Lessons extraction)
GET    /api/journal/snapshot?kind=positions|scan                  rows for the snapshot node (reads the same services as Positions / Today)
POST   /api/journal/assets               multipart image, returns {id, url, width, height}
GET    /api/journal/assets/:id           the image, auth-gated, Cache-Control private, X-Content-Type-Options nosniff
DELETE /api/journal/assets/:id           only when no entry references it
POST   /api/journal/entries/:date/ai     {mode, instruction?, withContext?} -> {runId}  (409 if a run is already running for this entry)
GET    /api/journal/ai/:runId            status, progress, output (output_doc when done)
POST   /api/journal/ai/:runId/cancel
POST   /api/journal/ai/:runId/accept     writes a revision (source ai_accepted), replaces doc, sets accepted=true
POST   /api/journal/ai/:runId/reject     accepted=false
GET    /api/stocks/:market/:symbol/journal                        entries that mention the name (for the Research page card)
```

The existing `POST /api/journal/import` (trade CSV) keeps working; its proper home is `/api/positions/import`
and it should be moved with a redirect in the same migration of names (TODOS).

## AI rewrite pipeline

Runs through the executor that Research already uses (`src/server/research/executor.ts`, `claude -p`,
stream-json), with these differences:

- `tools: []` and `allowedTools: []`. No web, no file reads. The model gets the prose and the instruction only.
- `maxBudgetUsd` 0.10 per run (env `OT_JOURNAL_MAX_BUDGET_USD`), a daily cap of 20 runs per user
  (`OT_JOURNAL_DAILY_RUNS`), one running run per entry.
- Model: `OT_JOURNAL_MODEL`, default `claude-haiku-5-5` (fast and cheap for prose; Research keeps its own model).
- `--no-session-persistence`, a 90-second timeout, cancel kills the process tree (existing `killTree`).

Prompt contract (system text inside the prompt, since `claude -p` takes one prompt):

```
You rewrite a private investment diary entry for its author. Mode: <mode>. <mode rules>.
Rules that apply to every mode:
- Keep the author's meaning, decisions and voice. Do not add opinions, trades, advice or facts that are not in the text.
- Keep every number, ticker, strike, date, currency and percentage exactly as written.
- Keep every placeholder line exactly: [[FIG:1]], [[SNAP:1]], [[TODO:1]] ... They are images, tables and checklists you cannot see.
- Keep Markdown headings (##) and lists. Output Markdown only, no preamble, no code fence.
<custom instruction, if any, quoted as the author's own words>
<optional context block: "For reference only, do not copy into the entry:" + positions / scan summary>
--- ENTRY ---
<prose markdown with placeholders>
```

Locked blocks: before the prompt is built, every `figure`, `snapshot`, `table` and `taskList` node is cut out
of the document and replaced by a placeholder paragraph `[[FIG:n]]`, `[[SNAP:n]]`, `[[TBL:n]]`, `[[TODO:n]]`.
Tables are locked too (a put-seller's table is numbers; the model has no business there); "Structure" mode may
move a placeholder, not change it.

Validator (the run fails with a reason shown in the sheet when any check fails; the entry is untouched):

1. Every placeholder appears exactly once in the output.
2. Every number token (`\d[\d,.]*%?`), every ticker (`\b\d{4}\.HK\b|\b[A-Z]{1,5}\b` that matched a watched name)
   present in the input is present in the output, except in Tighten mode where numbers may be dropped but never
   changed (the set of output numbers must be a subset of input numbers), and in Lessons mode where new numbers
   are allowed only in the appended section.
3. Output length within 0.3x to 2.5x of input (Lessons: input unchanged plus an appended section of at most
   300 words; the validator checks the prefix equals the input).
4. The output parses with the Markdown-to-ProseMirror parser into the allowed schema; unknown constructs are
   dropped and counted; more than 2 dropped nodes fails the run.
5. No URLs that were not in the input (the model must not "cite").

Then placeholders are swapped back for the original nodes and the result is stored as `output_doc`. The client
renders Suggestion from `output_doc` and Changes from a word diff of `input_markdown` against `output_markdown`.

Context switch (off by default): adds the positions snapshot rows and today's scan picks (symbol, strike, expiry,
rule outcome) as a reference block. It is the user's own data, local, and the model has no tools, so the exposure
is the same as the Research runs already make. Logged in `journal_ai_runs.with_context`.

Lessons extraction: the "Lessons & actions" mode appends `## Lessons & actions (AI draft)` with bullets and a
checklist. The Lessons list in the UI is a query, not a table: paragraphs starting with `Lesson:` and bullets under
that heading, taken from `markdown` at read time (cheap: a regex over the month's entries, cached per entry hash).

### What the AI may not do

- Write to the entry without an explicit accept (no auto-apply, no "apply on save").
- Touch locked blocks or numbers (validator).
- Read anything outside the entry and the optional context block (no tools).
- Feed anything into the scanner. `journal_*` tables are never read by `DataAccess`. Docs/ai-analysis.md keeps
  the only paths by which model output reaches a skill, and the journal is not one of them.

## Images

- Upload: multipart to `POST /api/journal/assets`, max 8 MB, accepted by magic bytes (PNG, JPEG, WebP, GIF;
  HEIC converted). `sharp` is a new dependency: it re-encodes (strips EXIF including location), caps the long edge
  at 2000 px, and writes a 320 px thumbnail used by the list cards. Original bytes are not kept.
- Storage: `data/journal/<user_id>/<yyyy>/<asset_id>.<ext>` under the existing data root, never a client-chosen
  name. `sha256` de-duplicates re-uploads of the same screenshot.
- Serving: auth-gated route, `Content-Type` from the stored mime, `nosniff`, `Content-Disposition: inline`,
  `Cache-Control: private, max-age=86400`. Images are same-origin, so the CSP needs no change.
- The editor inserts a `figure` node with `assetId`; paste and the camera roll both go through the same upload.
  Until the upload returns, the figure shows a local blob preview with a progress ring; a failed upload leaves a
  "retry" placeholder, never a dangling `assetId`.
- Orphans (assets with `entry_id` null for more than 24 hours) are deleted by a pg-boss job.

## Security and privacy

- Every route is attached under the existing auth gate (the encoded-path lesson in DECISIONS 2026-10-11 applies).
- Per-user isolation: every query filters by `user_id` from the session; asset ids are UUIDs but access is still
  checked against `user_id`.
- No HTML from the client, ever. The server accepts ProseMirror JSON, validates against the schema (node types,
  attrs, mark types), rejects unknown attrs (an `img` with `onerror` cannot exist because `figure.assetId` is
  the only image attr and it must match a `journal_assets` row of the same user).
- Rendering uses TipTap's `generateHTML` with the same schema; the Research-page preview uses the stored
  `markdown` through the existing Markdown renderer.
- Limits: doc 512 KB, title 200 chars, tags 20 x 40 chars, custom instruction 500 chars, 20 AI runs a day.
- Journal content is the user's own words; it is not an injection surface for the app. The context block comes
  from the database, not the web. The model's output is treated as untrusted Markdown and goes through the
  validator and the schema parser; it never becomes HTML without that.
- Export is a Markdown download; images are linked by app URL (auth required to open them).

## Autosave and conflicts

- Debounced 1.5 s after the last keystroke, plus on blur and on page hide (`visibilitychange`), via `PUT` with the
  loaded `revisionNo`. The server bumps `revision_no` on every successful write.
- A 409 (edited on another device) shows "This entry changed on another device" with Reload and Keep mine
  (which re-sends with the new number). Last write wins after that choice.
- A revision row is written when: the previous revision is older than 10 minutes, an AI suggestion is accepted, a
  template is applied, a restore happens. Plain autosaves between do not create rows.
- localStorage keeps the current entry's doc as a fallback for a lost connection; on reopen, if it is newer than
  the server copy the editor offers to use it.

## Editor choice

TipTap 2 (MIT, ProseMirror underneath) with `@tiptap/react`, `starter-kit`, `extension-table`,
`extension-task-list`, `extension-image` (replaced by a custom `figure` node), `extension-placeholder`,
`tiptap-markdown` for the Markdown round trip. About 180 KB gzipped added to the web bundle, loaded only on the
Journal page (lazy chunk). Reasons over alternatives:

- Lexical: good on mobile, but its Markdown and table story is thinner and the schema is less strict.
- Quill: Delta format, weak tables, no custom block nodes without pain.
- Plain textarea with Markdown: fails the "images and tables on a phone" goal; a phone user cannot type a GFM table.

Mobile specifics: the fixed toolbar is positioned above the tab bar (`bottom: var(--tabbar)`), which on iOS stays
above the keyboard because the page scrolls, not the viewport; tested in the prototype at 375 px. Checklist
checkboxes are 17 px with 44 px row hit areas. Tables scroll horizontally inside their own container.

## Mobile requirements (the user writes on a phone; these are acceptance criteria, not nice-to-haves)

Checked in the prototype at 375 x 812, 375 x 667 and 320 x 568 (iPhone SE), light and dark. Items marked
"device" cannot be verified in a desktop browser and are part of the J1 real-device pass.

Layout and touch

- No horizontal page scroll at 320 px. Only tables scroll, inside their own container, with momentum scrolling.
- Every control at least 44 px tall on phones (toolbar buttons 44 x 44, segments 40, list rows 60). Checklist rows
  are 44 px and tapping the text toggles the box, not only the 22 px box.
- Every text field is 16 px or larger on phones. iOS Safari zooms the whole page when a smaller field gets focus
  and does not zoom back; this is the single most common "mobile unfriendly" bug and the prototype had it.
- `touch-action: manipulation` on controls (no 300 ms tap delay, no accidental double-tap zoom).
- Bottom sheets: `overscroll-behavior: contain` so scrolling the suggestion does not pull-to-refresh the page;
  max height 92 dvh; the sheet body scrolls, the footer buttons stay put. On a 667 px phone the AI result sheet
  shows the tabs, about 12 lines of suggestion, and the three buttons without scrolling.
- Safe areas: tab bar and toolbar add `env(safe-area-inset-bottom)`; sticky headers start at the top inset.
- Dark mode follows the system (the tokens already exist); the diff colours (added green, removed red) were
  chosen to read on both backgrounds.

Keyboard (device)

- The formatting toolbar is `position: fixed` and iOS puts fixed elements behind the keyboard. The editor listens
  to `visualViewport` resize and scroll and pins the toolbar to the top edge of the keyboard while the document
  has focus; the tab bar hides while the keyboard is open so the toolbar is the only bar. The prototype has this
  code; it needs the real-device pass to confirm on iOS 18 Safari and on the home-screen (standalone) app.
- The toolbar scrolls horizontally when it does not fit (320 px); "AI rewrite" is pinned at its right end.
- Enter on a phone keyboard inside a checklist adds a new item; Enter on an empty item leaves the list (TipTap
  defaults). The ProseMirror input rules for `- `, `1. `, `[] ` and `$` give Markdown-style shortcuts without
  reaching for the toolbar.
- Autosave on `visibilitychange` (hidden) and `pagehide`, because iOS kills background tabs without warning.

Navigation

- Opening an entry pushes a history entry; the iOS swipe-back gesture and Android Back return to the list instead
  of leaving the app. The prototype does this with `pushState`; the app uses its hash router (`#/journal/2026-10-13`).
- The Journal tab remembers which day was open (per-tab state, like the other pages).

Images (device)

- `<input type="file" accept="image/*">` offers Camera and Photo Library on iOS and Android; pasting a screenshot
  into the editor also works on iOS 16+ (`paste` event with image items). Both go through the same upload.
- HEIC from an iPhone camera is converted on the server (`sharp` with libheif); the editor shows the local preview at
  once and swaps in the served image when the upload finishes, so a slow connection never blocks typing.
- Uploaded images are capped at 2000 px and the list uses 320 px thumbnails: a month of entries with screenshots
  stays under 2 MB on a phone connection.

Performance and offline

- The Journal page is a lazy chunk (TipTap is about 180 KB gzipped); the rest of the app does not pay for it.
- The current entry's document is mirrored to localStorage on every autosave; on reopen with no network the editor
  loads it and shows "Offline, saved on this phone" until the next successful PUT.
- The AI run is polled every 2 s while the sheet is open and every 10 s when it is closed; a push notification is
  not needed because runs finish in 5 to 20 s.

Home screen

- A web app manifest (`display: standalone`, theme colour from the tokens, 180 px apple-touch-icon) so "Add to Home
  Screen" opens the app without browser chrome. This is app-wide, not journal-only, and is a small J1 task.

## Research page tie-in

A "Your notes" card on Research › <name>: the last three entries mentioning the name (date, title, the paragraph
that mentions it), linking to the entry. Read through `GET /api/stocks/:market/:symbol/journal`. Presentation
only; S0 to S7 never see it.

## Build stages

J1 Entries and editor (no AI, no images). Migration, repos, routes, TipTap editor with the schema above, list,
   week strip, month calendar, autosave with 409 handling, revisions, templates, Markdown export, mock routes for
   `pnpm web:dev`, tests: schema validator (rejects unknown nodes and attrs), repo round trip, route auth gate,
   409 on stale `revisionNo`, Markdown rendering golden tests.
J2 Images. Upload route with `sharp`, magic-byte check, thumbnails, figure node, paste and camera, orphan job.
   Tests: rejects a PNG-named EXE, strips EXIF, 8 MB cap, per-user isolation on GET.
J3 AI rewrite. `journal_ai_runs`, prompt builder, locked-block cut and restore, validator, executor with no tools,
   sheet UI with Suggestion and Changes, accept and undo, daily cap. Tests: placeholder round trip, every validator
   rule with a failing fixture, FakeExecutor end to end, cancel kills the run, the entry is byte-identical after a
   rejected or failed run.
J4 Cross links and lessons. Mentions junction, Research card, Lessons list, search by symbol and tag, snapshot node.

Each stage ends with the real-browser pass at 375 px that the other milestones used.

## Decisions taken in this session (also in DECISIONS.md)

- Name: the UI says "Journal"; tables are `journal_*`; the existing trade-CSV import keeps its route for now.
- One entry per day, sections by template, instead of many small notes: it matches "daily journal" and makes the
  calendar and streak meaningful.
- AI is a suggestion with a diff and an explicit accept; never auto-applied. Locked blocks and the number validator
  are the guard against the model editing a trade record.
- Default model for rewrites is Haiku 5.5 through the same CLI executor; cost cap $0.10 a run, 20 runs a day.
- TipTap over Lexical and Quill for tables, custom nodes and the Markdown round trip.
- Images re-encoded with `sharp` (EXIF stripped) and stored under the data root, served through an auth-gated route.
- Journal becomes the second tab; the "More" tab fallback is noted, not built.

## Open questions for the user (not blocking the build)

- Should "closed" entries (end of day) become read-only unless reopened, or is Draft/Closed only a chip?
- Chinese as the default language of the Translate mode: the prototype offers 中文 only; English-to-Chinese and back
  are both in the `mode` check constraint.
- Whether Weekly review should be generated by the AI from the week's entries (a reasonable J5).
