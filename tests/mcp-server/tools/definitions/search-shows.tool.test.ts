/**
 * @fileoverview Tests for tvmaze_search_shows — structuredContent + content
 * parity, the zero-hit and ten-result-cap notices, and the declared
 * search_unavailable error contract (including full retry exhaustion).
 * @module tests/mcp-server/tools/definitions/search-shows.tool.test
 */

import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { describe, expect, it, vi } from 'vitest';

import { searchShows } from '@/mcp-server/tools/definitions/search-shows.tool.js';
import { rawSearchHit, rawShow, rawShowSparse } from '../../../fixtures/tvmaze-fixtures.js';
import { errorEnvelope } from '../../../helpers/error-envelope.js';
import {
  installTvmazeToolHarness,
  TVMAZE_TEST_BASE_URL,
} from '../../../helpers/tvmaze-tool-harness.js';

const getHttp = installTvmazeToolHarness();

describe('tvmaze_search_shows', () => {
  it('returns matches with structuredContent and rendered content in parity', async () => {
    getHttp().route({
      match: `${TVMAZE_TEST_BASE_URL}/search/shows?q=breaking`,
      respond: Response.json([rawSearchHit({ score: 8.4 })]),
    });

    const result = await runToolContract(searchShows, { query: 'breaking' });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      shows: [expect.objectContaining({ id: 169, name: 'Breaking Bad', match_score: 8.4 })],
      effectiveQuery: 'breaking',
    });
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain('**1 shows**');
    expect(text).toContain('Breaking Bad');
    expect(text).toContain('match_score:** 8.4');
    expect(text).toContain('imdb tt0903747');
  });

  it('renders "Not available" for a sparse show without inventing values', async () => {
    getHttp().route({
      match: `${TVMAZE_TEST_BASE_URL}/search/shows?q=small`,
      respond: Response.json([rawSearchHit({ score: 1, show: rawShowSparse() })]),
    });

    const result = await runToolContract(searchShows, { query: 'small' });
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain('**rating:** Not available');
    expect(text).toContain('**summary:** Not available');
    expect(text).not.toContain('**rating:** 0');
  });

  it('emits a zero-hit notice and no truncation flag', async () => {
    getHttp().route({
      match: `${TVMAZE_TEST_BASE_URL}/search/shows?q=zzzz`,
      respond: Response.json([]),
    });

    const result = await runToolContract(searchShows, { query: 'zzzz' });
    expect(result.structuredContent).toMatchObject({
      shows: [],
      notice: expect.stringContaining('No show title matched "zzzz"'),
    });
    expect(result.structuredContent).not.toHaveProperty('truncated');
  });

  it('discloses the ten-result cap when exactly 10 rows return', async () => {
    getHttp().route({
      match: `${TVMAZE_TEST_BASE_URL}/search/shows?q=common`,
      respond: Response.json(
        Array.from({ length: 10 }, (_, i) => rawSearchHit({ show: rawShow({ id: i }) })),
      ),
    });

    const result = await runToolContract(searchShows, { query: 'common' });
    expect(result.structuredContent).toMatchObject({
      truncated: true,
      shown: 10,
      cap: 10,
      notice: expect.stringContaining('caps this search at 10 results'),
    });
  });

  it('rejects an empty query at the schema boundary with InvalidParams', async () => {
    const result = await runToolContract(searchShows, { query: '' });
    expect(result.isError).toBe(true);
    expect(errorEnvelope(result.structuredContent).error).toMatchObject({ code: -32602 });
  });

  it('produces search_unavailable on both surfaces once retries are exhausted', async () => {
    getHttp().route({
      match: `${TVMAZE_TEST_BASE_URL}/search/shows?q=always-down`,
      respond: () => new Response('Too Many Requests', { status: 429 }),
    });

    // Retry backoff, the pacer's 429 cooldown, and the retry deadline all run
    // on real setTimeout/Date.now — fake timers collapse the ~14s of actual
    // waiting to a few ticks of virtual time without changing what fires.
    vi.useFakeTimers();
    try {
      const resultPromise = runToolContract(searchShows, { query: 'always-down' });
      await vi.advanceTimersByTimeAsync(35_000);
      const result = await resultPromise;
      expect(result.isError).toBe(true);
      expect(errorEnvelope(result.structuredContent).error).toMatchObject({
        data: { reason: 'search_unavailable', retryable: true },
      });
      const text = (result.content[0] as { text: string }).text;
      expect(text).toContain('reason search_unavailable');
      expect(text).toContain('Recovery:');
    } finally {
      vi.useRealTimers();
    }
  });
});
