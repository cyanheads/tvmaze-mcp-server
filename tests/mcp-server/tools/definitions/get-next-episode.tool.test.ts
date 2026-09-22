/**
 * @fileoverview Tests for tvmaze_get_next_episode — resolution by id or title,
 * the between-seasons miss (previous_episode carried on the miss), the
 * bad-title-is-a-miss / bad-id-throws split, and the invalid_timezone
 * contract entry.
 * @module tests/mcp-server/tools/definitions/get-next-episode.tool.test
 */

import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { describe, expect, it } from 'vitest';

import { getNextEpisode } from '@/mcp-server/tools/definitions/get-next-episode.tool.js';
import { rawEpisode, rawShow, tvmazeErrorBody } from '../../../fixtures/tvmaze-fixtures.js';
import { errorEnvelope } from '../../../helpers/error-envelope.js';
import {
  installTvmazeToolHarness,
  TVMAZE_TEST_BASE_URL,
} from '../../../helpers/tvmaze-tool-harness.js';

const getHttp = installTvmazeToolHarness();
const ID_EMBED_QS = 'embed[]=nextepisode&embed[]=previousepisode';

describe('tvmaze_get_next_episode', () => {
  it('reports the next episode by id, with the previous episode carried too', async () => {
    getHttp().route({
      match: `${TVMAZE_TEST_BASE_URL}/shows/169?${ID_EMBED_QS}`,
      respond: Response.json(
        rawShow({
          _embedded: {
            nextepisode: rawEpisode({ id: 20, name: 'Next Up' }),
            previousepisode: rawEpisode({ id: 19, name: 'Last One' }),
          },
        }),
      ),
    });

    const result = await runToolContract(getNextEpisode, {
      by: 'id',
      show_id: 169,
      timezone: 'America/Los_Angeles',
    });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      found: true,
      show: { id: 169 },
      next_episode: { id: 20, name: 'Next Up' },
      previous_episode: { id: 19, name: 'Last One' },
      timezone: 'America/Los_Angeles',
    });
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain('## Next: Next Up');
    expect(text).toContain('## Previously');
    expect(text).not.toContain('**No scheduled episode**');
    expect(text).not.toContain('**Show not found**');
  });

  it('resolves by title via singlesearch', async () => {
    getHttp().route({
      match: (req) => req.url.startsWith(`${TVMAZE_TEST_BASE_URL}/singlesearch/shows?q=breaking`),
      respond: Response.json(rawShow({ _embedded: { nextepisode: rawEpisode({ id: 21 }) } })),
    });

    const result = await runToolContract(getNextEpisode, { by: 'title', title: 'breaking bad' });
    expect(result.structuredContent).toMatchObject({ found: true, next_episode: { id: 21 } });
  });

  it('reports a between-seasons miss carrying the previous episode, not an error', async () => {
    getHttp().route({
      match: `${TVMAZE_TEST_BASE_URL}/shows/169?${ID_EMBED_QS}`,
      respond: Response.json(
        rawShow({
          status: 'Running',
          ended: null,
          _embedded: { previousepisode: rawEpisode({ id: 19, name: 'Last One' }) },
        }),
      ),
    });

    const result = await runToolContract(getNextEpisode, { by: 'id', show_id: 169 });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      found: false,
      miss_reason: 'no_scheduled_episode',
      show: { id: 169 },
      previous_episode: { id: 19 },
      guidance: expect.stringContaining('has no episode on the schedule'),
    });
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain('**No scheduled episode**');
    expect(text).not.toContain('**Show not found**');
    expect(text).toContain('## Previously');
  });

  it('reports an unmatched title as a structured miss, not an error', async () => {
    getHttp().route({
      match: (req) => req.url.startsWith(`${TVMAZE_TEST_BASE_URL}/singlesearch/shows?q=`),
      respond: new Response('null', { status: 404 }),
    });

    const result = await runToolContract(getNextEpisode, {
      by: 'title',
      title: 'zzzz nonexistent',
    });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      found: false,
      miss_reason: 'show_not_found',
      guidance: expect.stringContaining('No show matched "zzzz nonexistent"'),
    });
    expect(result.structuredContent).not.toHaveProperty('show');
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain('**Show not found**');
    expect(text).not.toContain('**No scheduled episode**');
  });

  it('throws show_not_found_by_id for a bad id (a supplied id is the caller’s to fix)', async () => {
    getHttp().route({
      match: `${TVMAZE_TEST_BASE_URL}/shows/99999999?${ID_EMBED_QS}`,
      respond: new Response(tvmazeErrorBody('Not Found', '', 404), { status: 404 }),
    });

    const result = await runToolContract(getNextEpisode, { by: 'id', show_id: 99_999_999 });
    expect(result.isError).toBe(true);
    expect(errorEnvelope(result.structuredContent).error).toMatchObject({
      data: { reason: 'show_not_found_by_id' },
    });
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain('reason show_not_found_by_id');
  });

  it('produces invalid_timezone on both surfaces', async () => {
    const result = await runToolContract(getNextEpisode, {
      by: 'id',
      show_id: 169,
      timezone: 'Not/AZone',
    });
    expect(result.isError).toBe(true);
    expect(errorEnvelope(result.structuredContent).error).toMatchObject({
      data: { reason: 'invalid_timezone' },
    });
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain('reason invalid_timezone');
  });
});
