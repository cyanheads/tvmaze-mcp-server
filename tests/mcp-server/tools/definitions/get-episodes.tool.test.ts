/**
 * @fileoverview Tests for tvmaze_get_episodes — season-scoped vs whole-run
 * paths, the specials filter (season route always includes them; whole-run
 * route honors ?specials=1), pagination boundaries (limit, cursor, cursor
 * past the end), zero-hit notices, and the show_not_found / season_not_found /
 * invalid_timezone error contract.
 * @module tests/mcp-server/tools/definitions/get-episodes.tool.test
 */

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

  it('walks the whole run when season is omitted, requesting ?specials=1 only when asked', async () => {
    getHttp().route({
      match: `${TVMAZE_TEST_BASE_URL}/shows/169?embed[]=seasons`,
      respond: Response.json(rawShow({ _embedded: { seasons: [rawSeason()] } })),
    });
    getHttp().route({
      match: `${TVMAZE_TEST_BASE_URL}/shows/169/episodes`,
      respond: Response.json([rawEpisode({ id: 1 }), rawEpisode({ id: 2 })]),
    });

    const result = await runToolContract(getEpisodes, { show_id: 169 });
    expect(result.structuredContent).toMatchObject({ episodes: [{ id: 1 }, { id: 2 }] });
    expect(result.structuredContent).not.toHaveProperty('season');
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain('— all episodes');
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
      match: `${TVMAZE_TEST_BASE_URL}/shows/169/episodes`,
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

  it('returns an empty page for a cursor whose offset is past the end', async () => {
    getHttp().route({
      match: `${TVMAZE_TEST_BASE_URL}/shows/169?embed[]=seasons`,
      respond: Response.json(rawShow({ _embedded: { seasons: [rawSeason()] } })),
    });
    getHttp().route({
      match: `${TVMAZE_TEST_BASE_URL}/shows/169/episodes`,
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
      match: `${TVMAZE_TEST_BASE_URL}/shows/99999999/episodes`,
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

  it('produces invalid_timezone on both surfaces', async () => {
    getHttp().route({
      match: `${TVMAZE_TEST_BASE_URL}/shows/169?embed[]=seasons`,
      respond: Response.json(rawShow({ _embedded: { seasons: [rawSeason()] } })),
    });
    getHttp().route({
      match: `${TVMAZE_TEST_BASE_URL}/shows/169/episodes`,
      respond: Response.json([]),
    });

    const result = await runToolContract(getEpisodes, { show_id: 169, timezone: 'Not/AZone' });
    expect(result.isError).toBe(true);
    expect(errorEnvelope(result.structuredContent).error).toMatchObject({
      data: { reason: 'invalid_timezone' },
    });
  });
});
