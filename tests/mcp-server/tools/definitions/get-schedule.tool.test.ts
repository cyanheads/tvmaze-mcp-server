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
import { describe, expect, it } from 'vitest';

import { getSchedule } from '@/mcp-server/tools/definitions/get-schedule.tool.js';
import {
  rawEpisode,
  rawEpisodeNoTime,
  rawShow,
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

    const result = await runToolContract(getSchedule, { date: '2026-09-18', country: 'US' });
    expect(result.isError).toBe(true);
    expect(errorEnvelope(result.structuredContent).error).toMatchObject({
      data: { reason: 'schedule_unavailable', retryable: true },
    });
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain('reason schedule_unavailable');
  }, 25_000);

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
