# Option_Trading

Sell-put (cash-secured / margin put writing) decision-support app for a personal HK + US watchlist.
Node.js 22 + TypeScript + PostgreSQL 16, single package (`src/{core,indicators,providers,skills,db,cli}`).
Drizzle schema in `src/db/schema.ts` is the schema source of truth; `docs/03-schema.sql` is reference only.
Design docs live in `docs/` (read `docs/00-overview.md` first, then `docs/designs/sell-put-scanner.md`).
The app never places orders.

## Testing
- Framework: vitest. Run: `pnpm test`.
- Indicator golden fixtures live in `tests/fixtures/` and are generated once by `tests/fixtures/gen/` (Python + TA-Lib); never hand-edit them.

## Working rules
- Skills are pure functions over an as-of-bounded `DataAccess`; never read the clock inside a skill.
- Fundamentals are point-in-time: filter by `reported_at`, not `period_end`.
- HK contracts use the option contract size as multiplier (data/hk-board-lots.csv). It equals the stock board lot only where the exchange sets them equal (9 of the 14 listed names differ); expiry is the business day before the last business day of the month.
- Risk and sizing use full notional (strike x multiplier). Margin return is a display number only.

## Skill routing

When the user's request matches an available skill, invoke it via the Skill tool. When in doubt, invoke the skill.

Key routing rules:
- Product ideas/brainstorming → invoke /office-hours
- Strategy/scope → invoke /plan-ceo-review
- Architecture → invoke /plan-eng-review
- Design system/plan review → invoke /design-consultation or /plan-design-review
- Full review pipeline → invoke /autoplan
- Bugs/errors → invoke /investigate
- QA/testing site behavior → invoke /qa or /qa-only
- Code review/diff check → invoke /review
- Visual polish → invoke /design-review
- Ship/deploy/PR → invoke /ship or /land-and-deploy
- Save progress → invoke /context-save
- Resume context → invoke /context-restore
- Author a backlog-ready spec/issue → invoke /spec
