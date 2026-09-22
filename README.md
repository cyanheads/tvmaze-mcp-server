<div align="center">
  <h1>@cyanheads/tvmaze-mcp-server</h1>
  <p><b>Search TVmaze shows, next episodes in your timezone, episode guides, daily TV schedules, and cast via MCP. STDIO or Streamable HTTP.</b>
  <div>7 Tools</div>
  </p>
</div>

<div align="center">

[![Version](https://img.shields.io/badge/Version-0.2.0-blue.svg?style=flat-square)](./CHANGELOG.md) [![License](https://img.shields.io/badge/License-Apache%202.0-orange.svg?style=flat-square)](./LICENSE) [![Docker](https://img.shields.io/badge/Docker-ghcr.io-2496ED?style=flat-square&logo=docker&logoColor=white)](https://github.com/users/cyanheads/packages/container/package/tvmaze-mcp-server) [![MCP SDK](https://img.shields.io/badge/MCP%20SDK-^2.0.0-green.svg?style=flat-square)](https://modelcontextprotocol.io/) [![npm](https://img.shields.io/npm/v/@cyanheads/tvmaze-mcp-server?style=flat-square&logo=npm&logoColor=white)](https://www.npmjs.com/package/@cyanheads/tvmaze-mcp-server) [![TypeScript](https://img.shields.io/badge/TypeScript-^7.0.2-3178C6.svg?style=flat-square)](https://www.typescriptlang.org/) [![Bun](https://img.shields.io/badge/Bun-v1.4.0-blueviolet.svg?style=flat-square)](https://bun.sh/)

</div>

<div align="center">

[![Install in Claude Desktop](https://img.shields.io/badge/Install_in-Claude_Desktop-D97757?style=for-the-badge&logo=anthropic&logoColor=white)](https://github.com/cyanheads/tvmaze-mcp-server/releases/latest/download/tvmaze-mcp-server.mcpb) [![Install in Cursor](https://cursor.com/deeplink/mcp-install-dark.svg)](https://cursor.com/en/install-mcp?name=tvmaze-mcp-server&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkBjeWFuaGVhZHMvdHZtYXplLW1jcC1zZXJ2ZXIiXX0=) [![Install in VS Code](https://img.shields.io/badge/VS_Code-Install_Server-0098FF?style=for-the-badge&logo=visualstudiocode&logoColor=white)](https://vscode.dev/redirect?url=vscode:mcp/install?%7B%22name%22%3A%22tvmaze-mcp-server%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40cyanheads%2Ftvmaze-mcp-server%22%5D%7D)

[![Framework](https://img.shields.io/badge/Built%20on-@cyanheads/mcp--ts--core-67E8F9?style=flat-square)](https://www.npmjs.com/package/@cyanheads/mcp-ts-core)

</div>

<div align="center">

**Public Hosted Server:** [https://tvmaze.caseyjhand.com/mcp](https://tvmaze.caseyjhand.com/mcp)

</div>

---

## Overview

Television data from TVmaze — a community-maintained database of series, episodes, air times, and credits, served by a keyless public API. Find a show by title or by its IMDb, TheTVDB, or TVRage id, then read its profile, season episode guides, and cast, or ask when the next episode airs in a viewer's timezone. A whole date works as the starting point too: what a country's networks broadcast that day, what the global streaming services released, or both merged. Runs as a stdio process, a local Streamable HTTP server, or the public hosted endpoint above.

### Tools

| Tool | Description |
|:---|:---|
| `tvmaze_search_shows` | Fuzzy title search returning up to 10 shows with channel, status, genres, rating, and external catalog ids |
| `tvmaze_get_show` | Full profile for one TVmaze id — weekly slot, season list, and the previous and next episode |
| `tvmaze_lookup_show` | Resolve a show from its IMDb, TheTVDB, or TVRage id into the matching TVmaze profile |
| `tvmaze_get_next_episode` | When a show's next episode airs, by TVmaze id or title, converted to a viewer timezone |
| `tvmaze_get_episodes` | Episode guide for one season, one air date, or the whole run, with air times, runtimes, and synopses |
| `tvmaze_get_schedule` | Episodes airing on a date — broadcast and cable networks in one country, streaming services, or both |
| `tvmaze_get_cast` | A show's credited cast and the characters they play, optionally crew; or one episode's guest cast, optionally with its director and writers |

## Capability reference

### `tvmaze_search_shows` <sub>tool</sub>

- Fuzzy match on `query` against every show title, so minor misspellings still resolve
- Hard-capped at 10 rows by the source with no pagination; enrichment echoes the query and reports `shown` / `cap`, and the notice routes a saturated or empty result to a narrower title or to `tvmaze_lookup_show`
- Rows carry the shared show summary plus `match_score`, which is comparable only within one result set

---

### `tvmaze_get_show` <sub>tool</sub>

- `show_id` from `tvmaze_search_shows`, `tvmaze_lookup_show`, or a schedule row; optional IANA `timezone` for the rendered episode times
- Returns the full profile — `schedule_days` / `schedule_time`, `official_site`, `externals` — with every season and the `next_episode` / `previous_episode` the source has
- A `Running` show with nothing announced comes back with a notice pointing at `previous_episode` rather than a silently empty field
- An unknown `show_id` fails as a typed `show_not_found`

---

### `tvmaze_lookup_show` <sub>tool</sub>

- One `source` of three — `imdb` (a `tt` id), `thetvdb`, or `tvrage` (defunct, present only in older records) — paired with `external_id`
- A show absent from TVmaze is a result, not an error: `found: false` plus `guidance` routing to `tvmaze_search_shows`
- Echoes `source` and `external_id`; a hit returns the same show summary the search tool does

---

### `tvmaze_get_next_episode` <sub>tool</sub>

- `by: "id"` takes a TVmaze id; `by: "title"` resolves a title through a stricter single-match search than `tvmaze_search_shows` uses
- Air times render in the requested IANA `timezone`; `time_known: false` means the source announced no clock time, so only the date is reliable
- Typed `miss_reason` — `show_not_found` on the title arm, `no_scheduled_episode` for a series between seasons, the latter still carrying `previous_episode`; the text output's headline names the same miss
- A `show_id` that resolves to nothing throws `show_not_found_by_id`; an unresolvable title is a miss

---

### `tvmaze_get_episodes` <sub>tool</sub>

- `season` lists one season (the cheaper path); `air_date` (`YYYY-MM-DD`) lists the episodes dated to one day, the direct way to find one night of a daily show; omit both to walk the whole run. `season` and `air_date` cannot be combined
- `air_date` matches the source's `airdate`, the broadcaster's programming day, which can differ by a day from an episode's `local_date` on a late-night slot. A day with nothing on it returns an empty list with a notice; a date that is not on the calendar fails as `invalid_date`
- `include_specials` defaults to false; every listing, whether season, air date, or whole run, reports how many specials it filtered out
- `limit` 1–250 (default 50) sets the page size on every call, including one that passes `cursor`; `next_cursor` / `has_more` continue the listing, and enrichment carries the pre-page `totalCount` plus `truncated` / `shown` / `cap` on a partial page
- A `season_not_found` failure names the seasons that do exist

---

### `tvmaze_get_schedule` <sub>tool</sub>

- `scope` picks the feed: `linear` is one country's broadcast and cable networks plus its own streaming services, `streaming` is global services when `country` is omitted and that country's local ones when it is given, `all` merges both across three upstream requests
- `date` defaults to today in the requested `timezone`; `country` is ISO 3166-1 alpha-2 (the United Kingdom is `GB`) and falls back to the configured default for `linear` and `all`
- Entries carry `feed` (`linear` / `streaming`) alongside the episode; a merged query dedupes and sorts by `airstamp`
- Each entry's `show` is a compact reference — `id`, `name`, `url`, `type`, `genres`, and the channel — since a day's listing repeats a show on every episode; `tvmaze_get_show` returns the full profile
- `applied_feeds` names exactly which upstream feeds answered, e.g. `["linear:GB","web:GB","web:global"]`; one feed failing degrades to a notice instead of failing the call
- `limit` 1–250 (default 50) sets the page size on every call, including one that passes `cursor` — a country day runs to roughly 50 broadcast entries, the global streaming feed to over 120

---

### `tvmaze_get_cast` <sub>tool</sub>

- `scope: "show"` returns the main cast with character names, plus the show's crew when `include_crew` is set; `scope: "episode"` returns that episode's guest cast, plus its guest crew (director, writers) when `include_crew` is set, still in a single upstream request
- Paged on both scopes: `limit` 1–250 (default 50) and `cursor`, with cast rows first and crew rows after them in one sequence, split back into `cast` and `crew` on each page; `cast_total` / `crew_total` and the enrichment `totalCount` count every page
- Cast credits carry `as_self` and `voice_only`; crew credits carry `credit_type` and no character
- TVmaze records no recurring-versus-guest distinction on a show's cast list, so absence from it is not evidence a performer never appeared — check an episode's guest cast
- Missing credits arrive as a notice, not an error; community coverage thins on smaller titles

## Features

Built on [`@cyanheads/mcp-ts-core`](https://github.com/cyanheads/mcp-ts-core): stdio and Streamable HTTP transports, pluggable auth (`none` / `jwt` / `oauth`), swappable storage (`in-memory`, `filesystem`, `Supabase`, `Cloudflare KV/R2/D1`), structured logging with optional OpenTelemetry tracing.

TVmaze-specific:

- Keyless — no account, no API key, and every tool works on a fresh install with nothing configured
- Upstream requests are paced under the documented per-IP budget with bounded concurrency and a 429 cooldown that honors `Retry-After`, in front of an in-process response cache shared across tenants
- Air times are computed from `airstamp` alone; the `airdate` / `airtime` pair is the broadcaster's programming-day convention and diverges by a full day on overnight slots
- Community-authored HTML summaries are stripped to plain text, never rewritten or spell-corrected

Agent-friendly output:

- No fabricated clock times — a record with no announced broadcast time reports `time_known: false` and a date only, and absent upstream fields render as `Not available` rather than `0` or `""`
- Typed error contracts on every tool — a `reason` plus a recovery hint that reaches both `structuredContent` and the text surface
- Resolution misses are results, not failures: `tvmaze_lookup_show` and the title arm of `tvmaze_get_next_episode` return `found: false` with `guidance` for the next call
- Enrichment states what a call actually covered — the echoed query, `applied_feeds`, pre-page totals, and truncation against the source's own caps

## Data and licensing

Data comes from [TVmaze](https://www.tvmaze.com) and is licensed **CC BY-SA**. Credit TVmaze as the source and keep the `url` field that every show, episode, and person record carries — linking back is what satisfies attribution. Under ShareAlike, an adaptation of this data must be shared under the same licence.

TVmaze rate-limits to at least 20 calls every 10 seconds per IP address and answers a burst past that with HTTP 429; the server paces itself under that budget and backs off when one arrives. Upstream caches its output for 60 minutes, so a schedule change or a newly announced episode can take up to an hour to appear; the local response cache (`TVMAZE_CACHE_TTL_S`, default 300 s) sits well inside that window.

## Getting started

### Public Hosted Instance

A public instance is available at `https://tvmaze.caseyjhand.com/mcp` — no installation required. Point any MCP client at it via Streamable HTTP:

```json
{
  "mcpServers": {
    "tvmaze-mcp-server": {
      "type": "streamable-http",
      "url": "https://tvmaze.caseyjhand.com/mcp"
    }
  }
}
```

### Self-Hosted / Local

Add the following to your MCP client configuration file. No API key is required.

```json
{
  "mcpServers": {
    "tvmaze-mcp-server": {
      "type": "stdio",
      "command": "bunx",
      "args": ["@cyanheads/tvmaze-mcp-server@latest"],
      "env": {
        "MCP_TRANSPORT_TYPE": "stdio",
        "MCP_LOG_LEVEL": "info"
      }
    }
  }
}
```

Or with npx (no Bun required):

```json
{
  "mcpServers": {
    "tvmaze-mcp-server": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@cyanheads/tvmaze-mcp-server@latest"],
      "env": {
        "MCP_TRANSPORT_TYPE": "stdio",
        "MCP_LOG_LEVEL": "info"
      }
    }
  }
}
```

Or with Docker:

```json
{
  "mcpServers": {
    "tvmaze-mcp-server": {
      "type": "stdio",
      "command": "docker",
      "args": ["run", "-i", "--rm", "-e", "MCP_TRANSPORT_TYPE=stdio", "ghcr.io/cyanheads/tvmaze-mcp-server:latest"]
    }
  }
}
```

For Streamable HTTP, set the transport and start the server:

```sh
MCP_TRANSPORT_TYPE=http MCP_HTTP_PORT=3010 bun run start:http
# Server listens at http://localhost:3010/mcp
```

### Prerequisites

- [Bun v1.4.0](https://bun.sh/) or higher (or Node.js v24+).
- No TVmaze account or API key. Set `TVMAZE_DEFAULT_TIMEZONE` and `TVMAZE_DEFAULT_COUNTRY` once if the calls should default to somewhere other than UTC and the US.

### Installation

1. **Clone the repository:**

```sh
git clone https://github.com/cyanheads/tvmaze-mcp-server.git
```

2. **Navigate into the directory:**

```sh
cd tvmaze-mcp-server
```

3. **Install dependencies:**

```sh
bun install
```

4. **Configure environment (optional):**

```sh
cp .env.example .env
# every variable is optional — edit only what you want to override
```

## Configuration

| Variable | Description | Default |
|:---------|:------------|:--------|
| `TVMAZE_BASE_URL` | TVmaze API base URL. Override to point at an enterprise endpoint. | `https://api.tvmaze.com` |
| `TVMAZE_USER_AGENT` | `User-Agent` sent on every upstream request; TVmaze asks that clients identify themselves. | server name, version, and repository URL |
| `TVMAZE_DEFAULT_TIMEZONE` | IANA timezone used when a tool call omits `timezone`. | `UTC` |
| `TVMAZE_DEFAULT_COUNTRY` | ISO 3166-1 alpha-2 country used for `tvmaze_get_schedule` scopes `linear` and `all` when `country` is omitted. | `US` |
| `TVMAZE_CACHE_TTL_S` | Seconds to hold an upstream response in the in-process cache. `0` disables caching. | `300` |
| `TVMAZE_MAX_CONCURRENCY` | Concurrent upstream requests (1–16). | `4` |
| `TVMAZE_REQUEST_TIMEOUT_MS` | Per-request timeout in milliseconds (1000–120000). | `10000` |
| `MCP_TRANSPORT_TYPE` | Transport: `stdio` or `http`. | `stdio` |
| `MCP_HTTP_PORT` | Port for the HTTP server. | `3010` |
| `MCP_HTTP_ENDPOINT_PATH` | Path the MCP server is mounted at. | `/mcp` |
| `MCP_SESSION_MODE` | HTTP session mode. This server declares `stateless` in code — no tool asks the caller for input mid-handler. | `stateless` |
| `MCP_AUTH_MODE` | Auth mode: `none`, `jwt`, or `oauth`. | `none` |
| `MCP_LOG_LEVEL` | Log level (RFC 5424). | `info` |
| `LOGS_DIR` | Directory for log files (Node.js only). | `<project-root>/logs` |
| `STORAGE_PROVIDER_TYPE` | Storage backend. | `in-memory` |
| `OTEL_ENABLED` | Enable [OpenTelemetry instrumentation](https://github.com/cyanheads/mcp-ts-core/tree/main/docs/telemetry) (spans, metrics, completion logs). | `false` |

See [`.env.example`](./.env.example) for the full list of optional overrides.

## Running the server

### Local development

- **Build and run:**

  ```sh
  # One-time build
  bun run rebuild

  # Run the built server
  bun run start:stdio
  # or
  bun run start:http
  ```

- **Run checks and tests:**

  ```sh
  bun run devcheck   # Lint, format, typecheck, security
  bun run test       # Vitest test suite
  bun run lint:mcp   # Validate MCP definitions against spec
  ```

### Docker

```sh
docker build -t tvmaze-mcp-server .
docker run --rm -p 3010:3010 tvmaze-mcp-server
```

The Dockerfile defaults to HTTP transport, stateless session mode, and logs to `/var/log/tvmaze-mcp-server`. OpenTelemetry peer dependencies are installed by default — build with `--build-arg OTEL_ENABLED=false` to omit them.

## Project structure

| Directory | Purpose |
|:----------|:--------|
| `src/index.ts` | `createApp()` entry point — registers the seven tools, server instructions, and the service lifecycle. |
| `src/config` | Server-specific environment variable parsing and validation with Zod. |
| `src/mcp-server/tools` | Tool definitions (`*.tool.ts`) and the output schemas they share. |
| `src/services/tvmaze` | TVmaze REST client — pacing, retries, response cache, and normalization into the domain types. |
| `tests/` | Unit and integration tests mirroring `src/`. |
| `docs/` | Design document and the generated project tree. |

## Development guide

See [`CLAUDE.md`/`AGENTS.md`](./CLAUDE.md) for development guidelines and architectural rules. The short version:

- Handlers throw, framework catches — no `try/catch` in tool logic
- Use `ctx.log` for request-scoped logging; every upstream call goes through `TvmazeService`, never `fetch` from a handler
- Register new tools in the `createApp()` arrays in `src/index.ts`
- Keep the upstream boundary in the service: validate raw → normalize to the domain type → return the output schema, and never fabricate a missing field — an absent air time stays absent

## Contributing

Issues are welcome. Run checks and tests before submitting:

```sh
bun run devcheck
bun run test
```

## License

Apache-2.0 — see [LICENSE](./LICENSE) for details.
