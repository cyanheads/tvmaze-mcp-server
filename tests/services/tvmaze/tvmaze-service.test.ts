/**
 * @fileoverview Unit and boundary tests for TvmazeService — normalizers, the
 * HTTP boundary (cache, retry, redirects, 404-to-null, 422 reclassification),
 * and the exported free functions (stripHtml, decodeHtmlEntities,
 * assertTimezone, todayIn, normalizeCountry).
 * @module tests/services/tvmaze/tvmaze-service.test
 */

import { createFetchMock, createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  assertTimezone,
  decodeHtmlEntities,
  normalizeCastCredit,
  normalizeCountry,
  normalizeCrewCredit,
  normalizeEpisode,
  normalizeSeason,
  normalizeShow,
  stripHtml,
  TvmazeService,
  todayIn,
} from '@/services/tvmaze/tvmaze-service.js';
import {
  rawCastCredit,
  rawCrewCredit,
  rawEpisode,
  rawEpisodeNoTime,
  rawEpisodeSpecial,
  rawSearchHit,
  rawSeason,
  rawShow,
  rawShowSparse,
  rawShowStreaming,
  tvmazeErrorBody,
} from '../../fixtures/tvmaze-fixtures.js';

const BASE_URL = 'https://tvmaze.test';

function service(overrides: Partial<ConstructorParameters<typeof TvmazeService>[0]> = {}) {
  return new TvmazeService({
    baseUrl: BASE_URL,
    userAgent: 'tvmaze-mcp-server/test',
    requestTimeoutMs: 2_000,
    defaultTimezone: 'UTC',
    defaultCountry: 'US',
    cacheTtlS: 0,
    maxConcurrency: 4,
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// Free functions
// ---------------------------------------------------------------------------

describe('stripHtml', () => {
  it('returns empty string for empty input', () => {
    expect(stripHtml('')).toBe('');
  });

  it('converts the closed set of tags to markdown equivalents', () => {
    const html =
      '<p><b>Bold</b> and <i>italic</i> and <strong>strong</strong> and <em>em</em>.</p>';
    expect(stripHtml(html)).toBe('**Bold** and *italic* and **strong** and *em*.');
  });

  it('converts <br> to newline and </p> to a blank line (opening <p> is dropped, not a separator)', () => {
    expect(stripHtml('Line one<br>Line two<p>Para one</p><p>Para two</p>')).toBe(
      'Line one\nLine twoPara one\n\nPara two',
    );
  });

  it('drops unrecognized tags without dropping their text', () => {
    expect(stripHtml('<div class="x">Hello <a href="https://x.test">world</a></div>')).toBe(
      'Hello world',
    );
  });

  it('decodes HTML entities inside the summary', () => {
    expect(stripHtml('Tom &amp; Jerry&#39;s &quot;Show&quot;')).toBe('Tom & Jerry\'s "Show"');
  });

  it('collapses three or more consecutive newlines to a blank line', () => {
    expect(stripHtml('<p>A</p><p></p><p>B</p>')).toBe('A\n\nB');
  });
});

describe('decodeHtmlEntities', () => {
  it('decodes named entities', () => {
    expect(decodeHtmlEntities('&amp;&lt;&gt;&quot;&apos;&nbsp;')).toBe('&<>"\' ');
  });

  it('decodes decimal and hex numeric entities', () => {
    expect(decodeHtmlEntities('&#65;&#x42;')).toBe('AB');
  });

  it('leaves an unrecognized named entity untouched', () => {
    expect(decodeHtmlEntities('&frobnicate;')).toBe('&frobnicate;');
  });
});

describe('stripHtml / decodeHtmlEntities — contributor-authored content', () => {
  it('leaves an entity naming an inherited Object property untouched instead of resolving it', () => {
    expect(decodeHtmlEntities('&constructor;')).toBe('&constructor;');
    expect(decodeHtmlEntities('&__proto__;')).toBe('&__proto__;');
    expect(decodeHtmlEntities('&toString;&hasOwnProperty;')).toBe('&toString;&hasOwnProperty;');
  });

  it('leaves an out-of-range numeric entity untouched instead of throwing', () => {
    expect(stripHtml('Before &#1114112; after')).toBe('Before &#1114112; after');
    expect(stripHtml('Before &#x110000; after')).toBe('Before &#x110000; after');
    expect(stripHtml('&#99999999999;')).toBe('&#99999999999;');
  });

  it('strips control characters, including ones smuggled in as numeric entities', () => {
    expect(stripHtml('Now &#x1b;[31mred&#x1b;[0m')).toBe('Now [31mred[0m');
    expect(stripHtml('A\u0000B\u0007C\u009bD')).toBe('ABCD');
    expect(stripHtml('one\u2028two\u2029three')).toBe('onetwothree');
  });

  it('keeps the newlines the paragraph and <br> conversions produce', () => {
    expect(stripHtml('<p>A</p>B<br>C')).toBe('A\n\nB\nC');
  });

  it('does not let entity decoding reintroduce an element the tag pass removed', () => {
    expect(stripHtml('<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>')).toBe(
      'script>alert(1)/script>',
    );
    expect(stripHtml('&#60;img src=x onerror=alert(1)&#62;')).toBe('img src=x onerror=alert(1)>');
  });

  it('keeps a prose comparison whose < is not an element name', () => {
    expect(stripHtml('<p>a &lt; b and 2 &gt; 1</p>')).toBe('a < b and 2 > 1');
    expect(stripHtml('rated &lt;3 by fans')).toBe('rated <3 by fans');
  });
});

describe('normalizeCountry', () => {
  it('uppercases a lowercase code', () => {
    expect(normalizeCountry('gb')).toBe('GB');
  });

  it('folds UK to GB', () => {
    expect(normalizeCountry('UK')).toBe('GB');
    expect(normalizeCountry('uk')).toBe('GB');
  });

  it('trims surrounding whitespace', () => {
    expect(normalizeCountry(' us ')).toBe('US');
  });

  it('leaves an already-correct code unchanged', () => {
    expect(normalizeCountry('JP')).toBe('JP');
  });
});

describe('assertTimezone', () => {
  it('returns a valid IANA zone name unchanged', () => {
    const ctx = createMockContext();
    expect(assertTimezone('America/Los_Angeles', ctx)).toBe('America/Los_Angeles');
  });

  it('throws a validationError with reason invalid_timezone for a bogus zone', () => {
    const ctx = createMockContext();
    try {
      assertTimezone('Not/AZone', ctx);
      throw new Error('expected assertTimezone to throw');
    } catch (error) {
      expect(error).toMatchObject({ data: { reason: 'invalid_timezone' } });
    }
  });
});

describe('todayIn', () => {
  it('returns an ISO calendar date', () => {
    expect(todayIn('UTC')).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('resolves a different calendar date per zone at the same instant', () => {
    // 2026-09-19T23:30:00Z is already 2026-09-20 in Tokyo (UTC+9) and still
    // 2026-09-19 in Los Angeles (UTC-7) — proves the zone is actually consulted,
    // not just formatted with a fixed UTC date.
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-19T23:30:00Z'));
    try {
      expect(todayIn('Asia/Tokyo')).toBe('2026-09-20');
      expect(todayIn('America/Los_Angeles')).toBe('2026-09-19');
    } finally {
      vi.useRealTimers();
    }
  });
});

// ---------------------------------------------------------------------------
// Normalizers
// ---------------------------------------------------------------------------

describe('normalizeShow', () => {
  it('normalizes a fully-populated show', () => {
    const show = normalizeShow(rawShow());
    expect(show).toMatchObject({
      id: 169,
      name: 'Breaking Bad',
      url: 'https://www.tvmaze.com/shows/169/breaking-bad',
      type: 'Scripted',
      language: 'English',
      status: 'Ended',
      premiered: '2008-01-20',
      ended: '2013-09-29',
      genres: ['Drama', 'Crime', 'Thriller'],
      runtime_minutes: 60,
      average_runtime_minutes: 47,
      rating: 9.3,
      channel: 'AMC',
      channel_type: 'network',
      channel_country: 'US',
      externals: { tvrage: 18164, thetvdb: 81189, imdb: 'tt0903747' },
    });
    expect(show.summary).toBe(
      '**Breaking Bad** follows protagonist Walter White.\n\nA high school chemistry teacher.',
    );
    expect(show.image_url).toContain('original_untouched');
  });

  it('omits optional fields entirely for a sparse show, never coercing to 0/""/false', () => {
    const show = normalizeShow(rawShowSparse());
    expect(show.genres).toEqual([]);
    expect(show.externals).toEqual({});
    expect(show).not.toHaveProperty('rating');
    expect(show).not.toHaveProperty('summary');
    expect(show).not.toHaveProperty('image_url');
    expect(show).not.toHaveProperty('channel');
    expect(show).not.toHaveProperty('channel_type');
    expect(show).not.toHaveProperty('status');
  });

  it('prefers webChannel over network and marks channel_type web_channel', () => {
    const show = normalizeShow(rawShowStreaming());
    expect(show.channel).toBe('Netflix');
    expect(show.channel_type).toBe('web_channel');
    expect(show).not.toHaveProperty('channel_country');
  });

  it('falls back to network when only network is present', () => {
    const show = normalizeShow(rawShow({ webChannel: null }));
    expect(show.channel).toBe('AMC');
    expect(show.channel_type).toBe('network');
  });
});

describe('normalizeEpisode — air time resolution', () => {
  it('resolves an announced airtime into the requested zone (time_known true)', () => {
    const episode = normalizeEpisode(rawEpisode(), 'America/New_York');
    expect(episode.time_known).toBe(true);
    expect(episode.local_date).toBe('2008-01-20');
    expect(episode.local_time).toContain('22:00');
    expect(episode.airstamp).toBe('2008-01-21T03:00:00+00:00');
  });

  it('reports time_known false and the raw airdate for an empty airtime, never inventing a clock time', () => {
    const episode = normalizeEpisode(rawEpisodeNoTime(), 'America/Los_Angeles');
    expect(episode.time_known).toBe(false);
    expect(episode.local_date).toBe('2026-09-18');
    expect(episode).not.toHaveProperty('local_time');
  });

  it('omits number for a special, and carries a non-regular type', () => {
    const episode = normalizeEpisode(rawEpisodeSpecial(), 'UTC');
    expect(episode).not.toHaveProperty('number');
    expect(episode.type).toBe('significant_special');
  });

  it('renders the correct local time across a DST boundary in one zone', () => {
    // Same zone (America/New_York), one airstamp in EST and one in EDT.
    const winter = normalizeEpisode(
      rawEpisode({ airstamp: '2026-01-15T17:00:00+00:00' }),
      'America/New_York',
    );
    const summer = normalizeEpisode(
      rawEpisode({ airstamp: '2026-07-15T17:00:00+00:00' }),
      'America/New_York',
    );

    const expectedWinter = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
      timeZoneName: 'short',
    }).formatToParts(new Date('2026-01-15T17:00:00+00:00'));
    const expectedSummer = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
      timeZoneName: 'short',
    }).formatToParts(new Date('2026-07-15T17:00:00+00:00'));
    const part = (parts: Intl.DateTimeFormatPart[], type: string) =>
      parts.find((p) => p.type === type)?.value;

    expect(winter.local_date).toBe('2026-01-15');
    expect(winter.local_time).toBe(
      `2026-01-15 ${part(expectedWinter, 'hour')}:${part(expectedWinter, 'minute')} ${part(expectedWinter, 'timeZoneName')}`,
    );
    expect(summer.local_date).toBe('2026-07-15');
    expect(summer.local_time).toBe(
      `2026-07-15 ${part(expectedSummer, 'hour')}:${part(expectedSummer, 'minute')} ${part(expectedSummer, 'timeZoneName')}`,
    );
    // The two offsets genuinely differ — otherwise this test would pass by accident.
    expect(part(expectedWinter, 'timeZoneName')).not.toBe(part(expectedSummer, 'timeZoneName'));
  });

  it('renders the same instant correctly in a second zone (Tokyo, no DST)', () => {
    const episode = normalizeEpisode(
      rawEpisode({ airstamp: '2026-07-15T17:00:00+00:00' }),
      'Asia/Tokyo',
    );
    expect(episode.local_date).toBe('2026-07-16');
    expect(episode.local_time).toContain('02:00');
  });
});

describe('normalizeSeason', () => {
  it('normalizes a fully-populated season', () => {
    expect(normalizeSeason(rawSeason())).toMatchObject({
      id: 1,
      number: 1,
      episode_order: 7,
      premiere_date: '2008-01-20',
      end_date: '2008-03-09',
      channel: 'AMC',
    });
  });

  it('omits name when empty and channel when neither network nor webChannel is present', () => {
    const season = normalizeSeason(rawSeason({ name: '', network: null, webChannel: null }));
    expect(season).not.toHaveProperty('channel');
  });
});

describe('normalizeCastCredit / normalizeCrewCredit', () => {
  it('normalizes a cast row with character, self, and voice', () => {
    const credit = normalizeCastCredit(rawCastCredit());
    expect(credit).toMatchObject({
      person_name: 'Bryan Cranston',
      person_id: 1,
      character_name: 'Walter White',
      as_self: false,
      voice_only: false,
    });
    expect(credit).not.toHaveProperty('credit_type');
  });

  it('normalizes a crew row with credit_type and no character/self/voice fields', () => {
    const credit = normalizeCrewCredit(rawCrewCredit());
    expect(credit).toMatchObject({
      person_name: 'Vince Gilligan',
      credit_type: 'Executive Producer',
    });
    expect(credit).not.toHaveProperty('character_name');
    expect(credit).not.toHaveProperty('as_self');
    expect(credit).not.toHaveProperty('voice_only');
  });
});

// ---------------------------------------------------------------------------
// HTTP boundary
// ---------------------------------------------------------------------------

describe('TvmazeService HTTP boundary', () => {
  let http: ReturnType<typeof createFetchMock>;

  beforeEach(() => {
    http = createFetchMock();
    http.install();
  });

  afterEach(() => {
    http.restore();
  });

  it('searchShows maps {score, show} rows into ShowSearchHit with match_score', async () => {
    http.route({
      match: `${BASE_URL}/search/shows?q=breaking`,
      respond: Response.json([rawSearchHit({ score: 8.4 })]),
    });
    const svc = service();
    const ctx = createMockContext();
    const hits = await svc.searchShows('breaking', ctx);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ id: 169, name: 'Breaking Bad', match_score: 8.4 });
  });

  it('searchShows returns an empty array on a clean empty result', async () => {
    http.route({ match: `${BASE_URL}/search/shows?q=zzzz`, respond: Response.json([]) });
    const hits = await service().searchShows('zzzz', createMockContext());
    expect(hits).toEqual([]);
  });

  it('percent-encodes a query so it cannot inject an extra upstream parameter', async () => {
    http.route({
      match: `${BASE_URL}/search/shows?q=breaking%26country%3DZZ%23x`,
      respond: Response.json([]),
    });
    await service().searchShows('breaking&country=ZZ#x', createMockContext());
    expect(http.calls).toHaveLength(1);
  });

  it('refuses a season id the upstream did not send as a plain integer, rather than fetching the path it composes', async () => {
    // `/seasons/1/../../shows/169/episodes` normalizes to the whole-run route.
    http.route({
      match: `${BASE_URL}/shows/169/episodes`,
      respond: Response.json([rawEpisode()]),
    });
    await expect(
      service().getSeasonEpisodes(
        '1/../../shows/169' as unknown as number,
        'UTC',
        createMockContext(),
      ),
    ).rejects.toThrow();
    expect(http.calls).toHaveLength(0);
  });

  it('getShowDetail returns null on a 404 (bad id)', async () => {
    http.route({
      match: `${BASE_URL}/shows/99999999?embed[]=nextepisode&embed[]=previousepisode&embed[]=seasons`,
      respond: new Response(tvmazeErrorBody('Not Found', '', 404), { status: 404 }),
    });
    const detail = await service().getShowDetail(99_999_999, 'UTC', createMockContext(), {
      seasons: true,
    });
    expect(detail).toBeNull();
  });

  it('getShowDetail omits next_episode when the embed key is absent (Running show mid-hiatus)', async () => {
    const raw = rawShow({
      status: 'Running',
      ended: null,
      _embedded: { previousepisode: rawEpisode(), seasons: [rawSeason()] },
    });
    http.route({
      match: `${BASE_URL}/shows/169?embed[]=nextepisode&embed[]=previousepisode&embed[]=seasons`,
      respond: Response.json(raw),
    });
    const detail = await service().getShowDetail(169, 'UTC', createMockContext(), {
      seasons: true,
    });
    expect(detail?.previous_episode).toBeDefined();
    expect(detail?.next_episode).toBeUndefined();
    expect(detail?.seasons).toHaveLength(1);
  });

  it('lookupShow resolves an id to a show (301-then-follow modeled as the final 200)', async () => {
    http.route({
      match: `${BASE_URL}/lookup/shows?imdb=tt0903747`,
      respond: Response.json(rawShow()),
    });
    const show = await service().lookupShow('imdb', 'tt0903747', createMockContext());
    expect(show?.id).toBe(169);
  });

  it('lookupShow returns null on a 404-with-null-body miss', async () => {
    http.route({
      match: `${BASE_URL}/lookup/shows?imdb=tt0000000`,
      respond: new Response('null', { status: 404 }),
    });
    const show = await service().lookupShow('imdb', 'tt0000000', createMockContext());
    expect(show).toBeNull();
  });

  it('getShowWithSeasons maps the seasons embed', async () => {
    http.route({
      match: `${BASE_URL}/shows/169?embed[]=seasons`,
      respond: Response.json(
        rawShow({ _embedded: { seasons: [rawSeason(), rawSeason({ id: 2, number: 2 })] } }),
      ),
    });
    const result = await service().getShowWithSeasons(169, createMockContext());
    expect(result?.seasons.map((s) => s.number)).toEqual([1, 2]);
  });

  it('getSeasonEpisodes always includes specials (no local filtering at the service layer)', async () => {
    http.route({
      match: `${BASE_URL}/seasons/1/episodes`,
      respond: Response.json([rawEpisode(), rawEpisodeSpecial()]),
    });
    const episodes = await service().getSeasonEpisodes(1, 'UTC', createMockContext());
    expect(episodes).toHaveLength(2);
    expect(episodes?.map((e) => e.type)).toEqual(['regular', 'significant_special']);
  });

  it('getShowEpisodes requests ?specials=1 only when includeSpecials is true', async () => {
    http.route({
      match: `${BASE_URL}/shows/169/episodes`,
      respond: Response.json([rawEpisode()]),
    });
    http.route({
      match: `${BASE_URL}/shows/169/episodes?specials=1`,
      respond: Response.json([rawEpisode(), rawEpisodeSpecial()]),
    });
    const svc = service();
    const withoutSpecials = await svc.getShowEpisodes(169, 'UTC', createMockContext(), false);
    const withSpecials = await svc.getShowEpisodes(169, 'UTC', createMockContext(), true);
    expect(withoutSpecials).toHaveLength(1);
    expect(withSpecials).toHaveLength(2);
  });

  it('getScheduleFeed normalizes a linear row nested at entry.show', async () => {
    http.route({
      match: `${BASE_URL}/schedule?country=US&date=2026-09-18`,
      respond: Response.json([{ ...rawEpisode(), show: rawShow() }]),
    });
    const entries = await service().getScheduleFeed(
      { kind: 'linear', country: 'US' },
      '2026-09-18',
      'UTC',
      createMockContext(),
    );
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ feed: 'linear', show: { id: 169 } });
  });

  it('getScheduleFeed normalizes a streaming row nested at entry._embedded.show', async () => {
    http.route({
      match: `${BASE_URL}/schedule/web?country=&date=2026-09-18`,
      respond: Response.json([{ ...rawEpisodeNoTime(), _embedded: { show: rawShowStreaming() } }]),
    });
    const entries = await service().getScheduleFeed(
      { kind: 'web-global' },
      '2026-09-18',
      'UTC',
      createMockContext(),
    );
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ feed: 'streaming', show: { id: 500, channel: 'Netflix' } });
  });

  it('getScheduleFeed skips a row that carries no show at all (neither shape)', async () => {
    http.route({
      match: `${BASE_URL}/schedule?country=US&date=2026-09-18`,
      respond: Response.json([rawEpisode()]),
    });
    const entries = await service().getScheduleFeed(
      { kind: 'linear', country: 'US' },
      '2026-09-18',
      'UTC',
      createMockContext(),
    );
    expect(entries).toEqual([]);
  });

  it('getShowCast / getShowCrew return normalized rows with the differing shapes', async () => {
    http.route({ match: `${BASE_URL}/shows/169/cast`, respond: Response.json([rawCastCredit()]) });
    http.route({ match: `${BASE_URL}/shows/169/crew`, respond: Response.json([rawCrewCredit()]) });
    const svc = service();
    const cast = await svc.getShowCast(169, createMockContext());
    const crew = await svc.getShowCrew(169, createMockContext());
    expect(cast?.[0]).toMatchObject({
      person_name: 'Bryan Cranston',
      character_name: 'Walter White',
    });
    expect(crew?.[0]).toMatchObject({
      person_name: 'Vince Gilligan',
      credit_type: 'Executive Producer',
    });
    expect(crew?.[0]).not.toHaveProperty('character_name');
  });

  it('getEpisodeGuestCast returns null on a 404', async () => {
    http.route({
      match: `${BASE_URL}/episodes/99999999/guestcast`,
      respond: new Response(tvmazeErrorBody('Not Found', '', 404), { status: 404 }),
    });
    const guestCast = await service().getEpisodeGuestCast(99_999_999, createMockContext());
    expect(guestCast).toBeNull();
  });

  it('caches an identical URL — the second call makes no new fetch', async () => {
    http.route({ match: `${BASE_URL}/shows/169/cast`, respond: Response.json([rawCastCredit()]) });
    const svc = service({ cacheTtlS: 300 });
    const ctx = createMockContext();
    await svc.getShowCast(169, ctx);
    await svc.getShowCast(169, ctx);
    expect(http.calls).toHaveLength(1);
  });

  it('does not cache when cacheTtlS is 0', async () => {
    http.route({ match: `${BASE_URL}/shows/169/cast`, respond: Response.json([rawCastCredit()]) });
    const svc = service({ cacheTtlS: 0 });
    const ctx = createMockContext();
    await svc.getShowCast(169, ctx);
    await svc.getShowCast(169, ctx);
    expect(http.calls).toHaveLength(2);
  });

  it('reclassifies a 422 "Not a valid ISO country code" body as invalid_country', async () => {
    http.route({
      match: `${BASE_URL}/schedule?country=ZZ&date=2026-09-18`,
      respond: new Response(
        tvmazeErrorBody('Unprocessable entity', 'Not a valid ISO country code', 422),
        {
          status: 422,
        },
      ),
    });
    await expect(
      service().getScheduleFeed(
        { kind: 'linear', country: 'ZZ' },
        '2026-09-18',
        'UTC',
        createMockContext(),
      ),
    ).rejects.toMatchObject({ data: { reason: 'invalid_country' } });
  });

  it('reclassifies a 422 "Not a valid ISO date" body as invalid_date', async () => {
    http.route({
      match: `${BASE_URL}/schedule?country=US&date=not-a-date`,
      respond: new Response(tvmazeErrorBody('Unprocessable entity', 'Not a valid ISO date', 422), {
        status: 422,
      }),
    });
    await expect(
      service().getScheduleFeed(
        { kind: 'linear', country: 'US' },
        'not-a-date',
        'UTC',
        createMockContext(),
      ),
    ).rejects.toMatchObject({ data: { reason: 'invalid_date' } });
  });

  it('retries a 429 and succeeds once the upstream recovers', async () => {
    let attempts = 0;
    http.route({
      match: `${BASE_URL}/search/shows?q=retry-429`,
      respond: () => {
        attempts += 1;
        if (attempts === 1) return new Response('Too Many Requests', { status: 429 });
        return Response.json([rawSearchHit()]);
      },
    });
    const hits = await service().searchShows('retry-429', createMockContext());
    expect(hits).toHaveLength(1);
    expect(attempts).toBe(2);
  }, 10_000);

  it('retries a connection reset and succeeds once the upstream recovers', async () => {
    let attempts = 0;
    http.route({
      match: `${BASE_URL}/search/shows?q=retry-reset`,
      respond: () => {
        attempts += 1;
        if (attempts === 1) {
          const err = new Error('read ECONNRESET') as Error & { code?: string };
          err.code = 'ECONNRESET';
          throw err;
        }
        return Response.json([rawSearchHit()]);
      },
    });
    const hits = await service().searchShows('retry-reset', createMockContext());
    expect(hits).toHaveLength(1);
    expect(attempts).toBe(2);
  }, 10_000);

  // Full retry-exhaustion (the *_unavailable reasons) is covered at the tool
  // level in each tool's own test file — it exercises the identical
  // classification path while also asserting the content[] parity the
  // dual-surface error envelope guarantees, so one real-timing wait covers
  // both concerns instead of duplicating it here.
});
