/**
 * @fileoverview Tests for tvmaze_get_cast — show-scope cast/crew (with the
 * differing cast vs crew shapes), episode-scope guest cast, zero-hit notices,
 * and the show_not_found / episode_not_found error contract.
 * @module tests/mcp-server/tools/definitions/get-cast.tool.test
 */

import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { encodeCursor } from '@cyanheads/mcp-ts-core/utils';
import { describe, expect, it } from 'vitest';

import { getCast } from '@/mcp-server/tools/definitions/get-cast.tool.js';
import {
  rawCastCredit,
  rawCastCredits,
  rawCrewCredit,
  rawCrewCredits,
  rawGuestCrewCredit,
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

  describe('paging (#3)', () => {
    type CastResult = {
      cast: Array<{ person_id: number }>;
      crew?: Array<{ person_id: number }>;
      next_cursor?: string;
      has_more: boolean;
    };
    const sc = (result: { structuredContent?: unknown }) => result.structuredContent as CastResult;
    const textOf = (result: { content: unknown[] }) =>
      result.content.map((block) => (block as { text: string }).text).join('\n');
    const personIds = (result: { structuredContent?: unknown }) => [
      ...sc(result).cast.map((credit) => credit.person_id),
      ...(sc(result).crew ?? []).map((credit) => credit.person_id),
    ];

    function routeShow(castCount: number, crewCount: number) {
      getHttp().route({
        match: `${TVMAZE_TEST_BASE_URL}/shows/169/cast`,
        respond: () => Response.json(rawCastCredits(castCount)),
      });
      getHttp().route({
        match: `${TVMAZE_TEST_BASE_URL}/shows/169/crew`,
        respond: () => Response.json(rawCrewCredits(crewCount)),
      });
    }

    it('returns the first 50 cast rows by default, with the full count and a next_cursor', async () => {
      routeShow(120, 0);
      const result = await runToolContract(getCast, { scope: 'show', show_id: 169 });
      expect(sc(result).cast).toHaveLength(50);
      expect(result.structuredContent).toMatchObject({
        has_more: true,
        next_cursor: expect.any(String),
        totalCount: 120,
        cast_total: 120,
        truncated: true,
        shown: 50,
        cap: 50,
      });
      const text = textOf(result);
      expect(text).toContain('**has_more:** true');
      expect(text).toContain(`**next_cursor:** ${sc(result).next_cursor}`);
      expect(text).toContain('**cast_total:** 120');
    });

    it('follows next_cursor to the end, returning every credit exactly once in upstream order', async () => {
      routeShow(120, 0);
      const seen: number[] = [];
      let cursor: string | undefined;
      let last: Awaited<ReturnType<typeof runToolContract>> | undefined;
      for (let call = 0; call < 5; call++) {
        last = await runToolContract(getCast, {
          scope: 'show',
          show_id: 169,
          ...(cursor ? { cursor } : {}),
        });
        seen.push(...personIds(last));
        cursor = sc(last).next_cursor;
        if (!cursor) break;
      }
      expect(seen).toEqual(Array.from({ length: 120 }, (_, index) => index + 1));
      expect(last?.structuredContent).toMatchObject({ has_more: false });
      expect(last?.structuredContent).not.toHaveProperty('next_cursor');
      expect(last?.structuredContent).not.toHaveProperty('truncated');
    });

    it('pages cast then crew as one sequence, splitting each page back into cast and crew', async () => {
      routeShow(7, 5);
      const input = { scope: 'show' as const, show_id: 169, include_crew: true, limit: 4 };

      const page1 = await runToolContract(getCast, input);
      expect(personIds(page1)).toEqual([1, 2, 3, 4]);
      expect(sc(page1).crew).toEqual([]);
      expect(page1.structuredContent).toMatchObject({
        totalCount: 12,
        cast_total: 7,
        crew_total: 5,
        has_more: true,
      });
      // Crew rows follow on a later page, so this page must not call crew unavailable.
      const text1 = textOf(page1);
      expect(text1).toContain('## Crew');
      expect(text1).not.toMatch(/## Crew\nNot available/);
      expect(text1).toContain('None on this page');

      const page2 = await runToolContract(getCast, {
        ...input,
        cursor: sc(page1).next_cursor,
      });
      // The boundary page carries the tail of cast and the head of crew.
      expect(sc(page2).cast.map((credit) => credit.person_id)).toEqual([5, 6, 7]);
      expect(sc(page2).crew?.map((credit) => credit.person_id)).toEqual([1000]);

      const page3 = await runToolContract(getCast, {
        ...input,
        cursor: sc(page2).next_cursor,
      });
      expect(sc(page3).cast).toEqual([]);
      expect(sc(page3).crew?.map((credit) => credit.person_id)).toEqual([1001, 1002, 1003, 1004]);
      expect(page3.structuredContent).toMatchObject({ has_more: false });
      // Cast rows were on earlier pages — not "unavailable" either.
      expect(textOf(page3)).not.toMatch(/## Cast\nNot available/);

      expect([...personIds(page1), ...personIds(page2), ...personIds(page3)]).toEqual([
        1, 2, 3, 4, 5, 6, 7, 1000, 1001, 1002, 1003, 1004,
      ]);
    });

    it('takes the page size from the current limit on a cursor call', async () => {
      routeShow(30, 0);
      const page1 = await runToolContract(getCast, { scope: 'show', show_id: 169, limit: 3 });
      const page2 = await runToolContract(getCast, {
        scope: 'show',
        show_id: 169,
        limit: 10,
        cursor: sc(page1).next_cursor,
      });
      expect(personIds(page2)).toEqual([4, 5, 6, 7, 8, 9, 10, 11, 12, 13]);
      expect(page2.structuredContent).toMatchObject({ shown: 10, cap: 10 });
    });

    it('pages scope "episode" the same way', async () => {
      getHttp().route({
        match: `${TVMAZE_TEST_BASE_URL}/episodes/11/guestcast`,
        respond: () => Response.json(rawCastCredits(6)),
      });
      const page1 = await runToolContract(getCast, { scope: 'episode', episode_id: 11, limit: 4 });
      expect(personIds(page1)).toEqual([1, 2, 3, 4]);
      expect(page1.structuredContent).toMatchObject({ has_more: true, shown: 4, cap: 4 });
      const page2 = await runToolContract(getCast, {
        scope: 'episode',
        episode_id: 11,
        limit: 4,
        cursor: sc(page1).next_cursor,
      });
      expect(personIds(page2)).toEqual([5, 6]);
      expect(page2.structuredContent).toMatchObject({ has_more: false });
    });

    it('returns an empty page for a cursor past the end', async () => {
      routeShow(3, 0);
      const result = await runToolContract(getCast, {
        scope: 'show',
        show_id: 169,
        cursor: encodeCursor({ offset: 500, limit: 50 }),
      });
      expect(result.isError).toBeFalsy();
      expect(result.structuredContent).toMatchObject({ cast: [], has_more: false, totalCount: 3 });
      expect(textOf(result)).not.toMatch(/## Cast\nNot available/);
    });

    it('rejects a limit outside 1–250', async () => {
      routeShow(3, 0);
      for (const limit of [0, 251]) {
        const result = await runToolContract(getCast, { scope: 'show', show_id: 169, limit });
        expect(result.isError).toBe(true);
        expect((result.content[0] as { text: string }).text).toContain('limit');
      }
      expect(getHttp().calls).toHaveLength(0);
    });

    it('keeps the zero-credit notice and sets no truncation fields for a show with no cast', async () => {
      routeShow(0, 0);
      const result = await runToolContract(getCast, { scope: 'show', show_id: 169 });
      expect(result.structuredContent).toMatchObject({
        cast: [],
        has_more: false,
        totalCount: 0,
        notice: expect.stringContaining('No cast is recorded for this show'),
      });
      expect(result.structuredContent).not.toHaveProperty('truncated');
    });
  });

  describe('episode guest crew (#11)', () => {
    const embedUrl = `${TVMAZE_TEST_BASE_URL}/episodes/11?embed[]=guestcast&embed[]=guestcrew`;

    it('returns guest cast and guest crew from one embed request when include_crew is set', async () => {
      getHttp().route({
        match: embedUrl,
        respond: Response.json({
          id: 11,
          _embedded: {
            guestcast: rawCastCredits(2),
            guestcrew: [
              rawGuestCrewCredit(),
              rawGuestCrewCredit({
                guestCrewType: 'Writer',
                person: {
                  id: 169_453,
                  url: 'https://www.tvmaze.com/people/169453/dan-erickson',
                  name: 'Dan Erickson',
                  image: null,
                },
              }),
            ],
          },
        }),
      });

      const result = await runToolContract(getCast, {
        scope: 'episode',
        episode_id: 11,
        include_crew: true,
      });
      expect(result.isError).toBeFalsy();
      expect(result.structuredContent).toMatchObject({
        cast: [{ person_id: 1 }, { person_id: 2 }],
        crew: [
          { person_name: 'Ben Stiller', credit_type: 'Director' },
          { person_name: 'Dan Erickson', credit_type: 'Writer' },
        ],
        scope: 'episode',
        totalCount: 4,
        crew_total: 2,
      });
      for (const row of (result.structuredContent as { crew: object[] }).crew) {
        expect(row).not.toHaveProperty('character_name');
        expect(row).not.toHaveProperty('as_self');
        expect(row).not.toHaveProperty('voice_only');
      }
      const text = (result.content[0] as { text: string }).text;
      expect(text).toContain('## Crew');
      expect(text).toContain('Ben Stiller');
      expect(text).toContain('**credit_type:** Director');
      expect(getHttp().calls.map((call) => call.request.url)).toEqual([embedUrl]);
    });

    it('renders an empty guest crew as not available', async () => {
      getHttp().route({
        match: embedUrl,
        respond: Response.json({
          id: 11,
          _embedded: { guestcast: rawCastCredits(3), guestcrew: [] },
        }),
      });
      const result = await runToolContract(getCast, {
        scope: 'episode',
        episode_id: 11,
        include_crew: true,
      });
      expect(result.structuredContent).toMatchObject({ crew: [], crew_total: 0, totalCount: 3 });
      expect((result.content[0] as { text: string }).text).toContain('## Crew\nNot available');
    });

    it('makes the single /guestcast request and returns no crew key without include_crew', async () => {
      getHttp().route({
        match: `${TVMAZE_TEST_BASE_URL}/episodes/11/guestcast`,
        respond: Response.json(rawCastCredits(1)),
      });
      const result = await runToolContract(getCast, { scope: 'episode', episode_id: 11 });
      expect(result.structuredContent).not.toHaveProperty('crew');
      expect(result.structuredContent).not.toHaveProperty('crew_total');
      expect(getHttp().calls.map((call) => call.request.url)).toEqual([
        `${TVMAZE_TEST_BASE_URL}/episodes/11/guestcast`,
      ]);
    });

    it('produces episode_not_found for a bad episode id with include_crew', async () => {
      getHttp().route({
        match: `${TVMAZE_TEST_BASE_URL}/episodes/99999999?embed[]=guestcast&embed[]=guestcrew`,
        respond: new Response(tvmazeErrorBody('Not Found', '', 404), { status: 404 }),
      });
      const result = await runToolContract(getCast, {
        scope: 'episode',
        episode_id: 99_999_999,
        include_crew: true,
      });
      expect(result.isError).toBe(true);
      expect(errorEnvelope(result.structuredContent).error).toMatchObject({
        data: { reason: 'episode_not_found' },
      });
    });

    it('pages guest crew after guest cast in one sequence', async () => {
      getHttp().route({
        match: embedUrl,
        respond: () =>
          Response.json({
            id: 11,
            _embedded: {
              guestcast: rawCastCredits(3),
              guestcrew: [
                rawGuestCrewCredit({ person: { id: 900, url: 'https://x/900', name: 'D' } }),
                rawGuestCrewCredit({
                  guestCrewType: 'Writer',
                  person: { id: 901, url: 'https://x/901', name: 'W' },
                }),
              ],
            },
          }),
      });
      const input = { scope: 'episode' as const, episode_id: 11, include_crew: true, limit: 2 };
      const page1 = await runToolContract(getCast, input);
      const page2 = await runToolContract(getCast, {
        ...input,
        cursor: (page1.structuredContent as { next_cursor: string }).next_cursor,
      });
      const page3 = await runToolContract(getCast, {
        ...input,
        cursor: (page2.structuredContent as { next_cursor: string }).next_cursor,
      });
      const ids = [page1, page2, page3].flatMap((page) => {
        const body = page.structuredContent as {
          cast: Array<{ person_id: number }>;
          crew: Array<{ person_id: number }>;
        };
        return [...body.cast, ...body.crew].map((credit) => credit.person_id);
      });
      expect(ids).toEqual([1, 2, 3, 900, 901]);
      expect(page2.structuredContent).toMatchObject({
        cast: [{ person_id: 3 }],
        crew: [{ person_id: 900, credit_type: 'Director' }],
      });
    });
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
