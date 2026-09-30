# retroachievements-mcp

A token-efficient [Model Context Protocol](https://modelcontextprotocol.io) server for the
[RetroAchievements](https://retroachievements.org) Web API. It covers all 38 documented `API_Get*`
endpoints through 15 read-only tools, and runs over **stdio** for local clients or **Streamable
HTTP** for a hosted endpoint.

## Why another one

Raw RetroAchievements responses are large and repetitive. `GetClaims` returns ~400 KB,
`GetAchievementOfTheWeek` ~69 KB, and `GetGameList` repeats a dozen keys on every one of thousands
of rows. Passing that through to a model wastes context. This server shapes every response:

| Call                                                   | Raw upstream |  Tool output |
| ------------------------------------------------------ | -----------: | -----------: |
| Achievement of the week                                |     69,150 B |   ~790 chars |
| Recent claims (10)                                     |    398,397 B | ~1,150 chars |
| Game + all 35 achievements                             |     15,963 B | ~4,000 chars |
| User progress on a game (5 locked achievements + rank) |     34,610 B |   ~820 chars |

How it does that:

- **Compact output.** JSON has no whitespace. Lists come back as tables
  (`{"cols":[…],"rows":[[…]]}`). Empty fields and all-empty columns are dropped. Timestamps are
  shortened, and images are omitted unless you ask for them.
- **Projection.** Each tool returns the fields a model actually uses, under short names. Duplicate
  and internal fields (`MemAddr`, ULIDs, forum IDs, rich-presence scripts) are dropped.
- **Server-side filtering and pagination.** Examples: locked achievements only, games by
  award status, the newest N unlocks. Results carry `total`/`next_offset` only when truncated.
- **Few tools.** 15 tools cover all 38 endpoints, which keeps the per-turn tool-schema cost low.
- **API efficiency.** Every upstream call goes through:
  - a per-endpoint TTL cache;
  - request coalescing for identical in-flight calls;
  - a concurrency ceiling and a client-side rate limiter tuned to RetroAchievements' observed
    limits, with retries and backoff on 429/5xx.
- **Game search.** RetroAchievements has no search endpoint, so per-console game catalogs are cached
  on disk. `find_games` searches every system without re-downloading 80+ catalogs on each run.

## Tools

| Tool                      | Covers                                                                                          |
| ------------------------- | ----------------------------------------------------------------------------------------------- |
| `get_user_profile`        | profile, summary (rank, status, recent games/unlocks), site awards                              |
| `get_user_unlocks`        | achievements unlocked in the last N minutes, a date range, or on a day                          |
| `get_user_games`          | recently played, completion progress (filter by mastered/beaten/…), completed, want-to-play     |
| `get_user_game_progress`  | one game's progress + locked/unlocked achievements with rarity; or a multi-game summary         |
| `get_user_social`         | following, followers, set requests, claims                                                      |
| `find_games`              | search titles across all consoles, or list a console's games                                    |
| `list_consoles`           | console/system IDs                                                                              |
| `get_game`                | game info, plus achievements, hashes, progression/median times, unlock distribution, claims     |
| `get_game_rankings`       | high scores / latest masters                                                                    |
| `get_leaderboards`        | a game's leaderboards, a leaderboard's entries, or a user's entries on a game                   |
| `get_achievement_unlocks` | who unlocked an achievement, with rarity                                                        |
| `get_feed`                | achievement of the week, top users, recent game awards, active/completed/dropped/expired claims |
| `get_comments`            | comments on a game, achievement, or user wall                                                   |
| `get_tickets`             | tickets: recent, by id, by game/achievement/developer, most-ticketed games                      |
| `ra_api_raw`              | escape hatch: any endpoint, cleaned and size-capped                                             |

All user-scoped tools default to `RA_USERNAME`, so "how am I doing on Chrono Trigger?" needs no
username argument.

## Configuration

Get a Web API key from your RetroAchievements [control panel](https://retroachievements.org/controlpanel.php).

| Env                                           | Default                                 |                                                                                                          |
| --------------------------------------------- | --------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `RA_API_KEY`                                  | —                                       | **Required.** `RETROACHIEVEMENTS_API_KEY` is accepted as an alias.                                       |
| `RA_USERNAME`                                 | —                                       | Default user for user-scoped tools.                                                                      |
| `MCP_TRANSPORT`                               | `stdio` (`http` in the container)       | Or pass `--stdio` / `--http`.                                                                            |
| `MCP_HOST` / `MCP_PORT`                       | `127.0.0.1` / `8080`                    | HTTP bind. Also `--host` / `--port`.                                                                     |
| `MCP_ALLOWED_HOSTS`                           | —                                       | Host allowlist for `/mcp`. Required off-loopback; on loopback defaults to localhost names. `*` disables. |
| `MCP_AUTH_TOKEN`                              | —                                       | Optional bearer token (≥16 chars) required on `/mcp`.                                                    |
| `RA_CACHE_DIR`                                | `$XDG_CACHE_HOME/retroachievements-mcp` | Game-catalog cache. `none` = memory only.                                                                |
| `RA_PREWARM_CATALOG`                          | `false`                                 | Load every console catalog in the background at startup.                                                 |
| `RA_RATE_PER_MINUTE` / `RA_RATE_BURST`        | `72` / `10`                             | Client-side request pacing; a 429 pauses all requests.                                                   |
| `RA_MAX_CONCURRENCY`                          | `4`                                     | Concurrent upstream requests.                                                                            |
| `RA_CACHE_MAX_BYTES`                          | `64MB`                                  | Response cache byte cap (bodies > 1 MB are never cached).                                                |
| `RA_CACHE_MAX_ENTRIES` / `RA_CACHE_TTL_SCALE` | `500` / `1`                             | Response cache size; TTL multiplier (`0` disables).                                                      |
| `RA_TIMEOUT_MS`                               | `20000`                                 | Upstream request timeout.                                                                                |
| `LOG_LEVEL`                                   | `info`                                  | Logs always go to stderr.                                                                                |

## Running locally (stdio)

Claude Code, from a release tarball (fast: prebuilt, runtime dependencies only):

```bash
claude mcp add retroachievements \
  -e RA_API_KEY=your-key -e RA_USERNAME=your-name \
  -- npx -y https://github.com/sharkusmanch/retroachievements-mcp/releases/download/v0.1.0/sharkusmanch-retroachievements-mcp-0.1.0.tgz
```

Or straight from git. This builds on first launch (~1 minute with dev dependencies), so start it once
in a terminal before a client with a short startup timeout uses it:
`npx -y github:sharkusmanch/retroachievements-mcp --version`.

Any MCP client (`mcpServers` JSON):

```json
{
  "mcpServers": {
    "retroachievements": {
      "command": "npx",
      "args": [
        "-y",
        "https://github.com/sharkusmanch/retroachievements-mcp/releases/download/v0.1.0/sharkusmanch-retroachievements-mcp-0.1.0.tgz"
      ],
      "env": { "RA_API_KEY": "your-key", "RA_USERNAME": "your-name" }
    }
  }
}
```

Or run the container over stdio. The named volume keeps the game-catalog cache between sessions:

```json
{
  "command": "docker",
  "args": [
    "run",
    "-i",
    "--rm",
    "-e",
    "RA_API_KEY",
    "-e",
    "RA_USERNAME",
    "-v",
    "retroachievements-mcp-cache:/tmp/retroachievements-mcp",
    "ghcr.io/sharkusmanch/retroachievements-mcp:latest",
    "--stdio"
  ],
  "env": { "RA_API_KEY": "your-key", "RA_USERNAME": "your-name" }
}
```

Every GitHub release attaches the tarball (`sharkusmanch-retroachievements-mcp-X.Y.Z.tgz`) with a provenance attestation.

## Running as a service (Streamable HTTP)

```bash
docker run -d -p 8080:8080 \
  -e RA_API_KEY=your-key -e RA_USERNAME=your-name \
  -e MCP_ALLOWED_HOSTS=ra-mcp.example.com \
  -e MCP_AUTH_TOKEN=a-long-random-token \
  ghcr.io/sharkusmanch/retroachievements-mcp:latest
```

- `POST /mcp`: stateless Streamable HTTP. `GET`/`DELETE` return 405.
- `GET /healthz`: liveness. It is outside the host/auth guards, and it never checks upstream health.

```bash
claude mcp add --transport http retroachievements https://ra-mcp.example.com/mcp \
  --header "Authorization: Bearer a-long-random-token"
```

The container runs as uid 1000 and works with a read-only root filesystem when `/tmp` is writable
(the catalog cache defaults to `/tmp/retroachievements-mcp` in the image).

## Supply chain

Releases are cut from `v*` tags only. Each release publishes:

- a multi-arch image (`linux/amd64`, `linux/arm64`) to GHCR, with a **SLSA build-provenance**
  attestation and an **SPDX SBOM** attestation stored in the registry;
- an npm tarball with its own provenance attestation, attached to the GitHub release.

Verify:

```bash
gh attestation verify oci://ghcr.io/sharkusmanch/retroachievements-mcp:vX.Y.Z --owner sharkusmanch
```

## Development

```bash
npm ci
npm run lint && npm run typecheck && npm test
npm run build
RA_API_KEY=… RA_USERNAME=… node scripts/smoke.mjs                       # tool list + schema sizes
RA_API_KEY=… node scripts/smoke.mjs find_games '{"query":"chrono trigger"}'
```

See [DESIGN.md](DESIGN.md) for the design rules.

## License

MIT
