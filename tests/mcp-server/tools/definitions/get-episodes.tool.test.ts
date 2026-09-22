/**
 * @fileoverview Tests for tvmaze_get_episodes — the season, whole-run, and
 * air-date arms, the local specials filter and its omitted count on each,
 * pagination boundaries (limit, cursor, cursor past the end), zero-hit
 * notices, and the show_not_found / season_not_found / invalid_date /
 * invalid_timezone error contract.
 * @module tests/mcp-server/tools/definitions/get-episodes.tool.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { encodeCursor } from '@cyanheads/mcp-ts-core/utils';
import { describe, expect, it } from 'vitest';

import { getEpisodes } from '@/mcp-server/tools/definitions/get-episodes.tool.js';
import {
  rawEpisode,
  rawEpisodeSpecial,
  rawSeason,
  rawShow,
  tvmazeErrorBody,
} from '../../../fixtures/tvmaze-fixtures.js';
import { errorEnvelope } from '../../../helpers/error-envelope.js';
import {
  installTvmazeToolHarness,
  TVMAZE_TEST_BASE_URL,
} from '../../../helpers/tvmaze-tool-harness.js';

const getHttp = installTvmazeToolHarness();

/** The whole-run route, which always asks for specials and filters them locally. */
const WHOLE_RUN_URL = `${TVMAZE_TEST_BASE_URL}/shows/169/episodes?specials=1`;

describe('tvmaze_get_episodes', () => {
  it('lists one season, excluding specials by default and noting how many were dropped', async () => {
    getHttp().route({
      match: `${TVMAZE_TEST_BASE_URL}/shows/169?embed[]=seasons`,
      respond: Response.json(rawShow({ _embedded: { seasons: [rawSeason()] } })),
    });
    getHttp().route({
      match: `${TVMAZE_TEST_BASE_URL}/seasons/1/episodes`,
      respond: Response.json([
        rawEpisode({ id: 1, number: 1 }),
        rawEpisode({ id: 2, number: 2 }),
        rawEpisodeSpecial({ id: 3 }),
      ]),
    });

    const result = await runToolContract(getEpisodes, { show_id: 169, season: 1 });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      episodes: [{ id: 1 }, { id: 2 }],
      season: 1,
      has_more: false,
      totalCount: 2,
      notice: expect.stringContaining('1 special(s) in this season were omitted'),
    });
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain('# Breaking Bad — Season 1');
    // The episode guide keeps the full show profile — only schedule rows are compact.
    expect(result.structuredContent).toMatchObject({
      show: {
        externals: { imdb: 'tt0903747' },
        summary: expect.stringContaining('Walter White'),
        premiered: '2008-01-20',
      },
    });
  });

  it('includes specials on the season route when include_specials is set', async () => {
    getHttp().route({
      match: `${TVMAZE_TEST_BASE_URL}/shows/169?embed[]=seasons`,
      respond: Response.json(rawShow({ _embedded: { seasons: [rawSeason()] } })),
    });
    getHttp().route({
      match: `${TVMAZE_TEST_BASE_URL}/seasons/1/episodes`,
      respond: Response.json([rawEpisode({ id: 1 }), rawEpisodeSpecial({ id: 3 })]),
    });

    const result = await runToolContract(getEpisodes, {
      show_id: 169,
      season: 1,
      include_specials: true,
    });
    expect(result.structuredContent).toMatchObject({ episodes: [{ id: 1 }, { id: 3 }] });
    expect(result.structuredContent).not.toHaveProperty('notice');
  });

  it('walks the whole run when season is omitted', async () => {
    getHttp().route({
      match: `${TVMAZE_TEST_BASE_URL}/shows/169?embed[]=seasons`,
      respond: Response.json(rawShow({ _embedded: { seasons: [rawSeason()] } })),
    });
    getHttp().route({
      match: WHOLE_RUN_URL,
      respond: Response.json([rawEpisode({ id: 1 }), rawEpisode({ id: 2 })]),
    });

    const result = await runToolContract(getEpisodes, { show_id: 169 });
    expect(result.structuredContent).toMatchObject({ episodes: [{ id: 1 }, { id: 2 }] });
    expect(result.structuredContent).not.toHaveProperty('season');
    expect(result.structuredContent).not.toHaveProperty('notice');
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain('— all episodes');
  });

  describe('specials on the whole run', () => {
    /** Three regular episodes with two specials between them, as the ?specials=1 route orders them. */
    function routeRunWithSpecials() {
      getHttp().route({
        match: `${TVMAZE_TEST_BASE_URL}/shows/169?embed[]=seasons`,
        respond: Response.json(rawShow({ _embedded: { seasons: [rawSeason()] } })),
      });
      getHttp().route({
        match: WHOLE_RUN_URL,
        respond: () =>
          Response.json([
            rawEpisode({ id: 1, number: 1 }),
            rawEpisodeSpecial({ id: 100 }),
            rawEpisode({ id: 2, number: 2 }),
            rawEpisodeSpecial({ id: 101, type: 'insignificant_special' }),
            rawEpisode({ id: 3, number: 3 }),
          ]),
      });
    }
    const episodeUrls = () =>
      getHttp()
        .calls.map((call) => call.request.url)
        .filter((url) => url.includes('/episodes'));

    it('filters specials out locally and reports the whole-run count on both surfaces', async () => {
      routeRunWithSpecials();
      const result = await runToolContract(getEpisodes, { show_id: 169 });
      expect(result.isError).toBeFalsy();
      expect(result.structuredContent).toMatchObject({
        episodes: [{ id: 1 }, { id: 2 }, { id: 3 }],
        totalCount: 3,
        has_more: false,
      });
      const notice = (result.structuredContent as { notice: string }).notice;
      expect(notice).toBe(
        '2 special(s) across the whole run were omitted. Call again with include_specials true to include them.',
      );
      expect(notice).not.toContain('in this season');
      const text = result.content.map((block) => (block as { text: string }).text).join('\n');
      expect(text).toContain('2 special(s) across the whole run were omitted');
      expect(episodeUrls()).toEqual([WHOLE_RUN_URL]);
    });

    it('returns every row and no specials notice with include_specials, from the same URL', async () => {
      routeRunWithSpecials();
      const result = await runToolContract(getEpisodes, { show_id: 169, include_specials: true });
      expect(result.structuredContent).toMatchObject({
        episodes: [{ id: 1 }, { id: 100 }, { id: 2 }, { id: 101 }, { id: 3 }],
        totalCount: 5,
      });
      expect(result.structuredContent).not.toHaveProperty('notice');
      expect(episodeUrls()).toEqual([WHOLE_RUN_URL]);
    });

    it('keeps the specials count beside the truncation guidance on a truncated page, and alone on the last page', async () => {
      routeRunWithSpecials();
      const page1 = await runToolContract(getEpisodes, { show_id: 169, limit: 2 });
      expect(page1.structuredContent).toMatchObject({
        episodes: [{ id: 1 }, { id: 2 }],
        truncated: true,
        shown: 2,
        cap: 2,
        totalCount: 3,
      });
      const notice1 = (page1.structuredContent as { notice: string }).notice;
      expect(notice1).toContain('Showing episodes 1–2 of 3.');
      expect(notice1).toContain('2 special(s) across the whole run were omitted');

      const page2 = await runToolContract(getEpisodes, {
        show_id: 169,
        limit: 2,
        cursor: (page1.structuredContent as { next_cursor: string }).next_cursor,
      });
      expect(page2.structuredContent).toMatchObject({ episodes: [{ id: 3 }], has_more: false });
      expect(page2.structuredContent).not.toHaveProperty('truncated');
      expect((page2.structuredContent as { notice: string }).notice).toBe(
        '2 special(s) across the whole run were omitted. Call again with include_specials true to include them.',
      );
    });

    it('reports a run of nothing but specials as the specials count, not as an empty show', async () => {
      getHttp().route({
        match: `${TVMAZE_TEST_BASE_URL}/shows/169?embed[]=seasons`,
        respond: Response.json(rawShow({ _embedded: { seasons: [rawSeason()] } })),
      });
      getHttp().route({
        match: WHOLE_RUN_URL,
        respond: Response.json([rawEpisodeSpecial({ id: 100 })]),
      });
      const result = await runToolContract(getEpisodes, { show_id: 169 });
      expect(result.structuredContent).toMatchObject({ episodes: [], totalCount: 0 });
      const notice = (result.structuredContent as { notice: string }).notice;
      expect(notice).toContain('1 special(s) across the whole run were omitted');
      expect(notice).not.toContain('has no episodes recorded');
    });

    it('still reports a show with nothing recorded as empty', async () => {
      getHttp().route({
        match: `${TVMAZE_TEST_BASE_URL}/shows/169?embed[]=seasons`,
        respond: Response.json(rawShow({ _embedded: { seasons: [] } })),
      });
      getHttp().route({ match: WHOLE_RUN_URL, respond: Response.json([]) });
      const result = await runToolContract(getEpisodes, { show_id: 169 });
      expect((result.structuredContent as { notice: string }).notice).toBe(
        'Breaking Bad has no episodes recorded yet. Call tvmaze_get_show to check its status and announced seasons.',
      );
    });
  });

  it('emits a zero-hit notice for a season with no episodes recorded', async () => {
    getHttp().route({
      match: `${TVMAZE_TEST_BASE_URL}/shows/169?embed[]=seasons`,
      respond: Response.json(rawShow({ _embedded: { seasons: [rawSeason({ number: 3 })] } })),
    });
    getHttp().route({
      match: `${TVMAZE_TEST_BASE_URL}/seasons/1/episodes`,
      respond: Response.json([]),
    });

    const result = await runToolContract(getEpisodes, { show_id: 169, season: 3 });
    expect(result.structuredContent).toMatchObject({
      episodes: [],
      notice: expect.stringContaining('Season 3 of Breaking Bad has no episodes recorded'),
    });
  });

  it('paginates with limit and follows next_cursor to the next page', async () => {
    getHttp().route({
      match: `${TVMAZE_TEST_BASE_URL}/shows/169?embed[]=seasons`,
      respond: Response.json(rawShow({ _embedded: { seasons: [rawSeason()] } })),
    });
    getHttp().route({
      match: WHOLE_RUN_URL,
      respond: Response.json([
        rawEpisode({ id: 1, number: 1 }),
        rawEpisode({ id: 2, number: 2 }),
        rawEpisode({ id: 3, number: 3 }),
      ]),
    });

    const page1 = await runToolContract(getEpisodes, { show_id: 169, limit: 2 });
    expect(page1.structuredContent).toMatchObject({
      has_more: true,
      truncated: true,
      shown: 2,
      cap: 2,
    });
    const cursor = (page1.structuredContent as { next_cursor: string }).next_cursor;
    expect(typeof cursor).toBe('string');

    const page2 = await runToolContract(getEpisodes, { show_id: 169, limit: 2, cursor });
    expect(page2.structuredContent).toMatchObject({ episodes: [{ id: 3 }], has_more: false });
    expect(page2.structuredContent).not.toHaveProperty('next_cursor');
  });

  describe('page size on a cursor call', () => {
    /** A whole run of `count` regular episodes, ids 1..count in airing order. */
    function routeRun(count: number) {
      getHttp().route({
        match: `${TVMAZE_TEST_BASE_URL}/shows/169?embed[]=seasons`,
        respond: Response.json(rawShow({ _embedded: { seasons: [rawSeason()] } })),
      });
      getHttp().route({
        match: WHOLE_RUN_URL,
        respond: () =>
          Response.json(
            Array.from({ length: count }, (_, index) =>
              rawEpisode({ id: index + 1, number: index + 1 }),
            ),
          ),
      });
    }
    const ids = (result: { structuredContent?: unknown }) =>
      (result.structuredContent as { episodes: Array<{ id: number }> }).episodes.map((e) => e.id);
    const cursorOf = (result: { structuredContent?: unknown }) =>
      (result.structuredContent as { next_cursor: string }).next_cursor;

    it('takes the page size from the current limit, not the one frozen into the cursor', async () => {
      routeRun(20);
      const page1 = await runToolContract(getEpisodes, { show_id: 169, limit: 2 });
      expect(ids(page1)).toEqual([1, 2]);

      const page2 = await runToolContract(getEpisodes, {
        show_id: 169,
        limit: 5,
        cursor: cursorOf(page1),
      });
      expect(ids(page2)).toEqual([3, 4, 5, 6, 7]);
      expect(page2.structuredContent).toMatchObject({
        has_more: true,
        truncated: true,
        shown: 5,
        cap: 5,
        totalCount: 20,
      });

      const page3 = await runToolContract(getEpisodes, {
        show_id: 169,
        limit: 5,
        cursor: cursorOf(page2),
      });
      expect(ids(page3)[0]).toBe(8);
    });

    it('applies the default limit of 50 on a cursor call that omits limit, and reports cap 50', async () => {
      routeRun(120);
      const page1 = await runToolContract(getEpisodes, { show_id: 169, limit: 2 });
      const page2 = await runToolContract(getEpisodes, { show_id: 169, cursor: cursorOf(page1) });
      expect(ids(page2)).toEqual(Array.from({ length: 50 }, (_, index) => index + 3));
      expect(page2.structuredContent).toMatchObject({ shown: 50, cap: 50, has_more: true });
    });

    it('walks the whole run contiguously across pages of varying size — page1 ⧺ page2 ⧺ page3 is the full run', async () => {
      routeRun(12);
      const page1 = await runToolContract(getEpisodes, { show_id: 169, limit: 4 });
      const page2 = await runToolContract(getEpisodes, {
        show_id: 169,
        limit: 3,
        cursor: cursorOf(page1),
      });
      const page3 = await runToolContract(getEpisodes, {
        show_id: 169,
        limit: 250,
        cursor: cursorOf(page2),
      });
      expect([...ids(page1), ...ids(page2), ...ids(page3)]).toEqual(
        Array.from({ length: 12 }, (_, index) => index + 1),
      );
      expect(page3.structuredContent).toMatchObject({ has_more: false });
      expect(page3.structuredContent).not.toHaveProperty('next_cursor');
      expect(page3.structuredContent).not.toHaveProperty('truncated');
    });

    it('accepts a cursor encoded as { offset, limit } by the previous release and resumes at its offset', async () => {
      routeRun(20);
      const legacy = encodeCursor({ offset: 6, limit: 2 });
      const result = await runToolContract(getEpisodes, { show_id: 169, limit: 3, cursor: legacy });
      expect(ids(result)).toEqual([7, 8, 9]);
      expect(result.structuredContent).toMatchObject({ shown: 3, cap: 3 });
    });

    it('rejects a malformed cursor', async () => {
      routeRun(3);
      const result = await runToolContract(getEpisodes, { show_id: 169, cursor: 'not-a-cursor' });
      expect(result.isError).toBe(true);
    });
  });

  it('carries both the truncation guidance and the specials count when a season page is truncated', async () => {
    getHttp().route({
      match: `${TVMAZE_TEST_BASE_URL}/shows/169?embed[]=seasons`,
      respond: Response.json(rawShow({ _embedded: { seasons: [rawSeason()] } })),
    });
    getHttp().route({
      match: `${TVMAZE_TEST_BASE_URL}/seasons/1/episodes`,
      respond: Response.json([
        ...Array.from({ length: 8 }, (_, index) =>
          rawEpisode({ id: index + 1, number: index + 1 }),
        ),
        rawEpisodeSpecial({ id: 100 }),
        rawEpisodeSpecial({ id: 101 }),
      ]),
    });

    const result = await runToolContract(getEpisodes, { show_id: 169, season: 1, limit: 5 });
    expect(result.structuredContent).toMatchObject({ truncated: true, shown: 5, cap: 5 });
    const notice = (result.structuredContent as { notice: string }).notice;
    expect(notice).toContain('next_cursor');
    expect(notice).toContain('2 special(s) in this season were omitted');
    const text = result.content.map((block) => (block as { text: string }).text).join('\n');
    expect(text).toContain('next_cursor');
    expect(text).toContain('2 special(s) in this season were omitted');
  });

  it('returns an empty page for a cursor whose offset is past the end', async () => {
    getHttp().route({
      match: `${TVMAZE_TEST_BASE_URL}/shows/169?embed[]=seasons`,
      respond: Response.json(rawShow({ _embedded: { seasons: [rawSeason()] } })),
    });
    getHttp().route({
      match: WHOLE_RUN_URL,
      respond: Response.json([rawEpisode({ id: 1 })]),
    });

    const pastEnd = encodeCursor({ offset: 500, limit: 50 });
    const result = await runToolContract(getEpisodes, { show_id: 169, cursor: pastEnd });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({ episodes: [], has_more: false });
  });

  it('produces show_not_found on both surfaces for a bad id', async () => {
    // The whole-run branch fires getShowWithSeasons and getShowEpisodes in
    // parallel (Promise.all) — both routes must resolve or the unmocked one
    // retries as a generic (assumed-transient) fetch failure.
    getHttp().route({
      match: `${TVMAZE_TEST_BASE_URL}/shows/99999999?embed[]=seasons`,
      respond: new Response(tvmazeErrorBody('Not Found', '', 404), { status: 404 }),
    });
    getHttp().route({
      match: `${TVMAZE_TEST_BASE_URL}/shows/99999999/episodes?specials=1`,
      respond: new Response(tvmazeErrorBody('Not Found', '', 404), { status: 404 }),
    });

    const result = await runToolContract(getEpisodes, { show_id: 99_999_999 });
    expect(result.isError).toBe(true);
    expect(errorEnvelope(result.structuredContent).error).toMatchObject({
      data: { reason: 'show_not_found' },
    });
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain('reason show_not_found');
  });

  it('produces season_not_found and interpolates the seasons that do exist', async () => {
    getHttp().route({
      match: `${TVMAZE_TEST_BASE_URL}/shows/169?embed[]=seasons`,
      respond: Response.json(
        rawShow({
          _embedded: { seasons: [rawSeason({ number: 1 }), rawSeason({ id: 2, number: 2 })] },
        }),
      ),
    });

    const result = await runToolContract(getEpisodes, { show_id: 169, season: 12 });
    expect(result.isError).toBe(true);
    expect(errorEnvelope(result.structuredContent).error).toMatchObject({
      data: { reason: 'season_not_found' },
    });
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain('reason season_not_found');
    expect(errorEnvelope(result.structuredContent).error).toMatchObject({
      message: expect.stringContaining('Available seasons: 1-2'),
    });
  });

  it('fails loudly on a season id the upstream did not send as an integer, without fetching the path it composes', async () => {
    getHttp().route({
      match: `${TVMAZE_TEST_BASE_URL}/shows/169?embed[]=seasons`,
      respond: Response.json(
        rawShow({
          _embedded: {
            seasons: [rawSeason({ id: '1/../../shows/169' as unknown as number, number: 1 })],
          },
        }),
      ),
    });
    // `/seasons/1/../../shows/169/episodes` normalizes onto the whole-run route.
    getHttp().route({
      match: `${TVMAZE_TEST_BASE_URL}/shows/169/episodes`,
      respond: Response.json([rawEpisode({ id: 4242, name: 'Traversed' })]),
    });

    const result = await runToolContract(getEpisodes, { show_id: 169, season: 1 });
    expect(result.isError).toBe(true);
    expect(errorEnvelope(result.structuredContent).error).toBeDefined();
    expect((result.content[0] as { text: string }).text).not.toContain('Traversed');
    expect(getHttp().calls.map((call) => call.request.url)).not.toContain(
      `${TVMAZE_TEST_BASE_URL}/shows/169/episodes`,
    );
  });

  describe('air_date', () => {
    const PROFILE_URL = `${TVMAZE_TEST_BASE_URL}/shows/2756?embed[]=seasons`;
    const byDateUrl = (date: string) =>
      `${TVMAZE_TEST_BASE_URL}/shows/2756/episodesbydate?date=${date}`;
    const notFound = () => new Response(tvmazeErrorBody('Not Found', '', 404), { status: 404 });

    /** A daily show whose 23:35 Eastern slot carries the previous programming day's airdate. */
    function routeProfile() {
      getHttp().route({
        match: PROFILE_URL,
        respond: Response.json(
          rawShow({
            id: 2756,
            name: 'The Late Show with Stephen Colbert',
            _embedded: { seasons: [rawSeason({ id: 9000, number: 2025 })] },
          }),
        ),
      });
    }
    const lateShowEpisode = (overrides: Parameters<typeof rawEpisode>[0] = {}) =>
      rawEpisode({
        id: 3_166_429,
        name: 'Michael Fassbender, Uzo Aduba, The Voidz',
        season: 2025,
        number: 36,
        airdate: '2025-03-12',
        airtime: '23:35',
        airstamp: '2025-03-13T03:35:00+00:00',
        ...overrides,
      });

    it('lists the episodes the source dates to that day and echoes air_date on both surfaces', async () => {
      routeProfile();
      getHttp().route({
        match: byDateUrl('2025-03-12'),
        respond: Response.json([lateShowEpisode()]),
      });

      const result = await runToolContract(getEpisodes, { show_id: 2756, air_date: '2025-03-12' });
      expect(result.isError).toBeFalsy();
      expect(result.structuredContent).toMatchObject({
        episodes: [{ id: 3_166_429, local_date: '2025-03-13', time_known: true }],
        air_date: '2025-03-12',
        has_more: false,
        totalCount: 1,
      });
      expect(result.structuredContent).not.toHaveProperty('season');
      expect(result.structuredContent).not.toHaveProperty('notice');
      const text = (result.content[0] as { text: string }).text;
      expect(text).toContain('# The Late Show with Stephen Colbert — air date 2025-03-12');
      expect(text).toContain('**air_date:** 2025-03-12');
      expect(getHttp().calls.map((call) => call.request.url)).toContain(byDateUrl('2025-03-12'));
    });

    it('returns every episode released that day, paged like the other arms', async () => {
      routeProfile();
      getHttp().route({
        match: byDateUrl('2022-02-18'),
        respond: () =>
          Response.json([
            lateShowEpisode({ id: 1, number: 1, airdate: '2022-02-18' }),
            lateShowEpisode({ id: 2, number: 2, airdate: '2022-02-18' }),
          ]),
      });

      const both = await runToolContract(getEpisodes, { show_id: 2756, air_date: '2022-02-18' });
      expect(both.structuredContent).toMatchObject({ episodes: [{ id: 1 }, { id: 2 }] });

      const page1 = await runToolContract(getEpisodes, {
        show_id: 2756,
        air_date: '2022-02-18',
        limit: 1,
      });
      expect(page1.structuredContent).toMatchObject({
        episodes: [{ id: 1 }],
        truncated: true,
        air_date: '2022-02-18',
      });
      const page2 = await runToolContract(getEpisodes, {
        show_id: 2756,
        air_date: '2022-02-18',
        limit: 1,
        cursor: (page1.structuredContent as { next_cursor: string }).next_cursor,
      });
      expect(page2.structuredContent).toMatchObject({ episodes: [{ id: 2 }], has_more: false });
    });

    it('answers a date with nothing on it as an empty list with a notice naming the date', async () => {
      routeProfile();
      getHttp().route({ match: byDateUrl('2025-03-15'), respond: notFound });

      const result = await runToolContract(getEpisodes, { show_id: 2756, air_date: '2025-03-15' });
      expect(result.isError).toBeFalsy();
      expect(result.structuredContent).toMatchObject({
        episodes: [],
        air_date: '2025-03-15',
        totalCount: 0,
      });
      const notice = (result.structuredContent as { notice: string }).notice;
      expect(notice).toContain('2025-03-15');
      expect(notice).toContain('The Late Show with Stephen Colbert');
      const text = result.content.map((block) => (block as { text: string }).text).join('\n');
      expect(text).toContain(notice);
    });

    it('reads show_not_found from the show profile, since the date route 404s the same way for a bad show', async () => {
      getHttp().route({
        match: `${TVMAZE_TEST_BASE_URL}/shows/99999999?embed[]=seasons`,
        respond: notFound,
      });
      getHttp().route({
        match: `${TVMAZE_TEST_BASE_URL}/shows/99999999/episodesbydate?date=2025-03-12`,
        respond: notFound,
      });

      const result = await runToolContract(getEpisodes, {
        show_id: 99_999_999,
        air_date: '2025-03-12',
      });
      expect(result.isError).toBe(true);
      expect(errorEnvelope(result.structuredContent).error).toMatchObject({
        data: { reason: 'show_not_found' },
      });
    });

    it('surfaces the source rejecting a non-calendar date as invalid_date with its recovery hint', async () => {
      routeProfile();
      getHttp().route({
        match: byDateUrl('2025-02-30'),
        respond: new Response(
          tvmazeErrorBody('Unprocessable entity', 'Not a valid ISO date', 422),
          { status: 422 },
        ),
      });

      const result = await runToolContract(getEpisodes, { show_id: 2756, air_date: '2025-02-30' });
      expect(result.isError).toBe(true);
      const error = errorEnvelope(result.structuredContent).error;
      const declared = getEpisodes.errors?.find((entry) => entry.reason === 'invalid_date');
      expect(declared).toBeDefined();
      expect(error).toMatchObject({
        data: { reason: 'invalid_date', recovery: { hint: declared?.recovery } },
      });
      const text = (result.content[0] as { text: string }).text;
      expect(text).toContain('reason invalid_date');
      expect(text).toContain(`Recovery: ${declared?.recovery}`);
    });

    it('rejects air_date together with season, naming both fields', async () => {
      const result = await runToolContract(getEpisodes, {
        show_id: 2756,
        season: 2025,
        air_date: '2025-03-12',
      });
      expect(result.isError).toBe(true);
      expect(errorEnvelope(result.structuredContent).error).toMatchObject({
        code: JsonRpcErrorCode.InvalidParams,
        data: { reason: 'invalid_arguments' },
      });
      const text = (result.content[0] as { text: string }).text;
      expect(text).toContain('season and air_date cannot be combined');
      expect(getHttp().calls).toHaveLength(0);
    });

    it('rejects an air_date that is not YYYY-MM-DD before calling upstream', async () => {
      const result = await runToolContract(getEpisodes, { show_id: 2756, air_date: '2025-3-12' });
      expect(result.isError).toBe(true);
      expect((result.content[0] as { text: string }).text).toContain(
        'air_date: Invalid string: must match pattern',
      );
      expect(getHttp().calls).toHaveLength(0);
    });

    it('filters a special out of the day with the omitted count, and returns it with include_specials', async () => {
      routeProfile();
      getHttp().route({
        match: byDateUrl('2022-10-23'),
        respond: () => Response.json([rawEpisodeSpecial({ id: 2_393_182, airdate: '2022-10-23' })]),
      });

      const filtered = await runToolContract(getEpisodes, {
        show_id: 2756,
        air_date: '2022-10-23',
      });
      expect(filtered.structuredContent).toMatchObject({ episodes: [], totalCount: 0 });
      expect((filtered.structuredContent as { notice: string }).notice).toBe(
        '1 special(s) dated 2022-10-23 were omitted. Call again with include_specials true to include them.',
      );

      const included = await runToolContract(getEpisodes, {
        show_id: 2756,
        air_date: '2022-10-23',
        include_specials: true,
      });
      expect(included.structuredContent).toMatchObject({ episodes: [{ id: 2_393_182 }] });
      expect(included.structuredContent).not.toHaveProperty('notice');
    });
  });

  describe('season and whole-run output (characterization)', () => {
    it('renders a season listing on both surfaces exactly as pinned', async () => {
      getHttp().route({
        match: `${TVMAZE_TEST_BASE_URL}/shows/169?embed[]=seasons`,
        respond: Response.json(rawShow({ _embedded: { seasons: [rawSeason()] } })),
      });
      getHttp().route({
        match: `${TVMAZE_TEST_BASE_URL}/seasons/1/episodes`,
        respond: Response.json([rawEpisode({ id: 1 }), rawEpisodeSpecial({ id: 3 })]),
      });

      const result = await runToolContract(getEpisodes, { show_id: 169, season: 1 });
      expect(result.structuredContent).toMatchInlineSnapshot(`
        {
          "episodes": [
            {
              "airstamp": "2008-01-21T03:00:00+00:00",
              "id": 1,
              "image_url": "https://static.tvmaze.com/uploads/images/original_untouched/0/1.jpg",
              "local_date": "2008-01-21",
              "local_time": "2008-01-21 03:00 UTC",
              "name": "Pilot",
              "number": 1,
              "rating": 8.7,
              "runtime_minutes": 58,
              "season": 1,
              "summary": "Walter White begins his transformation.",
              "time_known": true,
              "type": "regular",
              "url": "https://www.tvmaze.com/episodes/11/breaking-bad-1x01-pilot",
            },
          ],
          "has_more": false,
          "notice": "1 special(s) in this season were omitted. Call again with include_specials true to include them.",
          "season": 1,
          "show": {
            "average_runtime_minutes": 47,
            "channel": "AMC",
            "channel_country": "US",
            "channel_type": "network",
            "ended": "2013-09-29",
            "externals": {
              "imdb": "tt0903747",
              "thetvdb": 81189,
              "tvrage": 18164,
            },
            "genres": [
              "Drama",
              "Crime",
              "Thriller",
            ],
            "id": 169,
            "image_url": "https://static.tvmaze.com/uploads/images/original_untouched/0/2400.jpg",
            "language": "English",
            "name": "Breaking Bad",
            "premiered": "2008-01-20",
            "rating": 9.3,
            "runtime_minutes": 60,
            "status": "Ended",
            "summary": "**Breaking Bad** follows protagonist Walter White.

        A high school chemistry teacher.",
            "type": "Scripted",
            "url": "https://www.tvmaze.com/shows/169/breaking-bad",
          },
          "timezone": "UTC",
          "totalCount": 1,
        }
      `);
      expect(result.content).toMatchInlineSnapshot(`
        [
          {
            "text": "# Breaking Bad — Season 1
        **season:** 1 | **timezone:** UTC
        **id:** 169 | **url:** https://www.tvmaze.com/shows/169/breaking-bad
        **type:** Scripted | **language:** English | **status:** Ended
        **premiered:** 2008-01-20 | **ended:** 2013-09-29
        **genres:** Drama, Crime, Thriller
        **channel:** AMC | **channel_type:** network | **channel_country:** US
        **runtime_minutes:** 60 | **average_runtime_minutes:** 47
        **rating:** 9.3
        **externals:** imdb tt0903747 · thetvdb 81189 · tvrage 18164
        **image_url:** https://static.tvmaze.com/uploads/images/original_untouched/0/2400.jpg
        **summary:**
        > **Breaking Bad** follows protagonist Walter White.
        > 
        > A high school chemistry teacher.

        **name:** Pilot | **id:** 1 | **season:** 1 | **number:** 1 | **type:** regular
        **local_date:** 2008-01-21 | **local_time:** 2008-01-21 03:00 UTC
        **time_known:** true | **airstamp:** 2008-01-21T03:00:00+00:00 | **runtime_minutes:** 58 | **rating:** 8.7
        **url:** https://www.tvmaze.com/episodes/11/breaking-bad-1x01-pilot | **image_url:** https://static.tvmaze.com/uploads/images/original_untouched/0/1.jpg
        **summary:**
        > Walter White begins his transformation.

        **has_more:** false | **next_cursor:** Not available",
            "type": "text",
          },
          {
            "text": "

        **1 total**
        > 1 special(s) in this season were omitted. Call again with include_specials true to include them.",
            "type": "text",
          },
        ]
      `);
    });

    it('renders a whole-run listing with no specials on both surfaces exactly as pinned', async () => {
      // Both whole-run routes answer with the same regular-only run, so the pin
      // holds whichever of the two the handler requests.
      for (const path of ['/shows/169/episodes', '/shows/169/episodes?specials=1']) {
        getHttp().route({
          match: `${TVMAZE_TEST_BASE_URL}${path}`,
          respond: () => Response.json([rawEpisode({ id: 1 }), rawEpisode({ id: 2, number: 2 })]),
        });
      }
      getHttp().route({
        match: `${TVMAZE_TEST_BASE_URL}/shows/169?embed[]=seasons`,
        respond: Response.json(rawShow({ _embedded: { seasons: [rawSeason()] } })),
      });

      const result = await runToolContract(getEpisodes, { show_id: 169 });
      expect(result.structuredContent).toMatchInlineSnapshot(`
        {
          "episodes": [
            {
              "airstamp": "2008-01-21T03:00:00+00:00",
              "id": 1,
              "image_url": "https://static.tvmaze.com/uploads/images/original_untouched/0/1.jpg",
              "local_date": "2008-01-21",
              "local_time": "2008-01-21 03:00 UTC",
              "name": "Pilot",
              "number": 1,
              "rating": 8.7,
              "runtime_minutes": 58,
              "season": 1,
              "summary": "Walter White begins his transformation.",
              "time_known": true,
              "type": "regular",
              "url": "https://www.tvmaze.com/episodes/11/breaking-bad-1x01-pilot",
            },
            {
              "airstamp": "2008-01-21T03:00:00+00:00",
              "id": 2,
              "image_url": "https://static.tvmaze.com/uploads/images/original_untouched/0/1.jpg",
              "local_date": "2008-01-21",
              "local_time": "2008-01-21 03:00 UTC",
              "name": "Pilot",
              "number": 2,
              "rating": 8.7,
              "runtime_minutes": 58,
              "season": 1,
              "summary": "Walter White begins his transformation.",
              "time_known": true,
              "type": "regular",
              "url": "https://www.tvmaze.com/episodes/11/breaking-bad-1x01-pilot",
            },
          ],
          "has_more": false,
          "show": {
            "average_runtime_minutes": 47,
            "channel": "AMC",
            "channel_country": "US",
            "channel_type": "network",
            "ended": "2013-09-29",
            "externals": {
              "imdb": "tt0903747",
              "thetvdb": 81189,
              "tvrage": 18164,
            },
            "genres": [
              "Drama",
              "Crime",
              "Thriller",
            ],
            "id": 169,
            "image_url": "https://static.tvmaze.com/uploads/images/original_untouched/0/2400.jpg",
            "language": "English",
            "name": "Breaking Bad",
            "premiered": "2008-01-20",
            "rating": 9.3,
            "runtime_minutes": 60,
            "status": "Ended",
            "summary": "**Breaking Bad** follows protagonist Walter White.

        A high school chemistry teacher.",
            "type": "Scripted",
            "url": "https://www.tvmaze.com/shows/169/breaking-bad",
          },
          "timezone": "UTC",
          "totalCount": 2,
        }
      `);
      expect(result.content).toMatchInlineSnapshot(`
        [
          {
            "text": "# Breaking Bad — all episodes
        **season:** Not available | **timezone:** UTC
        **id:** 169 | **url:** https://www.tvmaze.com/shows/169/breaking-bad
        **type:** Scripted | **language:** English | **status:** Ended
        **premiered:** 2008-01-20 | **ended:** 2013-09-29
        **genres:** Drama, Crime, Thriller
        **channel:** AMC | **channel_type:** network | **channel_country:** US
        **runtime_minutes:** 60 | **average_runtime_minutes:** 47
        **rating:** 9.3
        **externals:** imdb tt0903747 · thetvdb 81189 · tvrage 18164
        **image_url:** https://static.tvmaze.com/uploads/images/original_untouched/0/2400.jpg
        **summary:**
        > **Breaking Bad** follows protagonist Walter White.
        > 
        > A high school chemistry teacher.

        **name:** Pilot | **id:** 1 | **season:** 1 | **number:** 1 | **type:** regular
        **local_date:** 2008-01-21 | **local_time:** 2008-01-21 03:00 UTC
        **time_known:** true | **airstamp:** 2008-01-21T03:00:00+00:00 | **runtime_minutes:** 58 | **rating:** 8.7
        **url:** https://www.tvmaze.com/episodes/11/breaking-bad-1x01-pilot | **image_url:** https://static.tvmaze.com/uploads/images/original_untouched/0/1.jpg
        **summary:**
        > Walter White begins his transformation.

        **name:** Pilot | **id:** 2 | **season:** 1 | **number:** 2 | **type:** regular
        **local_date:** 2008-01-21 | **local_time:** 2008-01-21 03:00 UTC
        **time_known:** true | **airstamp:** 2008-01-21T03:00:00+00:00 | **runtime_minutes:** 58 | **rating:** 8.7
        **url:** https://www.tvmaze.com/episodes/11/breaking-bad-1x01-pilot | **image_url:** https://static.tvmaze.com/uploads/images/original_untouched/0/1.jpg
        **summary:**
        > Walter White begins his transformation.

        **has_more:** false | **next_cursor:** Not available",
            "type": "text",
          },
          {
            "text": "

        **2 total**",
            "type": "text",
          },
        ]
      `);
    });
  });

  it('produces invalid_timezone on both surfaces', async () => {
    getHttp().route({
      match: `${TVMAZE_TEST_BASE_URL}/shows/169?embed[]=seasons`,
      respond: Response.json(rawShow({ _embedded: { seasons: [rawSeason()] } })),
    });
    getHttp().route({
      match: WHOLE_RUN_URL,
      respond: Response.json([]),
    });

    const result = await runToolContract(getEpisodes, { show_id: 169, timezone: 'Not/AZone' });
    expect(result.isError).toBe(true);
    expect(errorEnvelope(result.structuredContent).error).toMatchObject({
      data: { reason: 'invalid_timezone' },
    });
  });
});
