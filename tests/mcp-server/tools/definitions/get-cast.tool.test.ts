/**
 * @fileoverview Tests for tvmaze_get_cast — show-scope cast/crew (with the
 * differing cast vs crew shapes), episode-scope guest cast, zero-hit notices,
 * and the show_not_found / episode_not_found error contract.
 * @module tests/mcp-server/tools/definitions/get-cast.tool.test
 */

import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { describe, expect, it } from 'vitest';

import { getCast } from '@/mcp-server/tools/definitions/get-cast.tool.js';
import {
  rawCastCredit,
  rawCrewCredit,
  tvmazeErrorBody,
} from '../../../fixtures/tvmaze-fixtures.js';
import { errorEnvelope } from '../../../helpers/error-envelope.js';
import {
  installTvmazeToolHarness,
  TVMAZE_TEST_BASE_URL,
} from '../../../helpers/tvmaze-tool-harness.js';

const getHttp = installTvmazeToolHarness();

describe('tvmaze_get_cast', () => {
  it('lists the main cast for scope "show" without crew by default', async () => {
    getHttp().route({
      match: `${TVMAZE_TEST_BASE_URL}/shows/169/cast`,
      respond: Response.json([rawCastCredit()]),
    });

    const result = await runToolContract(getCast, { scope: 'show', show_id: 169 });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      cast: [{ person_name: 'Bryan Cranston', character_name: 'Walter White' }],
      scope: 'show',
      subject_id: 169,
      totalCount: 1,
    });
    expect(result.structuredContent).not.toHaveProperty('crew');
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain('## Cast');
    expect(text).toContain('Bryan Cranston');
    expect(text).not.toContain('## Crew');
  });

  it('includes crew (different shape: no character/self/voice) when include_crew is set', async () => {
    getHttp().route({
      match: `${TVMAZE_TEST_BASE_URL}/shows/169/cast`,
      respond: Response.json([rawCastCredit()]),
    });
    getHttp().route({
      match: `${TVMAZE_TEST_BASE_URL}/shows/169/crew`,
      respond: Response.json([rawCrewCredit()]),
    });

    const result = await runToolContract(getCast, {
      scope: 'show',
      show_id: 169,
      include_crew: true,
    });
    expect(result.structuredContent).toMatchObject({
      cast: [{ person_name: 'Bryan Cranston' }],
      crew: [{ person_name: 'Vince Gilligan', credit_type: 'Executive Producer' }],
      totalCount: 2,
    });
    const crewRow = (result.structuredContent as { crew: Array<Record<string, unknown>> }).crew[0];
    expect(crewRow).not.toHaveProperty('character_name');
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain('## Crew');
    expect(text).toContain('Vince Gilligan');
  });

  it('lists an episode’s guest cast for scope "episode"', async () => {
    getHttp().route({
      match: `${TVMAZE_TEST_BASE_URL}/episodes/11/guestcast`,
      respond: Response.json([
        rawCastCredit({ person: { id: 9, url: 'https://x', name: 'Guest Star' } }),
      ]),
    });

    const result = await runToolContract(getCast, { scope: 'episode', episode_id: 11 });
    expect(result.structuredContent).toMatchObject({
      cast: [{ person_name: 'Guest Star' }],
      scope: 'episode',
      subject_id: 11,
    });
  });

  it('emits a zero-hit notice for scope "show" with no cast recorded', async () => {
    getHttp().route({
      match: `${TVMAZE_TEST_BASE_URL}/shows/169/cast`,
      respond: Response.json([]),
    });

    const result = await runToolContract(getCast, { scope: 'show', show_id: 169 });
    expect(result.structuredContent).toMatchObject({
      cast: [],
      notice: expect.stringContaining('No cast is recorded for this show'),
    });
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain('## Cast\nNot available');
  });

  it('emits a zero-hit notice for scope "episode" with no guest cast recorded', async () => {
    getHttp().route({
      match: `${TVMAZE_TEST_BASE_URL}/episodes/11/guestcast`,
      respond: Response.json([]),
    });

    const result = await runToolContract(getCast, { scope: 'episode', episode_id: 11 });
    expect(result.structuredContent).toMatchObject({
      cast: [],
      notice: expect.stringContaining('No guest cast is recorded for this episode'),
    });
  });

  it('produces show_not_found on both surfaces for a bad show id', async () => {
    getHttp().route({
      match: `${TVMAZE_TEST_BASE_URL}/shows/99999999/cast`,
      respond: new Response(tvmazeErrorBody('Not Found', '', 404), { status: 404 }),
    });

    const result = await runToolContract(getCast, { scope: 'show', show_id: 99_999_999 });
    expect(result.isError).toBe(true);
    expect(errorEnvelope(result.structuredContent).error).toMatchObject({
      data: { reason: 'show_not_found' },
    });
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain('reason show_not_found');
  });

  it('produces episode_not_found on both surfaces for a bad episode id', async () => {
    getHttp().route({
      match: `${TVMAZE_TEST_BASE_URL}/episodes/99999999/guestcast`,
      respond: new Response(tvmazeErrorBody('Not Found', '', 404), { status: 404 }),
    });

    const result = await runToolContract(getCast, { scope: 'episode', episode_id: 99_999_999 });
    expect(result.isError).toBe(true);
    expect(errorEnvelope(result.structuredContent).error).toMatchObject({
      data: { reason: 'episode_not_found' },
    });
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain('reason episode_not_found');
  });
});
