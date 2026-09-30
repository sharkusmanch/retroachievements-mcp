# Design

## Goals

1. **Cover the whole RetroAchievements Web API** (all 38 documented `API_Get*.php` endpoints, all
   ticket modes).
2. **Token efficiency.** Every byte a tool returns — and every byte of tool schema — is paid for
   by the model on every turn. Optimise both.
3. **API efficiency.** Never call RA twice for the same answer inside its freshness window.
4. **Two transports from one codebase**: stdio for local clients, stateless Streamable HTTP for
   the cluster.

## Token-efficiency rules (enforced in `src/format.ts` + tool code)

- Compact JSON, never indented. Results are text-only — **no `structuredContent`/`outputSchema`**
  (the SDK would send the payload twice).
- Lists → `table()` (`{"cols":[...],"rows":[[...]]}`). Never return arrays of keyed objects for
  lists longer than a handful of rows.
- `clean()` drops null/undefined/"" everywhere; `table()` drops columns empty on every row,
  moves mostly-empty columns last and trims trailing empty cells from each row (the server
  instructions tell the model rows may be short).
- Boolean flags (`hc`, `collab`, `jr_dev`, `lower_better`, `mutual`, …) are `1` or omitted
  (`flag()`), so an all-false column disappears. Hardcore summary fields are omitted when the
  user has no hardcore progress.
- A value repeated on every row is hoisted: unlock lists carry `games: {id: title}` and only
  `game_id` per row.
- Don't echo inputs back (game/leaderboard IDs, ranking type, claim kind). `user` is echoed
  only when it was defaulted; ULIDs only when the caller passed a ULID.
- **Project, don't passthrough.** Each tool picks the fields a model actually uses and renames them
  to short snake_case. Drop: duplicate fields (`GameTitle`/`Title`, `Console`/`ConsoleName`,
  `GameIcon`/`ImageIcon`), `MemAddr`, `ULID`s (except where the user asked for them), internal
  flags, `ForumTopicID`, `RichPresencePatch`, `DisplayOrder` (use it only to sort).
- Images are omitted unless `images: true` is passed (where offered); then use `imageUrl()` /
  `badgeUrl()` to emit absolute URLs.
- Timestamps via `ts()` → `YYYY-MM-DD HH:MM` (UTC).
- **Filter and paginate server-side.** Upstream endpoints that return everything (game lists,
  achievement sets, AotW unlocks, comments) get `limit`/`offset` and filters in the tool; pages
  report `{total, next_offset}` only when truncated.
- **Few, composable tools** (≈15), each covering several endpoints via a small enum or `include`
  array. Tool descriptions ≤ ~2 sentences; parameter descriptions a few words. No examples in
  descriptions.
- Default `limit`s are small (10–50). Model can raise them.
- **Advertised schemas are lean.** Every `inputSchema` is wrapped in `lean()` (tools/common.ts),
  which prunes the JSON Schema sent in tools/list (`$schema`, `MAX_SAFE_INTEGER` maxima,
  `exclusiveMinimum: 0`, limit/offset minima, free-string length bounds, falsy/empty defaults)
  without touching zod validation. Shared params (`user`, `limit`, `offset`, `images`) carry
  no or one-phrase descriptions. `test/budget.test.ts` caps the model-facing size (name +
  description + input schema, summed) at 8,500 chars.
- Summaries up front: e.g. a game progress call returns counts/percentages first, then rows.

## API-efficiency rules (enforced in `src/client.ts`)

- `client.get(endpoint, params, ttl?)` — TTL cache (LRU-capped by entries and by estimated
  bytes, `RA_CACHE_MAX_BYTES`; bodies over 1 MB are never cached), in-flight coalescing,
  concurrency ceiling (`RA_MAX_CONCURRENCY`), token-bucket pacing, retry with backoff on
  429/5xx inside a 35 s overall deadline (a timeout is retried at most once). A 429 drains the
  shared bucket and pauses it for the retry wait, so queued requests don't hit the same window.
- Parsed bodies are **deep-frozen** — cache values are shared, so tools copy before sorting.
- Choose the TTL by volatility: `TTL.static` (consoles, hashes), `TTL.catalog` (game lists, 24 h),
  `TTL.slow` (median completion times), `TTL.game` (game metadata/sets/leaderboard defs),
  `TTL.social` (follows, want-to-play, site awards), `TTL.feed` (AotW, top ten, claims,
  rankings, comments, tickets), `TTL.user` (anything a user's play changes). `ENDPOINT_TTL`
  (client.ts) is the per-endpoint default used when no TTL is passed (e.g. `ra_api_raw`) and the
  canonical list of the 38 endpoints.
- Reuse what is already warm: `client.peek()` / `peekAny()` let `get_game` answer base info
  from a cached `GetGameExtended` or any user's `GetGameInfoAndUserProgress`.
- Cache keys are made stable: `game_ids` are sorted, open-ended time ranges round "now" up to
  the minute, and upstream page sizes are rounded up to buckets (25/100/500) and sliced locally.
- Game catalogs (`CatalogStore`) are stale-while-revalidate: < 24 h served as-is, up to 7 days
  served immediately with a background refresh, and any disk copy is served if upstream is
  down. Only the searched fields are stored. Cross-console searches (and prewarm) load only
  Active game systems when `has_achievements` is true.
- Prefer the cheapest endpoint that answers the question. E.g. `GetGame` (0.5 KB) when no
  achievements are needed, `GetGameExtended` (16 KB) only when they are. Reuse one upstream response
  for several outputs rather than calling a second endpoint.
- Where the API supports server-side limits (`c`/`o`/`count`/`offset`), pass the tool's limit
  through rather than fetching everything — **unless** the tool filters client-side, in which case
  fetch the page size that makes the filter meaningful and say so in the code.

## Tool catalogue

`user?` defaults to `RA_USERNAME`. All tools are read-only (`READ_ONLY` annotations).

| Tool                      | Upstream endpoints                                                                                           | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ------------------------- | ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `get_user_profile`        | GetUserProfile, GetUserSummary, GetUserPoints, GetUserAwards                                                 | `include?: ('summary'\|'awards')[]`. Profile always (cheap). `summary` adds rank, status/rich presence, last game, recently played (short table), recent achievements (short table). `awards` = site awards table + totals (mastered/beaten/completed counts).                                                                                                                                                                                                     |
| `get_user_unlocks`        | GetUserRecentAchievements, GetAchievementsEarnedBetween, GetAchievementsEarnedOnDay                          | Exactly one of `minutes` (≤ 43200) / `from`+`to` (ISO date or datetime) / `date`. `hardcore_only?`, `limit`. Table: date, game, achievement, points, hardcore, type.                                                                                                                                                                                                                                                                                               |
| `get_user_games`          | GetUserRecentlyPlayedGames, GetUserCompletionProgress, GetUserCompletedGames, GetUserWantToPlayList          | `list: 'recent'\|'progress'\|'completed'\|'want_to_play'`. `progress` supports `status?: 'mastered'\|'beaten'\|'in_progress'\|'unfinished'` (client filter over award kind), `console_id?`, `sort?`, `limit`/`offset`. Use upstream pagination (`c`/`o`) where possible.                                                                                                                                                                                           |
| `get_user_game_progress`  | GetGameInfoAndUserProgress, GetUserProgress, GetUserGameRankAndScore                                         | `limit` default 50, `sort?: 'display'\|'rarity'` (rarity = most-earned first). `game_id` → summary (earned/total, points, %, award kind, playtime) + achievements table filtered by `achievements?: 'locked'\|'unlocked'\|'all'\|'none'` (default `locked` — the actionable set) sorted by display order, with rarity (% of players). `include_rank?` adds GetUserGameRankAndScore. `game_ids` (array, ≤ 50) → one-row-per-game summary table via GetUserProgress. |
| `get_user_social`         | GetUsersIFollow, GetUsersFollowingMe, GetUserSetRequests, GetUserClaims                                      | `kind: 'following'\|'followers'\|'set_requests'\|'claims'`. following/followers are for the API-key owner only — say so in the description. `limit` defaults to 20 for claims, 50 otherwise.                                                                                                                                                                                                                                                                       |
| `find_games`              | GetConsoleIDs, GetGameList                                                                                   | `query?` (case-insensitive substring / token match on title), `console_id?`, at least one. Across all (Active, when `has_achievements`) consoles when `console_id` is omitted (cached catalogs). `has_achievements` default true. Hashes are in `get_game`. `incomplete` distinguishes still-loading from failed consoles. Table: id, title, console, achievements, points, leaderboards.                                                                          |
| `list_consoles`           | GetConsoleIDs                                                                                                | No params. Active game systems only. Table: id, name.                                                                                                                                                                                                                                                                                                                                                                                                              |
| `get_game`                | GetGame, GetGameExtended, GetAchievementCount, GetGameHashes, GetGameProgression, GetAchievementDistribution | Base info always (GetGame, cheap — or projected from a warm GetGameExtended / GetGameInfoAndUserProgress). `include?: ('achievements'\|'hashes'\|'progression'\|'distribution'\|'claims')[]`. `achievements` uses GetGameExtended (also gives player counts); table sorted by display order with rarity; `achievement_type?` filter; `limit`/`offset`.                                                                                                             |
| `get_game_rankings`       | GetGameRankAndScore                                                                                          | `type: 'masters'\|'latest'` (upstream `t`).                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `get_leaderboards`        | GetGameLeaderboards, GetLeaderboardEntries, GetUserGameLeaderboards                                          | Exactly one of `game_id` (list boards; with `user_entries: true` returns the user's entries via GetUserGameLeaderboards) or `leaderboard_id` (entries/rankings). `limit`/`offset` passed upstream.                                                                                                                                                                                                                                                                 |
| `get_achievement_unlocks` | GetAchievementUnlocks                                                                                        | Achievement + game header once, then unlocks table. `hardcore_only?`, `limit`/`offset` upstream.                                                                                                                                                                                                                                                                                                                                                                   |
| `get_feed`                | GetAchievementOfTheWeek, GetTopTenUsers, GetRecentGameAwards, GetActiveClaims, GetClaims                     | `kind: 'aotw'\|'top_users'\|'recent_awards'\|'active_claims'\|'claims'`. AotW: achievement/game header + unlock counts + at most `limit` most recent unlocks (upstream returns hundreds). `claims` takes `claim_kind?: 'completed'\|'dropped'\|'expired'`. `recent_awards` takes `date?`, `award_kind?`.                                                                                                                                                           |
| `get_comments`            | GetComments                                                                                                  | `target: 'game'\|'achievement'\|'user'`, `id` (number for game/achievement, username for user), `sort?: 'newest'\|'oldest'`, `limit`/`offset`. Strip automated/system comments only if trivially identifiable.                                                                                                                                                                                                                                                     |
| `get_tickets`             | GetTicketData (all 6 modes)                                                                                  | `mode: 'recent'\|'ticket'\|'game'\|'achievement'\|'developer'\|'most_ticketed'`, `id?` (ticket/game/achievement id), `user?` (developer), `details?`, `limit`/`offset`.                                                                                                                                                                                                                                                                                            |
| `ra_api_raw`              | any                                                                                                          | Escape hatch: `endpoint` (free string, validated server-side against the 38 names; error lists them), `params` (string→string/number). Returns `clean()`ed compact JSON, truncated at `max_chars` (default 8000). Description must say "prefer the dedicated tools".                                                                                                                                                                                               |

## Transports

- **stdio** (default): `npx -y github:sharkusmanch/retroachievements-mcp` or the npm package /
  docker `-i`. Logs → stderr.
- **HTTP** (`--http` / `MCP_TRANSPORT=http`): stateless Streamable HTTP at `POST /mcp`,
  `GET /healthz`. Host allowlist on `/mcp` (DNS-rebinding protection): entries normalised
  (lowercase, no port, bracketed IPv6); empty on a loopback bind = the SDK's localhost list;
  required on a non-loopback bind; `*` is an explicit, logged opt-out. Optional bearer token
  (scheme case-insensitive, timing-safe compare). Oversized bodies → 413.

## Security

- The API key is a query parameter. It is registered with the redacting logger before any log line;
  `RAError` messages are built from the response body, never the URL.
- All tools are read-only; no write endpoints exist in the RA Web API.
