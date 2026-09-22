/**
 * @fileoverview Tests for tvmaze_get_schedule — the linear/streaming/all scope
 * matrix, country normalization (UK -> GB, omitted vs explicit), the
 * merge-three-feeds-under-Promise.allSettled degrade-to-notice path, the
 * distinct input-error-vs-feed-outage split on scope "all", pagination, the
 * time_known:false placeholder rendering, and the full error contract.
 * @module tests/mcp-server/tools/definitions/get-schedule.tool.test
 */

import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { encodeCursor } from '@cyanheads/mcp-ts-core/utils';
import { describe, expect, it, vi } from 'vitest';

import { getSchedule } from '@/mcp-server/tools/definitions/get-schedule.tool.js';
import {
  rawEpisode,
  rawEpisodeNoTime,
  rawShow,
  rawShowSparse,
  rawShowStreaming,
  tvmazeErrorBody,
} from '../../../fixtures/tvmaze-fixtures.js';
import { errorEnvelope } from '../../../helpers/error-envelope.js';
import {
  installTvmazeToolHarness,
  TVMAZE_TEST_BASE_URL,
} from '../../../helpers/tvmaze-tool-harness.js';

const getHttp = installTvmazeToolHarness();

describe('tvmaze_get_schedule', () => {
  it('lists the linear feed for an explicit country and date', async () => {
    getHttp().route({
      match: `${TVMAZE_TEST_BASE_URL}/schedule?country=US&date=2026-09-18`,
      respond: Response.json([{ ...rawEpisode(), show: rawShow() }]),
    });

    const result = await runToolContract(getSchedule, { date: '2026-09-18', country: 'US' });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      entries: [{ feed: 'linear', show: { id: 169 } }],
      date: '2026-09-18',
      applied_feeds: ['linear:US'],
      totalCount: 1,
    });
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain('# Schedule — 2026-09-18');
    expect(text).toContain('## linear');
    // The enrichmentTrailer's applied_feeds renderer lands in its own content
    // block, appended after the domain format() block.
    const fullText = result.content?.map((block) => (block as { text: string }).text).join('\n');
    expect(fullText).toContain('**Feeds queried:** linear:US');
  });

  it('folds UK to GB on the linear feed', async () => {
    getHttp().route({
      match: `${TVMAZE_TEST_BASE_URL}/schedule?country=GB&date=2026-09-18`,
      respond: Response.json([]),
    });

    const result = await runToolContract(getSchedule, { date: '2026-09-18', country: 'UK' });
    expect(result.structuredContent).toMatchObject({ applied_feeds: ['linear:GB'] });
  });

  it('scope "streaming" with a country reads that country’s local streaming feed', async () => {
    getHttp().route({
      match: `${TVMAZE_TEST_BASE_URL}/schedule/web?country=US&date=2026-09-18`,
      respond: Response.json([{ ...rawEpisode(), _embedded: { show: rawShowStreaming() } }]),
    });

    const result = await runToolContract(getSchedule, {
      date: '2026-09-18',
      country: 'US',
      scope: 'streaming',
    });
    expect(result.structuredContent).toMatchObject({
      entries: [{ feed: 'streaming', show: { channel: 'Netflix' } }],
      applied_feeds: ['web:US'],
    });
  });

  it('scope "streaming" with no country reads the global feed, and renders time_known:false correctly', async () => {
    getHttp().route({
      match: `${TVMAZE_TEST_BASE_URL}/schedule/web?country=&date=2026-09-18`,
      respond: Response.json([{ ...rawEpisodeNoTime(), _embedded: { show: rawShowStreaming() } }]),
    });

    const result = await runToolContract(getSchedule, { date: '2026-09-18', scope: 'streaming' });
    expect(result.structuredContent).toMatchObject({
      applied_feeds: ['web:global'],
      entries: [{ time_known: false, local_date: '2026-09-18' }],
    });
    const entry = (result.structuredContent as { entries: Array<Record<string, unknown>> })
      .entries[0];
    expect(entry).not.toHaveProperty('local_time');
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain('time not announced');
  });

  it('scope "all" merges three feeds and dedupes an entry seen on both linear and its own web feed', async () => {
    const dupe = rawEpisode({ id: 42 });
    getHttp().route({
      match: `${TVMAZE_TEST_BASE_URL}/schedule?country=US&date=2026-09-18`,
      respond: Response.json([{ ...dupe, show: rawShow({ id: 1 }) }]),
    });
    getHttp().route({
      match: `${TVMAZE_TEST_BASE_URL}/schedule/web?country=US&date=2026-09-18`,
      respond: Response.json([{ ...dupe, _embedded: { show: rawShow({ id: 1 }) } }]),
    });
    getHttp().route({
      match: `${TVMAZE_TEST_BASE_URL}/schedule/web?country=&date=2026-09-18`,
      respond: Response.json([
        { ...rawEpisode({ id: 43 }), _embedded: { show: rawShowStreaming() } },
      ]),
    });

    const result = await runToolContract(getSchedule, {
      date: '2026-09-18',
      country: 'US',
      scope: 'all',
    });
    expect(result.structuredContent).toMatchObject({
      applied_feeds: ['linear:US', 'web:US', 'web:global'],
      totalCount: 2,
    });
    const ids = (result.structuredContent as { entries: Array<{ id: number }> }).entries.map(
      (e) => e.id,
    );
    expect(ids.sort()).toEqual([42, 43]);
  });

  it('degrades to a partial-feed notice when one feed of scope "all" fails (non-transient, no retry)', async () => {
    getHttp().route({
      match: `${TVMAZE_TEST_BASE_URL}/schedule?country=US&date=2026-09-18`,
      respond: Response.json([{ ...rawEpisode(), show: rawShow() }]),
    });
    getHttp().route({
      match: `${TVMAZE_TEST_BASE_URL}/schedule/web?country=US&date=2026-09-18`,
      respond: () => new Response(tvmazeErrorBody('Not Found', '', 404), { status: 404 }),
    });
    getHttp().route({
      match: `${TVMAZE_TEST_BASE_URL}/schedule/web?country=&date=2026-09-18`,
      respond: Response.json([
        { ...rawEpisode({ id: 43 }), _embedded: { show: rawShowStreaming() } },
      ]),
    });

    const result = await runToolContract(getSchedule, {
      date: '2026-09-18',
      country: 'US',
      scope: 'all',
    });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      applied_feeds: ['linear:US', 'web:global'],
      notice: expect.stringContaining('web:US feed did not respond'),
    });
  });

  it('reports schedule_unavailable on both surfaces when every feed fails after retries', async () => {
    getHttp().route({
      match: `${TVMAZE_TEST_BASE_URL}/schedule?country=US&date=2026-09-18`,
      respond: () => new Response('Too Many Requests', { status: 429 }),
    });

    // Retry backoff, the pacer's 429 cooldown, and the retry deadline all run
    // on real setTimeout/Date.now — fake timers collapse the ~14s of actual
    // waiting to a few ticks of virtual time without changing what fires.
    vi.useFakeTimers();
    try {
      const resultPromise = runToolContract(getSchedule, { date: '2026-09-18', country: 'US' });
      await vi.advanceTimersByTimeAsync(35_000);
      const result = await resultPromise;
      expect(result.isError).toBe(true);
      expect(errorEnvelope(result.structuredContent).error).toMatchObject({
        data: { reason: 'schedule_unavailable', retryable: true },
      });
      const text = (result.content[0] as { text: string }).text;
      expect(text).toContain('reason schedule_unavailable');
    } finally {
      vi.useRealTimers();
    }
  });

  it('surfaces invalid_country typed on scope "all" instead of downgrading it to a partial-feed notice, even though the global web feed succeeds', async () => {
    const countryRejection = new Response(
      tvmazeErrorBody('Unprocessable entity', 'Not a valid ISO country code', 422),
      { status: 422 },
    );
    getHttp().route({
      match: `${TVMAZE_TEST_BASE_URL}/schedule?country=ZZ&date=2026-09-18`,
      respond: countryRejection,
    });
    getHttp().route({
      match: `${TVMAZE_TEST_BASE_URL}/schedule/web?country=ZZ&date=2026-09-18`,
      respond: countryRejection,
    });
    getHttp().route({
      match: `${TVMAZE_TEST_BASE_URL}/schedule/web?country=&date=2026-09-18`,
      respond: Response.json([
        { ...rawEpisode({ id: 43 }), _embedded: { show: rawShowStreaming() } },
      ]),
    });

    const result = await runToolContract(getSchedule, {
      date: '2026-09-18',
      country: 'ZZ',
      scope: 'all',
    });
    expect(result.isError).toBe(true);
    expect(errorEnvelope(result.structuredContent).error).toMatchObject({
      data: { reason: 'invalid_country' },
    });
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain('reason invalid_country');
    expect(text).not.toContain('did not respond');
  });

  it('emits a zero-hit notice for an empty linear result', async () => {
    getHttp().route({
      match: `${TVMAZE_TEST_BASE_URL}/schedule?country=US&date=2026-09-18`,
      respond: Response.json([]),
    });

    const result = await runToolContract(getSchedule, { date: '2026-09-18', country: 'US' });
    expect(result.structuredContent).toMatchObject({
      entries: [],
      notice: expect.stringContaining('Nothing is listed for US on 2026-09-18'),
    });
  });

  it('paginates with limit and cursor, and returns empty for a cursor past the end', async () => {
    getHttp().route({
      match: `${TVMAZE_TEST_BASE_URL}/schedule?country=US&date=2026-09-18`,
      respond: Response.json([
        { ...rawEpisode({ id: 1, airstamp: '2026-09-18T01:00:00+00:00' }), show: rawShow() },
        { ...rawEpisode({ id: 2, airstamp: '2026-09-18T02:00:00+00:00' }), show: rawShow() },
        { ...rawEpisode({ id: 3, airstamp: '2026-09-18T03:00:00+00:00' }), show: rawShow() },
      ]),
    });

    const page1 = await runToolContract(getSchedule, {
      date: '2026-09-18',
      country: 'US',
      limit: 2,
    });
    expect(page1.structuredContent).toMatchObject({ has_more: true, shown: 2, cap: 2 });
    const cursor = (page1.structuredContent as { next_cursor: string }).next_cursor;

    const page2 = await runToolContract(getSchedule, {
      date: '2026-09-18',
      country: 'US',
      limit: 2,
      cursor,
    });
    expect(page2.structuredContent).toMatchObject({ entries: [{ id: 3 }], has_more: false });

    const pastEnd = encodeCursor({ offset: 500, limit: 50 });
    const page3 = await runToolContract(getSchedule, {
      date: '2026-09-18',
      country: 'US',
      cursor: pastEnd,
    });
    expect(page3.structuredContent).toMatchObject({ entries: [], has_more: false });
  });

  describe('compact show reference on each row (#10)', () => {
    const COMPACT_KEYS = [
      'channel',
      'channel_country',
      'channel_type',
      'genres',
      'id',
      'name',
      'type',
      'url',
    ];

    it('carries only the eight compact show fields, dropping summary and externals from both surfaces', async () => {
      getHttp().route({
        match: `${TVMAZE_TEST_BASE_URL}/schedule?country=US&date=2026-09-18`,
        respond: Response.json([
          {
            ...rawEpisode({ summary: null }),
            show: rawShow({ summary: '<p>A distinctive show synopsis.</p>' }),
          },
        ]),
      });

      const result = await runToolContract(getSchedule, { date: '2026-09-18', country: 'US' });
      expect(result.isError).toBeFalsy();
      const show = (result.structuredContent as { entries: Array<{ show: object }> }).entries[0]
        ?.show;
      expect(Object.keys(show ?? {}).sort()).toEqual(COMPACT_KEYS);
      expect(show).toEqual({
        id: 169,
        name: 'Breaking Bad',
        url: 'https://www.tvmaze.com/shows/169/breaking-bad',
        type: 'Scripted',
        genres: ['Drama', 'Crime', 'Thriller'],
        channel: 'AMC',
        channel_type: 'network',
        channel_country: 'US',
      });

      const text = result.content.map((block) => (block as { text: string }).text).join('\n');
      expect(text).not.toContain('A distinctive show synopsis');
      expect(text).not.toContain('tt0903747');
      expect(text).not.toContain('externals');
      expect(text).not.toContain('**premiered:**');
      expect(text).not.toContain('**status:**');
      expect(text).not.toContain('average_runtime_minutes');
      for (const line of [
        '**id:** 169',
        '**url:** https://www.tvmaze.com/shows/169/breaking-bad',
        '**type:** Scripted',
        '**genres:** Drama, Crime, Thriller',
        '**channel:** AMC',
        '**channel_type:** network',
        '**channel_country:** US',
      ]) {
        expect(text).toContain(line);
      }
    });

    it('leaves optional compact fields absent when upstream lacks them, rendering them as not available', async () => {
      getHttp().route({
        match: `${TVMAZE_TEST_BASE_URL}/schedule/web?country=&date=2026-09-18`,
        respond: Response.json([
          { ...rawEpisodeNoTime(), _embedded: { show: rawShowSparse({ genres: null }) } },
        ]),
      });

      const result = await runToolContract(getSchedule, { date: '2026-09-18', scope: 'streaming' });
      const show = (result.structuredContent as { entries: Array<{ show: object }> }).entries[0]
        ?.show;
      expect(show).toEqual({
        id: 999,
        name: 'A Small Title',
        url: 'https://www.tvmaze.com/shows/999/small-title',
        genres: [],
      });
      const text = result.content.map((block) => (block as { text: string }).text).join('\n');
      expect(text).toContain('**channel:** Not available');
      expect(text).toContain('**type:** Not available');
    });
  });

  describe('page size on a cursor call', () => {
    function routeDay(count: number) {
      getHttp().route({
        match: `${TVMAZE_TEST_BASE_URL}/schedule?country=US&date=2026-09-18`,
        respond: () =>
          Response.json(
            Array.from({ length: count }, (_, index) => ({
              ...rawEpisode({
                id: index + 1,
                airstamp: new Date(Date.UTC(2026, 8, 18, 0, index)).toISOString(),
              }),
              show: rawShow(),
            })),
          ),
      });
    }
    const ids = (result: { structuredContent?: unknown }) =>
      (result.structuredContent as { entries: Array<{ id: number }> }).entries.map((e) => e.id);
    const cursorOf = (result: { structuredContent?: unknown }) =>
      (result.structuredContent as { next_cursor: string }).next_cursor;
    const base = { date: '2026-09-18', country: 'US' };

    it('takes the page size from the current limit, and resumes contiguously', async () => {
      routeDay(20);
      const page1 = await runToolContract(getSchedule, { ...base, limit: 2 });
      const page2 = await runToolContract(getSchedule, {
        ...base,
        limit: 5,
        cursor: cursorOf(page1),
      });
      expect(ids(page2)).toEqual([3, 4, 5, 6, 7]);
      expect(page2.structuredContent).toMatchObject({ shown: 5, cap: 5, has_more: true });
      const page3 = await runToolContract(getSchedule, {
        ...base,
        limit: 250,
        cursor: cursorOf(page2),
      });
      expect([...ids(page1), ...ids(page2), ...ids(page3)]).toEqual(
        Array.from({ length: 20 }, (_, index) => index + 1),
      );
      expect(page3.structuredContent).toMatchObject({ has_more: false });
    });

    it('applies the default limit of 50 on a cursor call that omits limit', async () => {
      routeDay(80);
      const page1 = await runToolContract(getSchedule, { ...base, limit: 2 });
      const page2 = await runToolContract(getSchedule, { ...base, cursor: cursorOf(page1) });
      expect(ids(page2)).toHaveLength(50);
      expect(ids(page2)[0]).toBe(3);
      expect(page2.structuredContent).toMatchObject({ shown: 50, cap: 50 });
    });

    it('accepts a cursor encoded as { offset, limit } by the previous release', async () => {
      routeDay(20);
      const legacy = encodeCursor({ offset: 10, limit: 2 });
      const result = await runToolContract(getSchedule, { ...base, limit: 4, cursor: legacy });
      expect(ids(result)).toEqual([11, 12, 13, 14]);
    });
  });

  it('carries both the truncation guidance and the feed-failed notice on a truncated merged page', async () => {
    getHttp().route({
      match: `${TVMAZE_TEST_BASE_URL}/schedule?country=US&date=2026-09-18`,
      respond: Response.json(
        [1, 2, 3].map((id) => ({
          ...rawEpisode({ id, airstamp: `2026-09-18T0${id}:00:00+00:00` }),
          show: rawShow(),
        })),
      ),
    });
    getHttp().route({
      match: `${TVMAZE_TEST_BASE_URL}/schedule/web?country=US&date=2026-09-18`,
      respond: () => new Response(tvmazeErrorBody('Not Found', '', 404), { status: 404 }),
    });
    getHttp().route({
      match: `${TVMAZE_TEST_BASE_URL}/schedule/web?country=&date=2026-09-18`,
      respond: Response.json([]),
    });

    const result = await runToolContract(getSchedule, {
      date: '2026-09-18',
      country: 'US',
      scope: 'all',
      limit: 2,
    });
    expect(result.structuredContent).toMatchObject({ truncated: true, shown: 2, cap: 2 });
    const notice = (result.structuredContent as { notice: string }).notice;
    expect(notice).toContain('next_cursor');
    expect(notice).toContain('web:US feed did not respond');
    const text = result.content.map((block) => (block as { text: string }).text).join('\n');
    expect(text).toContain('next_cursor');
    expect(text).toContain('web:US feed did not respond');
  });

  it('produces invalid_date via a well-formed but impossible calendar date (shape passes, calendar validity does not)', async () => {
    getHttp().route({
      match: `${TVMAZE_TEST_BASE_URL}/schedule?country=US&date=2026-02-30`,
      respond: new Response(tvmazeErrorBody('Unprocessable entity', 'Not a valid ISO date', 422), {
        status: 422,
      }),
    });

    const result = await runToolContract(getSchedule, { date: '2026-02-30', country: 'US' });
    expect(result.isError).toBe(true);
    expect(errorEnvelope(result.structuredContent).error).toMatchObject({
      data: { reason: 'invalid_date' },
    });
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain('reason invalid_date');
  });

  it('produces invalid_timezone on both surfaces', async () => {
    const result = await runToolContract(getSchedule, {
      date: '2026-09-18',
      timezone: 'Not/AZone',
    });
    expect(result.isError).toBe(true);
    expect(errorEnvelope(result.structuredContent).error).toMatchObject({
      data: { reason: 'invalid_timezone' },
    });
  });
});
