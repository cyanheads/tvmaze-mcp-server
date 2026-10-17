<div align="center">
  <h1>@cyanheads/tvmaze-mcp-server</h1>
  <p><b>Search TVmaze shows and people, next episodes in your timezone, episode guides, daily schedules, and credits via MCP. STDIO or Streamable HTTP.</b>
  <div>8 Tools</div>
  </p>
</div>

<div align="center">

[![Version](https://img.shields.io/badge/Version-0.3.0-blue.svg?style=flat-square)](./CHANGELOG.md) [![License](https://img.shields.io/badge/License-Apache%202.0-orange.svg?style=flat-square)](./LICENSE) [![Docker](https://img.shields.io/badge/Docker-ghcr.io-2496ED?style=flat-square&logo=docker&logoColor=white)](https://github.com/users/cyanheads/packages/container/package/tvmaze-mcp-server) [![MCP SDK](https://img.shields.io/badge/MCP%20SDK-^2.3.1-green.svg?style=flat-square)](https://modelcontextprotocol.io/) [![npm](https://img.shields.io/npm/v/@cyanheads/tvmaze-mcp-server?style=flat-square&logo=npm&logoColor=white)](https://www.npmjs.com/package/@cyanheads/tvmaze-mcp-server) [![TypeScript](https://img.shields.io/badge/TypeScript-^7.0.2-3178C6.svg?style=flat-square)](https://www.typescriptlang.org/) [![Bun](https://img.shields.io/badge/Bun-v1.4.3-blueviolet.svg?style=flat-square)](https://bun.sh/)

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

TV data from TVmaze: shows, episode guides, cast, and air times. Find a show by title or IMDb/TheTVDB id, see when the next episode airs in your timezone, or check what aired and streamed on any date. No API key required.

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
| `tvmaze_get_person` | Search person names for candidates, or page one person's cast, guest, or crew credits |

## Capability reference

### `tvmaze_search_shows` <sub>tool</sub>

- Fuzzy-matches `query` against every show title, so minor misspellings still resolve; blank titles are rejected
- Returns at most 10 shows with no pagination; output reports `shown` / `cap` and points a full or empty result to a narrower title or `tvmaze_lookup_show`
- Rows carry the shared show summary plus `match_score`, comparable only within one result set

---

### `tvmaze_get_show` <sub>tool</sub>

- `show_id` from `tvmaze_search_shows`, `tvmaze_lookup_show`, or a schedule row; optional IANA `timezone` for episode times
- Returns the full profile (`schedule_days` / `schedule_time`, optional `schedule_timezone`, `official_site`, `externals`) with every season plus `next_episode` / `previous_episode`. A `Running` show with nothing announced comes back with a notice pointing at `previous_episode`
- An unknown `show_id` fails as `show_not_found`

---

### `tvmaze_lookup_show` <sub>tool</sub>

- `source` is `imdb` (a `tt` id), `thetvdb`, or `tvrage` (defunct, present only in older records), paired with `external_id`
- IMDb ids also accept bare digits, uppercase `TT`, and `imdb.com` title URLs
- A show absent from TVmaze is a result, not an error: `found: false` plus `guidance` routing to `tvmaze_search_shows`. A hit echoes `source` and `external_id` and returns the same show summary as search

---

### `tvmaze_get_next_episode` <sub>tool</sub>

- `by: "id"` takes a TVmaze id; `by: "title"` resolves a non-blank title through a stricter single-match search than `tvmaze_search_shows`
- Air times render in the requested IANA `timezone`; `time_known: false` means no clock time was announced, so only the date is reliable
- Misses carry a typed `miss_reason`: `show_not_found` (title) or `no_scheduled_episode` (between seasons, with `previous_episode`). A `show_id` that resolves to nothing throws `show_not_found_by_id`

---

### `tvmaze_get_episodes` <sub>tool</sub>

- `season` lists one season; `air_date` (`YYYY-MM-DD`) lists one day's episodes; omit both for the whole run. They cannot be combined. An empty day returns an empty list with a notice, an impossible date fails as `invalid_date`, and `season_not_found` names the seasons that exist
- `air_date` matches the source's `airdate`, which can differ by a day from an episode's `local_date` on late-night slots
- `include_specials` defaults to false, and each listing reports how many specials it filtered out. `limit` (default 50, max 250) sets page size; `next_cursor` / `has_more` continue the listing and `totalCount` counts before paging

---

### `tvmaze_get_schedule` <sub>tool</sub>

- `scope` picks the feed: `linear` is one country's broadcast and cable networks plus its own streaming services, `streaming` is global services when `country` is omitted and that country's local ones when given, `all` merges both
- `date` defaults to today in the requested `timezone`; `country` is ISO 3166-1 alpha-2 (the United Kingdom is `GB`) and falls back to the configured default for `linear` and `all`; optional `channel` filters by exact, case-insensitive channel name; `limit` defaults to 50 (max 250)
- Entries carry `feed` (`linear` / `streaming`) and a compact `show` reference (`tvmaze_get_show` returns the full profile). `applied_feeds` names the feeds that answered, e.g. `["linear:GB","web:GB","web:global"]`; one failing feed degrades to a notice instead of failing the call

---

### `tvmaze_get_cast` <sub>tool</sub>

- `scope: "show"` returns the main cast with character names; `scope: "episode"` returns that episode's guest cast. `include_crew` adds the show's crew, or the episode's guest crew (director, writers)
- Optional `name` filters by substring of performer, character, or crew role (crew only with `include_crew: true`). Paged with `limit` (default 50, max 250) and `cursor`; `cast_total` / `crew_total` count all matching credits
- Cast credits carry `as_self` and `voice_only`; crew credits carry `credit_type` and no character. A show's cast list does not separate recurring from guest performers, so check an episode's guest cast. Missing credits arrive as a notice, not an error

### `tvmaze_get_person` <sub>tool</sub>

- Supply exactly one of `query` (name search) or `person_id` (from cast credits or a candidate). Search returns compact candidates with source scores and never picks one for you; ten candidates may mean the source cap, so narrow the name
- A `person_id` returns the person and one `credit_kind`: `cast` (default), `guest`, or `crew`; `limit` (default 50, max 250) and `cursor` apply only here. Guest `episode_id` chains to `tvmaze_get_cast`; `show_id` chains to `tvmaze_get_show` or `tvmaze_get_episodes`
- No candidates or credits is an empty success; a missing id is `person_not_found`

## Features

Built on [`@cyanheads/mcp-ts-core`](https://github.com/cyanheads/mcp-ts-core): stdio and Streamable HTTP transports, pluggable auth (`none` / `jwt` / `oauth`), swappable storage (`in-memory`, `filesystem`, `Supabase`, `Cloudflare KV/R2/D1`), structured logging with optional OpenTelemetry tracing.

TVmaze-specific:

- Keyless — no account, no API key, and every tool works on a fresh install with nothing configured
- Requests are paced under TVmaze's per-IP limit, back off on 429 (honoring `Retry-After`), and are cached in-process
- Air times are computed from `airstamp` alone, since `airdate` / `airtime` can be a full day off on overnight slots
- Community-authored HTML summaries are stripped to plain text

Agent-friendly output:

- No fabricated clock times: a record with no announced time reports `time_known: false` and a date only, and absent fields render as `Not available` rather than `0` or `""`
- Typed errors on every tool, each with a `reason` and a recovery hint
- Resolution misses are results: `tvmaze_lookup_show` and the title arm of `tvmaze_get_next_episode` return `found: false` with `guidance` for the next call
- Output states what a call covered: the echoed query, `applied_feeds`, pre-page totals, and truncation against the source's caps

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
| `MCP_SESSION_MODE` | HTTP session mode; this server is always `stateless`. | `stateless` |
| `MCP_AUTH_MODE` | Auth mode: `none`, `jwt`, or `oauth`. | `none` |
| `MCP_LOG_LEVEL` | Log level (RFC 5424). | `info` |
| `LOGS_DIR` | Directory for log files (Node.js only). | `<project-root>/logs` |
| `LOG_TOOL_FAILURE_PAYLOADS` | Log a failed tool call's arguments and result (key-name redaction only). | `false` |
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
| `src/index.ts` | `createApp()` entry point — registers the eight tools, server instructions, and the service lifecycle. |
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
