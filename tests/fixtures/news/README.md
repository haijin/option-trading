# News feed fixtures

Static response bodies for the news provider tests. The five RSS files are synthetic: written for these tests in the shape of the
Yahoo Finance and CNBC RSS responses seen on 2026-10-13, with fictional headlines, plus a few items that exercise the parser: a
CDATA title, a tracking parameter, a duplicate url, an undated item, a trailing space and a numeric entity. The two HKEXnews files
(prefix lookup and title search for 00700) are trimmed from public responses. They are not market data and are never used for a
number. `tests/helpers/news-replay.ts` turns them into replayable HTTP fixtures (`src/providers/http-replay.ts`), so no test calls
the network.
