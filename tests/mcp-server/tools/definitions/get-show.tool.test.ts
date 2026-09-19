/**
 * @fileoverview Tests for tvmaze_get_show — full profile, seasons table,
 * next/previous episode blocks, the Running-with-no-next-episode notice, and
 * the show_not_found / invalid_timezone error contract.
 * @module tests/mcp-server/tools/definitions/get-show.tool.test
 */

import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { describe, expect, it } from 'vitest';

import { getShow } from '@/mcp-server/tools/definitions/get-show.tool.js';
import {
  rawEpisode,
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
const EMBED_QS = 'embed[]=nextepisode&embed[]=previousepisode&embed[]=seasons';

describe('tvmaze_get_show', () => {
  it('returns the full profile with seasons and next/previous episodes', async () => {
    getHttp().route({
      match: `${TVMAZE_TEST_BASE_URL}/shows/169?${EMBED_QS}`,
      respond: Response.json(
        rawShow({
          _embedded: {
            nextepisode: rawEpisode({ id: 20, name: 'Next Up' }),
            previousepisode: rawEpisode({ id: 19, name: 'Last One' }),
            seasons: [rawSeason(), rawSeason({ id: 2, number: 2 })],
          },
        }),
      ),
    });

    const result = await runToolContract(getShow, {
      show_id: 169,
      timezone: 'America/Los_Angeles',
    });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      show: { id: 169, name: 'Breaking Bad', schedule_days: ['Sunday'], schedule_time: '22:00' },
      seasons: [{ number: 1 }, { number: 2 }],
      next_episode: { id: 20, name: 'Next Up' },
      previous_episode: { id: 19, name: 'Last One' },
      timezone: 'America/Los_Angeles',
    });
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain('# Breaking Bad');
    expect(text).toContain('## Seasons');
    expect(text).toContain('## Next episode');
    expect(text).toContain('Next Up');
    expect(text).toContain('## Previous episode');
    expect(text).toContain('Last One');
  });

  it('renders an empty-row placeholder for a show with no seasons recorded', async () => {
    getHttp().route({
      match: `${TVMAZE_TEST_BASE_URL}/shows/169?${EMBED_QS}`,
      respond: Response.json(rawShow({ _embedded: { seasons: [] } })),
    });

    const result = await runToolContract(getShow, { show_id: 169 });
    expect(result.structuredContent).toMatchObject({ seasons: [] });
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain('Not available');
  });

  it('omits next_episode when the embed key is absent (Running mid-hiatus) and emits the notice', async () => {
    getHttp().route({
      match: `${TVMAZE_TEST_BASE_URL}/shows/169?${EMBED_QS}`,
      respond: Response.json(
        rawShow({
          status: 'Running',
          ended: null,
          _embedded: { previousepisode: rawEpisode(), seasons: [rawSeason()] },
        }),
      ),
    });

    const result = await runToolContract(getShow, { show_id: 169 });
    expect(result.structuredContent).not.toHaveProperty('next_episode');
    expect(result.structuredContent).toMatchObject({
      notice: expect.stringContaining('is listed as Running but has no scheduled next episode'),
    });
    const text = (result.content[0] as { text: string }).text;
    expect(text).not.toContain('## Next episode');
    expect(text).toContain('## Previous episode');
  });

  it('produces show_not_found on both surfaces for a bad id', async () => {
    getHttp().route({
      match: `${TVMAZE_TEST_BASE_URL}/shows/99999999?${EMBED_QS}`,
      respond: new Response(tvmazeErrorBody('Not Found', '', 404), { status: 404 }),
    });

    const result = await runToolContract(getShow, { show_id: 99_999_999 });
    expect(result.isError).toBe(true);
    expect(errorEnvelope(result.structuredContent).error).toMatchObject({
      data: { reason: 'show_not_found' },
    });
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain('reason show_not_found');
    expect(text).toContain('Call tvmaze_search_shows');
  });

  it('produces invalid_timezone on both surfaces for a bogus IANA zone shape', async () => {
    getHttp().route({
      match: `${TVMAZE_TEST_BASE_URL}/shows/169?${EMBED_QS}`,
      respond: Response.json(rawShow({ _embedded: { seasons: [] } })),
    });

    const result = await runToolContract(getShow, { show_id: 169, timezone: 'Fake/Zone' });
    expect(result.isError).toBe(true);
    expect(errorEnvelope(result.structuredContent).error).toMatchObject({
      data: { reason: 'invalid_timezone' },
    });
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain('reason invalid_timezone');
  });
});
