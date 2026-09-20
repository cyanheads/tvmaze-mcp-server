/**
 * @fileoverview TVmaze REST API service — the whole HTTP boundary for
 * https://api.tvmaze.com. Owns pacing against the documented per-IP budget,
 * retries, an in-process response cache, and the normalizers that turn TVmaze
 * records into this server's domain shapes. Tool handlers stay thin on top of it.
 * @module services/tvmaze/tvmaze-service
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import { config } from '@cyanheads/mcp-ts-core/config';
import {
  JsonRpcErrorCode,
  McpError,
  serializationError,
  serviceUnavailable,
  validationError,
} from '@cyanheads/mcp-ts-core/errors';
import type { Pacer } from '@cyanheads/mcp-ts-core/utils';
import { createPacer, fetchWithTimeout, withRetry } from '@cyanheads/mcp-ts-core/utils';

import { getServerConfig } from '@/config/server-config.js';
import type {
  CastCredit,
  Episode,
  LookupSource,
  RawCastCredit,
  RawCrewCredit,
  RawEpisode,
  RawSearchHit,
  RawSeason,
  RawShow,
  ScheduleEntry,
  ScheduleFeed,
  Season,
  ShowDetail,
  ShowProfile,
  ShowSearchHit,
  ShowSummary,
} from './types.js';

/** Codes `withRetry` already treats as transient — the set worth restating as an upstream outage. */
const TRANSIENT_CODES: ReadonlySet<JsonRpcErrorCode> = new Set([
  JsonRpcErrorCode.ServiceUnavailable,
  JsonRpcErrorCode.Timeout,
  JsonRpcErrorCode.RateLimited,
]);

/** Entries held by the in-process response cache before the oldest is evicted. */
const MAX_CACHE_ENTRIES = 500;

// ---------------------------------------------------------------------------
// HTML
// ---------------------------------------------------------------------------

/**
 * A `Map`, not an object literal: the entity name comes from contributor-authored
 * markup, and a plain object would resolve `&constructor;` or `&toString;`
 * through `Object.prototype` and splice a JS internal into the summary.
 */
const HTML_ENTITIES = new Map<string, string>([
  ['amp', '&'],
  ['lt', '<'],
  ['gt', '>'],
  ['quot', '"'],
  ['apos', "'"],
  ['nbsp', ' '],
]);

/** Highest code point `String.fromCodePoint` accepts; anything above throws. */
const MAX_CODE_POINT = 0x10_ff_ff;

/**
 * Characters a terminal or a markdown reader interprets as control rather than
 * prose: the C0 and C1 blocks plus the Unicode line separators. Summaries are
 * contributor-authored, so an escape sequence in one is input to reject, not a
 * fault upstream. Tab and newline are the two a synopsis legitimately carries,
 * and are kept at the replace site.
 */
const CONTROL_CHARACTERS = /[\p{Cc}\p{Zl}\p{Zp}]/gu;

/**
 * Decode numeric and the handful of named HTML entities TVmaze summaries use.
 * An entity naming something other than those six, or a code point outside the
 * Unicode range, is left verbatim — the alternative is a JS internal in the
 * output or a `RangeError` that fails the whole call over one bad character.
 */
export function decodeHtmlEntities(text: string): string {
  return text.replace(
    /&(?:#x([0-9a-fA-F]+)|#(\d+)|(\w+));/g,
    (match: string, hex?: string, dec?: string, named?: string) => {
      if (hex !== undefined || dec !== undefined) {
        const codePoint =
          hex === undefined ? Number.parseInt(dec ?? '', 10) : Number.parseInt(hex, 16);
        return codePoint <= MAX_CODE_POINT ? String.fromCodePoint(codePoint) : match;
      }
      return (named === undefined ? undefined : HTML_ENTITIES.get(named)) ?? match;
    },
  );
}

/** Any tag in the source markup, where every `<` is markup rather than prose. */
const TAG = /<[^>]+>/g;

/**
 * A `<` that opens an element name, matched without its tag. It is removed from
 * the *decoded* text, where the surrounding characters are prose: dropping the
 * one character neutralizes the element while leaving a comparison like
 * `a < b` — whose `<` is followed by a space — untouched.
 */
const ELEMENT_OPENER = /<(?=\/?[a-zA-Z])/g;

/**
 * Remove every match, then look again. One pass moves past the text it splices
 * together, so a tag assembled out of two fragments survives it.
 */
function removeToFixpoint(text: string, pattern: RegExp): string {
  let out = text;
  for (let previous = ''; out !== previous; ) {
    previous = out;
    out = out.replace(pattern, '');
  }
  return out;
}

/**
 * Strip a community-authored TVmaze summary to plain text. The markup is a
 * closed set — `<p>`, `<b>`, `<i>`, `<em>`, `<strong>`, `<br>`, the occasional
 * `<a>` — so emphasis maps to its Markdown equivalent and everything else is
 * dropped. The prose itself is never rewritten or spell-corrected.
 *
 * Decoding is what makes the second pass necessary: `&lt;script&gt;` is not a
 * tag while the tag pass runs and is one immediately after, so a summary could
 * otherwise hand a live element to a client that renders this text as HTML.
 */
export function stripHtml(html: string): string {
  if (!html) return '';
  const markup = html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p\s*>/gi, '\n\n')
    .replace(/<\/?(?:b|strong)(?:\s[^>]*)?>/gi, '**')
    .replace(/<\/?(?:i|em)(?:\s[^>]*)?>/gi, '*');
  return decodeHtmlEntities(removeToFixpoint(markup, TAG))
    .replace(ELEMENT_OPENER, '')
    .replace(CONTROL_CHARACTERS, (character) =>
      character === '\n' || character === '\t' ? character : '',
    )
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// ---------------------------------------------------------------------------
// Time
// ---------------------------------------------------------------------------

/**
 * Validate an IANA zone name against the runtime's own tzdata.
 * `Intl.DateTimeFormat` throws `RangeError` on an unknown zone, which doubles
 * as the validator — no timezone library is involved.
 */
export function assertTimezone(timeZone: string, ctx: Context): string {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
    return timeZone;
  } catch (error) {
    throw validationError(
      `"${timeZone}" is not an IANA timezone name this runtime recognizes.`,
      { reason: 'invalid_timezone', ...ctx.recoveryFor('invalid_timezone') },
      { cause: error },
    );
  }
}

/** Break an instant into its calendar and clock parts in one IANA zone. */
function zonedParts(instant: Date, timeZone: string): Record<string, string> {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    timeZoneName: 'short',
  }).formatToParts(instant);
  const out: Record<string, string> = {};
  for (const part of parts) out[part.type] = part.value;
  return out;
}

/** The calendar date `now` falls on in one IANA zone, as `YYYY-MM-DD`. */
export function todayIn(timeZone: string): string {
  const parts = zonedParts(new Date(), timeZone);
  return `${parts.year ?? '0000'}-${parts.month ?? '01'}-${parts.day ?? '01'}`;
}

/**
 * Resolve an episode's air time into the requested zone.
 *
 * An empty upstream `airtime` means TVmaze holds no announced broadcast time —
 * the accompanying `airstamp` is then a placeholder (a global streaming release
 * commonly sits at exactly `T12:00:00+00:00`), so converting it would invent a
 * clock time that was never published. Those rows report the upstream `airdate`
 * and no `local_time`.
 */
function resolveAirTime(
  raw: Pick<RawEpisode, 'airstamp' | 'airtime' | 'airdate'>,
  timeZone: string,
): Pick<Episode, 'local_date' | 'local_time' | 'time_known'> {
  const announced = typeof raw.airtime === 'string' && raw.airtime.trim().length > 0;
  const instant = new Date(raw.airstamp);
  const fallbackDate = raw.airdate ?? raw.airstamp.slice(0, 10);

  if (!announced || Number.isNaN(instant.getTime())) {
    return { local_date: fallbackDate, time_known: false };
  }

  const parts = zonedParts(instant, timeZone);
  const localDate = `${parts.year ?? '0000'}-${parts.month ?? '01'}-${parts.day ?? '01'}`;
  return {
    local_date: localDate,
    local_time:
      `${localDate} ${parts.hour ?? '00'}:${parts.minute ?? '00'} ${parts.timeZoneName ?? ''}`.trim(),
    time_known: true,
  };
}

// ---------------------------------------------------------------------------
// Normalizers
// ---------------------------------------------------------------------------

/**
 * Uppercase a country code and fold the common `UK` mistake onto the ISO code
 * TVmaze actually accepts. `UK` is rejected upstream with 422; `GB` succeeds.
 */
export function normalizeCountry(code: string): string {
  const upper = code.trim().toUpperCase();
  return upper === 'UK' ? 'GB' : upper;
}

/** Pick the channel carrying a show: the streaming service when present, else the network. */
function channelOf(
  raw: RawShow,
): Pick<ShowSummary, 'channel' | 'channel_type' | 'channel_country'> {
  const web = raw.webChannel?.name ? raw.webChannel : undefined;
  const network = raw.network?.name ? raw.network : undefined;
  const picked = web ?? network;
  if (!picked?.name) return {};
  return {
    channel: picked.name,
    channel_type: web ? 'web_channel' : 'network',
    ...(picked.country?.code ? { channel_country: picked.country.code } : {}),
  };
}

/** Normalize a show record into the compact identity every tool shares. */
export function normalizeShow(raw: RawShow): ShowSummary {
  const externals = raw.externals ?? {};
  const summary = raw.summary ? stripHtml(raw.summary) : '';
  return {
    id: raw.id,
    name: raw.name,
    url: raw.url,
    ...(raw.type ? { type: raw.type } : {}),
    ...(raw.language ? { language: raw.language } : {}),
    ...(raw.status ? { status: raw.status } : {}),
    ...(raw.premiered ? { premiered: raw.premiered } : {}),
    ...(raw.ended ? { ended: raw.ended } : {}),
    genres: raw.genres ?? [],
    ...(typeof raw.runtime === 'number' ? { runtime_minutes: raw.runtime } : {}),
    ...(typeof raw.averageRuntime === 'number'
      ? { average_runtime_minutes: raw.averageRuntime }
      : {}),
    ...(typeof raw.rating?.average === 'number' ? { rating: raw.rating.average } : {}),
    ...channelOf(raw),
    externals: {
      ...(externals.imdb ? { imdb: externals.imdb } : {}),
      ...(typeof externals.thetvdb === 'number' ? { thetvdb: externals.thetvdb } : {}),
      ...(typeof externals.tvrage === 'number' ? { tvrage: externals.tvrage } : {}),
    },
    ...(raw.image?.original ? { image_url: raw.image.original } : {}),
    ...(summary ? { summary } : {}),
  };
}

/** Normalize a show record into the full profile `/shows/{id}` carries. */
export function normalizeShowProfile(raw: RawShow): ShowProfile {
  return {
    ...normalizeShow(raw),
    ...(raw.officialSite ? { official_site: raw.officialSite } : {}),
    schedule_days: raw.schedule?.days ?? [],
    ...(raw.schedule?.time ? { schedule_time: raw.schedule.time } : {}),
  };
}

/** Normalize an episode record, resolving its air time into `timeZone`. */
export function normalizeEpisode(raw: RawEpisode, timeZone: string): Episode {
  const summary = raw.summary ? stripHtml(raw.summary) : '';
  return {
    id: raw.id,
    name: raw.name,
    url: raw.url,
    season: raw.season,
    ...(typeof raw.number === 'number' ? { number: raw.number } : {}),
    type: raw.type,
    airstamp: raw.airstamp,
    ...resolveAirTime(raw, timeZone),
    ...(typeof raw.runtime === 'number' ? { runtime_minutes: raw.runtime } : {}),
    ...(typeof raw.rating?.average === 'number' ? { rating: raw.rating.average } : {}),
    ...(raw.image?.original ? { image_url: raw.image.original } : {}),
    ...(summary ? { summary } : {}),
  };
}

/** Normalize a season header. */
export function normalizeSeason(raw: RawSeason): Season {
  const channel = raw.webChannel?.name ?? raw.network?.name;
  return {
    id: raw.id,
    number: raw.number,
    ...(raw.name ? { name: raw.name } : {}),
    ...(typeof raw.episodeOrder === 'number' ? { episode_order: raw.episodeOrder } : {}),
    ...(raw.premiereDate ? { premiere_date: raw.premiereDate } : {}),
    ...(raw.endDate ? { end_date: raw.endDate } : {}),
    ...(channel ? { channel } : {}),
  };
}

/** Normalize a cast row — `{ person, character, self, voice }`. */
export function normalizeCastCredit(raw: RawCastCredit): CastCredit {
  return {
    person_name: raw.person.name,
    person_url: raw.person.url,
    person_id: raw.person.id,
    ...(raw.character?.name ? { character_name: raw.character.name } : {}),
    ...(raw.character?.url ? { character_url: raw.character.url } : {}),
    ...(typeof raw.self === 'boolean' ? { as_self: raw.self } : {}),
    ...(typeof raw.voice === 'boolean' ? { voice_only: raw.voice } : {}),
    ...(raw.person.image?.original ? { person_image_url: raw.person.image.original } : {}),
  };
}

/** Normalize a crew row — `{ type, person }`, with no character, self, or voice. */
export function normalizeCrewCredit(raw: RawCrewCredit): CastCredit {
  return {
    person_name: raw.person.name,
    person_url: raw.person.url,
    person_id: raw.person.id,
    ...(raw.type ? { credit_type: raw.type } : {}),
    ...(raw.person.image?.original ? { person_image_url: raw.person.image.original } : {}),
  };
}

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

/**
 * Size-bounded TTL map keyed by full request URL. It lives in the service and
 * not in `ctx.state` on purpose: TVmaze responses are public and identical for
 * every tenant, and the point of caching them is to collapse identical bursts
 * onto one shared egress rate budget — a tenant-scoped store would hold N
 * copies and collapse nothing.
 */
class ResponseCache {
  private readonly entries = new Map<string, { value: unknown; expiresAt: number }>();

  constructor(
    private readonly ttlMs: number,
    private readonly maxEntries: number,
  ) {}

  get(key: string): { value: unknown } | undefined {
    if (this.ttlMs <= 0) return undefined;
    const hit = this.entries.get(key);
    if (!hit) return undefined;
    if (hit.expiresAt <= Date.now()) {
      this.entries.delete(key);
      return undefined;
    }
    // Re-insert so the Map's insertion order doubles as a recency list.
    this.entries.delete(key);
    this.entries.set(key, hit);
    return { value: hit.value };
  }

  set(key: string, value: unknown): void {
    if (this.ttlMs <= 0) return;
    if (this.entries.size >= this.maxEntries) {
      const oldest = this.entries.keys().next();
      if (!oldest.done) this.entries.delete(oldest.value);
    }
    this.entries.set(key, { value, expiresAt: Date.now() + this.ttlMs });
  }

  clear(): void {
    this.entries.clear();
  }
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

/**
 * Render an id that came out of an upstream document into a URL path segment.
 * A response body is a system edge, so the `number` the record type promises is
 * a claim, not a fact: a string there would otherwise be interpolated straight
 * into the next request's path, where `..` segments resolve against the base
 * URL and silently redirect the call to a different endpoint.
 */
function pathId(value: number, fieldName: string): string {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw serializationError(`TVmaze returned a record whose ${fieldName} is not an integer.`, {
      field: fieldName,
    });
  }
  return String(value);
}

/** How one upstream request should classify its failures. */
interface RequestOptions {
  /** Map an upstream 404 onto `null` instead of letting it surface as a thrown NotFound. */
  notFoundAsNull?: boolean;
  /** Log label for the retry ladder. */
  operation: string;
  /** Contract reason to stamp on an upstream outage, so the wire carries it. */
  unavailableReason?: string;
}

export class TvmazeService {
  private readonly baseUrl: string;
  private readonly userAgent: string;
  private readonly requestTimeoutMs: number;
  private readonly defaultTimezone: string;
  private readonly defaultCountry: string;
  private readonly cache: ResponseCache;
  private readonly pacer: Pacer;

  constructor(options: {
    baseUrl: string;
    userAgent: string;
    requestTimeoutMs: number;
    defaultTimezone: string;
    defaultCountry: string;
    cacheTtlS: number;
    maxConcurrency: number;
  }) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.userAgent = options.userAgent;
    this.requestTimeoutMs = options.requestTimeoutMs;
    this.defaultTimezone = options.defaultTimezone;
    this.defaultCountry = normalizeCountry(options.defaultCountry);
    this.cache = new ResponseCache(options.cacheTtlS * 1000, MAX_CACHE_ENTRIES);
    this.pacer = createPacer({
      name: 'tvmaze',
      // TVmaze documents "at least 20 calls every 10 seconds per IP"; 18 keeps headroom.
      limits: [{ requests: 18, perMs: 10_000 }],
      // A window alone would permit all 18 starts inside one millisecond.
      minStartGapMs: 50,
      maxConcurrent: options.maxConcurrency,
      maxQueueDepth: 64,
      // Closes the gate for every queued caller on a 429, honoring Retry-After.
      cooldown: { baseMs: 2_000, maxMs: 30_000 },
    });
  }

  /** Release the pacer's dispatch timer and reject anything still queued. */
  dispose(): void {
    this.pacer.dispose();
    this.cache.clear();
  }

  /** The IANA zone a tool call resolves to — the caller's, or the configured default. */
  resolveTimezone(requested: string | undefined, ctx: Context): string {
    return assertTimezone(requested?.trim() || this.defaultTimezone, ctx);
  }

  /** The ISO 3166-1 alpha-2 country a schedule call resolves to. */
  resolveCountry(requested: string | undefined): string {
    return requested?.trim() ? normalizeCountry(requested) : this.defaultCountry;
  }

  // -------------------------------------------------------------------------
  // Shows
  // -------------------------------------------------------------------------

  /** Fuzzy title search. The source hard-caps this at 10 rows and offers no paging. */
  async searchShows(query: string, ctx: Context): Promise<ShowSearchHit[]> {
    const rows = await this.fetchJson<RawSearchHit[]>(
      `/search/shows?q=${encodeURIComponent(query)}`,
      ctx,
      { operation: 'tvmaze.searchShows', unavailableReason: 'search_unavailable' },
    );
    return (rows ?? []).map((row) => ({ ...normalizeShow(row.show), match_score: row.score }));
  }

  /** Full profile for one TVmaze id, with the previous/next episode and season embeds. */
  async getShowDetail(
    showId: number,
    timeZone: string,
    ctx: Context,
    options: { seasons: boolean },
  ): Promise<ShowDetail | null> {
    const embeds = options.seasons
      ? 'embed[]=nextepisode&embed[]=previousepisode&embed[]=seasons'
      : 'embed[]=nextepisode&embed[]=previousepisode';
    const raw = await this.fetchJson<RawShow>(`/shows/${showId}?${embeds}`, ctx, {
      operation: 'tvmaze.getShow',
      notFoundAsNull: true,
    });
    return raw ? this.toShowDetail(raw, timeZone) : null;
  }

  /** Resolve a title to one best-match show, with the previous/next episode embeds. */
  async singleSearchShow(
    title: string,
    timeZone: string,
    ctx: Context,
  ): Promise<ShowDetail | null> {
    const raw = await this.fetchJson<RawShow>(
      `/singlesearch/shows?q=${encodeURIComponent(title)}&embed[]=nextepisode&embed[]=previousepisode`,
      ctx,
      { operation: 'tvmaze.singleSearchShow', notFoundAsNull: true },
    );
    return raw ? this.toShowDetail(raw, timeZone) : null;
  }

  /** Resolve an external catalog id. The endpoint answers 301; fetch follows it. */
  async lookupShow(
    source: LookupSource,
    externalId: string,
    ctx: Context,
  ): Promise<ShowSummary | null> {
    const raw = await this.fetchJson<RawShow>(
      `/lookup/shows?${source}=${encodeURIComponent(externalId)}`,
      ctx,
      {
        operation: 'tvmaze.lookupShow',
        notFoundAsNull: true,
        unavailableReason: 'lookup_unavailable',
      },
    );
    return raw ? normalizeShow(raw) : null;
  }

  // -------------------------------------------------------------------------
  // Episodes
  // -------------------------------------------------------------------------

  /**
   * A show's identity together with its season list, in one request. The
   * seasons embed is what maps a season *number* onto the season *id* the
   * episode route needs, and what names the seasons that do exist when the
   * requested one does not.
   */
  async getShowWithSeasons(
    showId: number,
    ctx: Context,
  ): Promise<{ show: ShowSummary; seasons: Season[] } | null> {
    const raw = await this.fetchJson<RawShow>(`/shows/${showId}?embed[]=seasons`, ctx, {
      operation: 'tvmaze.getShowWithSeasons',
      notFoundAsNull: true,
    });
    if (!raw) return null;
    return {
      show: normalizeShow(raw),
      seasons: (raw._embedded?.seasons ?? []).map(normalizeSeason),
    };
  }

  /**
   * One season's episodes. This route always includes specials and ignores
   * `?specials=1`, so the caller filters locally to keep one contract with the
   * whole-run route.
   */
  async getSeasonEpisodes(
    seasonId: number,
    timeZone: string,
    ctx: Context,
  ): Promise<Episode[] | null> {
    const rows = await this.fetchJson<RawEpisode[]>(
      `/seasons/${pathId(seasonId, 'season id')}/episodes`,
      ctx,
      { operation: 'tvmaze.getSeasonEpisodes', notFoundAsNull: true },
    );
    return rows ? rows.map((row) => normalizeEpisode(row, timeZone)) : null;
  }

  /** A show's whole run. Excludes specials unless `includeSpecials` is set. */
  async getShowEpisodes(
    showId: number,
    timeZone: string,
    ctx: Context,
    includeSpecials: boolean,
  ): Promise<Episode[] | null> {
    const path = includeSpecials
      ? `/shows/${showId}/episodes?specials=1`
      : `/shows/${showId}/episodes`;
    const rows = await this.fetchJson<RawEpisode[]>(path, ctx, {
      operation: 'tvmaze.getShowEpisodes',
      notFoundAsNull: true,
    });
    return rows ? rows.map((row) => normalizeEpisode(row, timeZone)) : null;
  }

  // -------------------------------------------------------------------------
  // Schedule
  // -------------------------------------------------------------------------

  /**
   * One schedule feed for one date. The linear and streaming feeds nest the
   * show differently — `entry.show` against `entry._embedded.show` — and this
   * is where the two collapse into one shape.
   */
  async getScheduleFeed(
    feed: ScheduleFeed,
    date: string,
    timeZone: string,
    ctx: Context,
  ): Promise<ScheduleEntry[]> {
    const path =
      feed.kind === 'linear'
        ? `/schedule?country=${encodeURIComponent(feed.country)}&date=${encodeURIComponent(date)}`
        : feed.kind === 'web'
          ? `/schedule/web?country=${encodeURIComponent(feed.country)}&date=${encodeURIComponent(date)}`
          : `/schedule/web?country=&date=${encodeURIComponent(date)}`;

    const rows = await this.fetchJson<RawEpisode[]>(path, ctx, {
      operation: `tvmaze.getSchedule.${feed.kind}`,
      unavailableReason: 'schedule_unavailable',
    });

    const label = feed.kind === 'linear' ? 'linear' : 'streaming';
    const entries: ScheduleEntry[] = [];
    for (const row of rows ?? []) {
      const show = row.show ?? row._embedded?.show;
      if (!show) continue;
      entries.push({
        ...normalizeEpisode(row, timeZone),
        show: normalizeShow(show),
        feed: label,
      });
    }
    return entries;
  }

  // -------------------------------------------------------------------------
  // Credits
  // -------------------------------------------------------------------------

  /** A show's main cast. `null` when the show does not exist. */
  async getShowCast(showId: number, ctx: Context): Promise<CastCredit[] | null> {
    const rows = await this.fetchJson<RawCastCredit[]>(`/shows/${showId}/cast`, ctx, {
      operation: 'tvmaze.getShowCast',
      notFoundAsNull: true,
    });
    return rows ? rows.map(normalizeCastCredit) : null;
  }

  /** A show's crew credits. `null` when the show does not exist. */
  async getShowCrew(showId: number, ctx: Context): Promise<CastCredit[] | null> {
    const rows = await this.fetchJson<RawCrewCredit[]>(`/shows/${showId}/crew`, ctx, {
      operation: 'tvmaze.getShowCrew',
      notFoundAsNull: true,
    });
    return rows ? rows.map(normalizeCrewCredit) : null;
  }

  /** One episode's guest cast. `null` when the episode does not exist. */
  async getEpisodeGuestCast(episodeId: number, ctx: Context): Promise<CastCredit[] | null> {
    const rows = await this.fetchJson<RawCastCredit[]>(`/episodes/${episodeId}/guestcast`, ctx, {
      operation: 'tvmaze.getEpisodeGuestCast',
      notFoundAsNull: true,
    });
    return rows ? rows.map(normalizeCastCredit) : null;
  }

  // -------------------------------------------------------------------------
  // HTTP
  // -------------------------------------------------------------------------

  private toShowDetail(raw: RawShow, timeZone: string): ShowDetail {
    const embedded = raw._embedded ?? {};
    return {
      show: normalizeShowProfile(raw),
      seasons: (embedded.seasons ?? []).map(normalizeSeason),
      ...(embedded.nextepisode
        ? { next_episode: normalizeEpisode(embedded.nextepisode, timeZone) }
        : {}),
      ...(embedded.previousepisode
        ? { previous_episode: normalizeEpisode(embedded.previousepisode, timeZone) }
        : {}),
    };
  }

  /**
   * GET one JSON document. Retry sits outside the pacer so every attempt
   * re-queues and is re-paced, and it wraps the parse as well as the fetch —
   * an HTML error page served with a 200 is then transient rather than a
   * serialization failure.
   */
  private async fetchJson<T>(
    path: string,
    ctx: Context,
    options: RequestOptions,
  ): Promise<T | null> {
    const url = `${this.baseUrl}${path}`;
    const cached = this.cache.get(url);
    if (cached) return cached.value as T | null;

    try {
      const value = await withRetry<T>(
        ({ signal, remainingMs }) =>
          this.pacer.run(
            async (paced) => {
              const response = await fetchWithTimeout(
                url,
                Math.min(this.requestTimeoutMs, remainingMs),
                ctx,
                {
                  signal: paced,
                  headers: { Accept: 'application/json', 'User-Agent': this.userAgent },
                  ...(options.notFoundAsNull ? { expectedStatuses: [404] } : {}),
                },
              );
              return (await response.json()) as T;
            },
            { signal },
          ),
        {
          operation: options.operation,
          context: ctx,
          signal: ctx.signal,
          // TVmaze asks a client to "back off for a few seconds" on a 429.
          baseDelayMs: 1_500,
          deadlineMs: this.requestTimeoutMs * 3,
        },
      );
      this.cache.set(url, value);
      return value;
    } catch (error) {
      return this.classifyFailure(error, ctx, options);
    }
  }

  /**
   * Turn an upstream failure into the shape the calling tool declared, or into
   * `null` for a miss. Returning `null` here is what keeps every `ctx.fail`
   * lexically inside a handler, which is the only place the error-contract
   * lints can see it.
   */
  private classifyFailure(error: unknown, ctx: Context, options: RequestOptions): null {
    if (error instanceof McpError) {
      const status = error.data?.status;
      if (status === 404 && options.notFoundAsNull) return null;
      if (status === 422) throw this.upstreamRejection(error, ctx);
      if (options.unavailableReason && TRANSIENT_CODES.has(error.code)) {
        throw serviceUnavailable(
          error.message,
          {
            reason: options.unavailableReason,
            retryable: true,
            ...ctx.recoveryFor(options.unavailableReason),
          },
          { cause: error },
        );
      }
      throw error;
    }

    if (options.unavailableReason) {
      throw serviceUnavailable(
        `TVmaze did not answer: ${error instanceof Error ? error.message : String(error)}`,
        {
          reason: options.unavailableReason,
          retryable: true,
          ...ctx.recoveryFor(options.unavailableReason),
        },
        { cause: error },
      );
    }
    throw error;
  }

  /**
   * TVmaze answers an unrecognized country or a non-calendar date with 422 and
   * a body naming which one. The rejection is re-thrown carrying the calling
   * tool's contract reason so the recovery hint reaches both client surfaces.
   */
  private upstreamRejection(error: McpError, ctx: Context): McpError {
    const body = typeof error.data?.body === 'string' ? error.data.body : '';
    if (/country/i.test(body)) {
      return validationError(
        'TVmaze rejected the country code — it is not an ISO 3166-1 country the source recognizes.',
        { reason: 'invalid_country', ...ctx.recoveryFor('invalid_country') },
        { cause: error },
      );
    }
    return validationError(
      'TVmaze rejected the date — it is not a real calendar date.',
      { reason: 'invalid_date', ...ctx.recoveryFor('invalid_date') },
      { cause: error },
    );
  }
}

// ---------------------------------------------------------------------------
// Init / accessor
// ---------------------------------------------------------------------------

let _service: TvmazeService | undefined;

/** Construct the singleton. Called from `createApp({ setup })`. */
export function initTvmazeService(): void {
  const serverConfig = getServerConfig();
  _service = new TvmazeService({
    baseUrl: serverConfig.baseUrl,
    userAgent:
      serverConfig.userAgent ??
      `tvmaze-mcp-server/${config.mcpServerVersion} (+https://github.com/cyanheads/tvmaze-mcp-server)`,
    requestTimeoutMs: serverConfig.requestTimeoutMs,
    defaultTimezone: serverConfig.defaultTimezone,
    defaultCountry: serverConfig.defaultCountry,
    cacheTtlS: serverConfig.cacheTtlS,
    maxConcurrency: serverConfig.maxConcurrency,
  });
}

/** Release the singleton's pacer. Called from `createApp({ teardown })`. */
export function disposeTvmazeService(): void {
  _service?.dispose();
  _service = undefined;
}

/** The initialized service. */
export function getTvmazeService(): TvmazeService {
  if (!_service) {
    throw new Error('TvmazeService not initialized — call initTvmazeService() in setup()');
  }
  return _service;
}
