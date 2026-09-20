/**
 * @fileoverview Tests for tvmaze_lookup_show — the imdb/thetvdb/tvrage
 * discriminated input, the hit/miss result shape, and the declared
 * lookup_unavailable error contract (including full retry exhaustion).
 * @module tests/mcp-server/tools/definitions/lookup-show.tool.test
 */

import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { describe, expect, it, vi } from 'vitest';

import { lookupShow } from '@/mcp-server/tools/definitions/lookup-show.tool.js';
import { rawShow } from '../../../fixtures/tvmaze-fixtures.js';
import { errorEnvelope } from '../../../helpers/error-envelope.js';
import {
  installTvmazeToolHarness,
  TVMAZE_TEST_BASE_URL,
} from '../../../helpers/tvmaze-tool-harness.js';

const getHttp = installTvmazeToolHarness();

describe('tvmaze_lookup_show', () => {
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
