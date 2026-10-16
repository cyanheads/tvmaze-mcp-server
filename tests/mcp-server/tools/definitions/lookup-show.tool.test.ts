/**
 * @fileoverview Tests for tvmaze_lookup_show — the imdb/thetvdb/tvrage
 * discriminated input, the hit/miss result shape, and the declared
 * lookup_unavailable error contract (including full retry exhaustion).
 * @module tests/mcp-server/tools/definitions/lookup-show.tool.test
 */

import { z } from '@cyanheads/mcp-ts-core';
import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { describe, expect, it, vi } from 'vitest';
import { getNextEpisode } from '@/mcp-server/tools/definitions/get-next-episode.tool.js';
import { lookupShow } from '@/mcp-server/tools/definitions/lookup-show.tool.js';
import { searchShows } from '@/mcp-server/tools/definitions/search-shows.tool.js';
import { inline } from '@/mcp-server/tools/definitions/shared-schemas.js';
import { rawShow } from '../../../fixtures/tvmaze-fixtures.js';
import { errorEnvelope } from '../../../helpers/error-envelope.js';
import {
  installTvmazeToolHarness,
  TVMAZE_TEST_BASE_URL,
} from '../../../helpers/tvmaze-tool-harness.js';

const getHttp = installTvmazeToolHarness();

describe('tvmaze_lookup_show', () => {
  it('keeps the advertised IMDb schema canonical and preserves leading zeros', async () => {
    const schema = z.toJSONSchema(lookupShow.input, { io: 'input' });
    expect(schema).toMatchObject({
      oneOf: [{ properties: { external_id: { pattern: '^tt\\d{7,}$' } } }, {}, {}],
    });
    getHttp().route({
      match: `${TVMAZE_TEST_BASE_URL}/lookup/shows?imdb=tt0000001`,
      respond: Response.json(rawShow()),
    });
    const result = await runToolContract(lookupShow, { source: 'imdb', external_id: '0000001' });
    expect(result.structuredContent).toMatchObject({ external_id: 'tt0000001' });
  });
  it('bounds new normalization and literal rendering across a 64-fold input span', () => {
    const measure = (length: number) => {
      const digits = '0'.repeat(length);
      const text = '*'.repeat(length);
      const begin = process.threadCpuUsage();
      for (let repeat = 0; repeat < 20; repeat++) {
        lookupShow.input.safeParse({ source: 'imdb', external_id: digits });
        lookupShow.input.safeParse({
          source: 'imdb',
          external_id: `https://imdb.com/title/tt${digits}/bad`,
        });
        inline(text);
      }
      const cpu = process.threadCpuUsage(begin);
      return cpu.user + cpu.system;
    };
    measure(5_000);
    const small = measure(5_000);
    measure(20_000);
    measure(80_000);
    const large = measure(320_000);
    expect(large / Math.max(small, 1)).toBeLessThan(256);
    expect(large).toBeLessThan(2_000_000);
  });
  it('rejects whitespace-only titles before fetching', async () => {
    getHttp().route({
      match: `${TVMAZE_TEST_BASE_URL}/search/shows?q=%20%09%20`,
      respond: Response.json([]),
    });
    getHttp().route({
      match: `${TVMAZE_TEST_BASE_URL}/singlesearch/shows?q=%20%09%20&embed[]=nextepisode&embed[]=previousepisode`,
      respond: new Response('null', { status: 404 }),
    });
    const search = await runToolContract(searchShows, { query: ' \t ' });
    const next = await runToolContract(getNextEpisode, { by: 'title', title: ' \t ' });
    expect(search.isError).toBe(true);
    expect(next.isError).toBe(true);
    expect(getHttp().calls).toHaveLength(0);
  });
  it.each([
    'TT0903747',
    '0903747',
    ' tt0903747 ',
    'https://www.imdb.com/title/tt0903747/?ref=x#top',
  ])('normalizes IMDb input %s', async (external_id) => {
    getHttp().route({
      match: `${TVMAZE_TEST_BASE_URL}/lookup/shows?imdb=tt0903747`,
      respond: Response.json(rawShow()),
    });
    const result = await runToolContract(lookupShow, { source: 'imdb', external_id });
    expect(result.structuredContent).toMatchObject({ found: true, external_id: 'tt0903747' });
    expect((result.content[0] as { text: string }).text).toContain('**external_id:** tt0903747');
  });
  it.each([
    'https://imdb.com.evil.test/title/tt0903747',
    'https://imdb.com@evil.test/title/tt0903747',
    'https://user@imdb.com/title/tt0903747',
    'https://imdb.com/title/tt0903747/extra',
    'tt123456',
  ])('rejects invalid IMDb input %s without fetching', async (external_id) => {
    const result = await runToolContract(lookupShow, { source: 'imdb', external_id });
    expect(result.isError).toBe(true);
    expect(getHttp().calls).toHaveLength(0);
  });
  it('resolves an IMDb id to a show (hit)', async () => {
    getHttp().route({
      match: `${TVMAZE_TEST_BASE_URL}/lookup/shows?imdb=tt0903747`,
      respond: Response.json(rawShow()),
    });

    const result = await runToolContract(lookupShow, { source: 'imdb', external_id: 'tt0903747' });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      found: true,
      source: 'imdb',
      external_id: 'tt0903747',
      show: { id: 169, name: 'Breaking Bad' },
    });
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain('# Breaking Bad');
    expect(text).toContain('**found:** true');
  });

  it('resolves a TheTVDB id to a show', async () => {
    getHttp().route({
      match: `${TVMAZE_TEST_BASE_URL}/lookup/shows?thetvdb=81189`,
      respond: Response.json(rawShow()),
    });

    const result = await runToolContract(lookupShow, { source: 'thetvdb', external_id: '81189' });
    expect(result.structuredContent).toMatchObject({ found: true, source: 'thetvdb' });
  });

  it('reports a well-formed-but-unmatched TVRage id as a structured miss, not an error', async () => {
    getHttp().route({
      match: `${TVMAZE_TEST_BASE_URL}/lookup/shows?tvrage=1`,
      respond: new Response('null', { status: 404 }),
    });

    const result = await runToolContract(lookupShow, { source: 'tvrage', external_id: '1' });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      found: false,
      source: 'tvrage',
      external_id: '1',
      guidance: expect.stringContaining('No TVmaze show carries the tvrage id "1"'),
    });
    expect(result.structuredContent).not.toHaveProperty('show');
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain('**No match**');
    expect(text).toContain('guidance');
  });

  it('rejects a malformed IMDb id at the schema boundary', async () => {
    const result = await runToolContract(lookupShow, { source: 'imdb', external_id: '12345' });
    expect(result.isError).toBe(true);
    expect(errorEnvelope(result.structuredContent).error).toMatchObject({ code: -32602 });
  });

  it('produces lookup_unavailable on both surfaces once retries are exhausted', async () => {
    getHttp().route({
      match: `${TVMAZE_TEST_BASE_URL}/lookup/shows?imdb=tt0000001`,
      respond: () => new Response('Too Many Requests', { status: 429 }),
    });

    // Retry backoff, the pacer's 429 cooldown, and the retry deadline all run
    // on real setTimeout/Date.now — fake timers collapse the ~14s of actual
    // waiting to a few ticks of virtual time without changing what fires.
    vi.useFakeTimers();
    try {
      const resultPromise = runToolContract(lookupShow, {
        source: 'imdb',
        external_id: 'tt0000001',
      });
      await vi.advanceTimersByTimeAsync(35_000);
      const result = await resultPromise;
      expect(result.isError).toBe(true);
      expect(errorEnvelope(result.structuredContent).error).toMatchObject({
        data: { reason: 'lookup_unavailable', retryable: true },
      });
      const text = (result.content[0] as { text: string }).text;
      expect(text).toContain('reason lookup_unavailable');
    } finally {
      vi.useRealTimers();
    }
  });
});
