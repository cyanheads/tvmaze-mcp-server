/**
 * @fileoverview Person search, compact embedded credit projections, paging and errors.
 * @module tests/mcp-server/tools/definitions/get-person.tool.test
 */
import { z } from '@cyanheads/mcp-ts-core';
import { createMockContext, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { encodeCursor } from '@cyanheads/mcp-ts-core/utils';
import { describe, expect, it, vi } from 'vitest';
import { getPerson } from '@/mcp-server/tools/definitions/get-person.tool.js';
import { getTvmazeService } from '@/services/tvmaze/tvmaze-service.js';
import { rawEpisode, rawShow } from '../../../fixtures/tvmaze-fixtures.js';
import { errorEnvelope } from '../../../helpers/error-envelope.js';
import {
  TVMAZE_TEST_BASE_URL as BASE,
  installTvmazeToolHarness,
} from '../../../helpers/tvmaze-tool-harness.js';

const getHttp = installTvmazeToolHarness();
const person = {
  id: 1,
  name: 'Mike Vogel',
  url: 'https://www.tvmaze.com/people/1/mike-vogel',
  birthday: '1979-07-17',
  country: { name: 'United States' },
};
const character = {
  id: 1,
  name: 'Dale "Barbie" Barbara',
  url: 'https://www.tvmaze.com/characters/1/under-the-dome-dale-barbie-barbara',
};
const textOf = (result: { content: unknown[] }) =>
  result.content.map((block) => (block as { text: string }).text).join('\n');

describe('tvmaze_get_person', () => {
  it('keeps guest link parsing bounded across 64 times the input length', async () => {
    let href = '';
    getHttp().route({
      match: `${BASE}/people/1/guestcastcredits?embed[]=episode&embed[]=character`,
      respond: () =>
        Response.json([
          { _embedded: { episode: { ...rawEpisode(), _links: { show: { href } } } } },
        ]),
    });
    const measure = async (length: number) => {
      href = `https://api.tvmaze.com/shows/${'9'.repeat(length)}`;
      const start = process.threadCpuUsage();
      const result = await getTvmazeService().getPersonCredits(1, 'guest', createMockContext());
      const elapsed = process.threadCpuUsage(start);
      expect(result[0]).not.toHaveProperty('show_id');
      return elapsed.user + elapsed.system;
    };
    await measure(5_000);
    const small = await measure(5_000);
    await measure(20_000);
    await measure(80_000);
    const large = await measure(320_000);
    expect(large / Math.max(small, 1)).toBeLessThan(256);
    expect(large).toBeLessThan(2_000_000);
  });
  it('retains cancellation without starting a credit request', async () => {
    const controller = new AbortController();
    getHttp().route({
      match: `${BASE}/people/1`,
      respond: () => {
        controller.abort();
        return Response.json(person);
      },
    });
    const result = await runToolContract(
      getPerson,
      { person_id: 1 },
      { context: { signal: controller.signal } },
    );
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/cancel|abort/i);
    expect(getHttp().calls).toHaveLength(1);
  });
  it.each([
    ['https://api.tvmaze.com/shows/195', 195],
    [`${BASE}/shows/195`, 195],
    ['https://api.tvmaze.com.evil.test/shows/195', undefined],
    ['https://user@api.tvmaze.com/shows/195', undefined],
    ['https://api.tvmaze.com/shows/195/extra', undefined],
    ['https://api.tvmaze.com/shows/0', undefined],
    ['not a URL', undefined],
  ])('projects only a trusted exact guest show link: %s', async (href, expected) => {
    getHttp().route({ match: `${BASE}/people/1`, respond: Response.json(person) });
    getHttp().route({
      match: `${BASE}/people/1/guestcastcredits?embed[]=episode&embed[]=character`,
      respond: Response.json([
        {
          _embedded: {
            episode: { ...rawEpisode(), _links: { show: { href, name: 'Bates Motel' } } },
          },
        },
      ]),
    });
    const result = await runToolContract(getPerson, { person_id: 1, credit_kind: 'guest' });
    expect(result.isError).toBeFalsy();
    expect(
      (result.structuredContent as { credits: Array<{ show_id?: number }> }).credits[0]?.show_id,
    ).toBe(expected);
    expect(getHttp().calls).toHaveLength(2);
  });

  it('uses the selected input id for credits rather than a response-controlled path', async () => {
    getHttp().route({ match: `${BASE}/people/1`, respond: Response.json({ ...person, id: 999 }) });
    getHttp().route({
      match: `${BASE}/people/1/castcredits?embed[]=show&embed[]=character`,
      respond: Response.json([]),
    });
    const result = await runToolContract(getPerson, { person_id: 1 });
    expect(result.isError).toBeFalsy();
    expect(getHttp().calls.map((call) => call.request.url)).toEqual([
      `${BASE}/people/1`,
      `${BASE}/people/1/castcredits?embed[]=show&embed[]=character`,
    ]);
  });

  it('clamps a full credit page and continues with the current call limit', async () => {
    getHttp().route({ match: `${BASE}/people/1`, respond: () => Response.json(person) });
    getHttp().route({
      match: `${BASE}/people/1/castcredits?embed[]=show&embed[]=character`,
      respond: () =>
        Response.json(
          Array.from({ length: 300 }, (_, index) => ({
            _embedded: { show: rawShow({ id: index + 1 }) },
          })),
        ),
    });
    const first = await runToolContract(getPerson, { person_id: 1, limit: 500 });
    expect(first.structuredContent).toMatchObject({
      shown: 250,
      cap: 250,
      totalCount: 300,
      has_more: true,
    });
    const next = await runToolContract(getPerson, {
      person_id: 1,
      limit: 3,
      cursor: (first.structuredContent as { next_cursor: string }).next_cursor,
    });
    expect(next.structuredContent).toMatchObject({
      credits: [{ show_id: 251 }, { show_id: 252 }, { show_id: 253 }],
      shown: 3,
      cap: 3,
    });
  });

  it('maps search retry exhaustion and recovery on both surfaces', async () => {
    getHttp().route({
      match: `${BASE}/search/people?q=Mike`,
      respond: () => new Response('Unavailable', { status: 503 }),
    });
    vi.useFakeTimers();
    try {
      const pending = runToolContract(getPerson, { query: 'Mike' });
      await vi.advanceTimersByTimeAsync(35_000);
      const result = await pending;
      expect(errorEnvelope(result.structuredContent).error).toMatchObject({
        data: {
          reason: 'person_search_unavailable',
          retryable: true,
          recovery: { hint: expect.stringContaining('Wait') },
        },
      });
      expect(textOf(result)).toContain('person_search_unavailable');
      expect(getHttp().calls.length).toBeGreaterThan(1);
    } finally {
      vi.useRealTimers();
    }
  });
  it.each([0, 1, 2, 10])('returns %i candidates without selecting one', async (count) => {
    getHttp().route({
      match: `${BASE}/search/people?q=Mike`,
      respond: Response.json(
        Array.from({ length: count }, (_, i) => ({
          score: 1 / (i + 1),
          person: { ...person, id: i + 1 },
        })),
      ),
    });
    const result = await runToolContract(getPerson, { query: ' Mike ' });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      kind: 'search',
      totalCount: count,
      effectiveQuery: 'Mike',
    });
    expect(result.structuredContent).not.toHaveProperty('person');
    const body = result.structuredContent as { candidates: unknown[]; notice: string };
    expect(body.candidates).toHaveLength(count);
    expect(textOf(result)).toContain(count ? 'Mike Vogel' : 'No person matched');
    if (count === 10) expect(body.notice).toContain('may have capped');
    expect(getHttp().calls).toHaveLength(1);
  });

  it.each(['cast', 'guest', 'crew'] as const)(
    'projects %s embeds without hydration, including sparse rows',
    async (kind) => {
      const route =
        kind === 'guest'
          ? 'guestcastcredits?embed[]=episode&embed[]=character'
          : kind === 'crew'
            ? 'crewcredits?embed[]=show'
            : 'castcredits?embed[]=show&embed[]=character';
      const embedded =
        kind === 'guest'
          ? {
              episode: {
                ...rawEpisode(),
                _links: { show: { href: 'https://api.tvmaze.com/shows/195', name: 'Bates Motel' } },
              },
              character,
            }
          : { show: rawShow(), ...(kind === 'cast' ? { character } : {}) };
      getHttp().route({ match: `${BASE}/people/1`, respond: () => Response.json(person) });
      getHttp().route({
        match: `${BASE}/people/1/${route}`,
        respond: () =>
          Response.json([
            {
              _embedded: embedded,
              self: false,
              voice: true,
              ...(kind === 'crew' ? { type: 'Co-Executive Producer' } : {}),
            },
            {},
            { _embedded: embedded },
          ]),
      });
      const first = await runToolContract(getPerson, { person_id: 1, credit_kind: kind, limit: 1 });
      expect(first.structuredContent).toMatchObject({
        kind: 'person',
        person: { id: 1 },
        credit_kind: kind,
        totalCount: 3,
        has_more: true,
      });
      const body = first.structuredContent as {
        credits: Record<string, unknown>[];
        next_cursor: string;
      };
      expect(body.credits[0]).not.toHaveProperty('summary');
      expect(body.credits[0]).toMatchObject({ show_id: kind === 'guest' ? 195 : 169 });
      if (kind === 'guest')
        expect(body.credits[0]).toMatchObject({
          episode_id: 11,
          show_url: 'https://www.tvmaze.com/shows/195',
        });
      expect(textOf(first)).toContain('**show_id:**');
      const next = await runToolContract(getPerson, {
        person_id: 1,
        credit_kind: kind,
        cursor: body.next_cursor,
        limit: 500,
      });
      expect(next.structuredContent).toMatchObject({
        credits: [{}, expect.any(Object)],
        shown: 2,
        cap: 250,
        has_more: false,
      });
      expect(textOf(next)).toContain('returned 2 credits');
      const past = await runToolContract(getPerson, {
        person_id: 1,
        credit_kind: kind,
        cursor: encodeCursor({ offset: 10, limit: 1 }),
        limit: 500,
      });
      expect(past.structuredContent).toMatchObject({
        credits: [],
        totalCount: 3,
        shown: 0,
        has_more: false,
      });
      expect((past.structuredContent as { notice: string }).notice).not.toContain('No ');
      expect(getHttp().calls).toHaveLength(6);
    },
  );

  it('accepts blank query with an id and returns empty credits honestly', async () => {
    getHttp().route({
      match: `${BASE}/people/1`,
      respond: Response.json({ id: 1, name: 'Sparse', url: person.url }),
    });
    getHttp().route({
      match: `${BASE}/people/1/castcredits?embed[]=show&embed[]=character`,
      respond: Response.json([]),
    });
    const result = await runToolContract(getPerson, { query: ' ', person_id: 1, limit: 500 });
    expect(result.structuredContent).toMatchObject({
      person: { name: 'Sparse' },
      credits: [],
      totalCount: 0,
      shown: 0,
      cap: 250,
    });
    expect(textOf(result)).toContain('No cast credits');
  });

  it('returns person_not_found and recovery on both surfaces without fetching credits', async () => {
    getHttp().route({
      match: `${BASE}/people/999`,
      respond: new Response('null', { status: 404 }),
    });
    const result = await runToolContract(getPerson, { person_id: 999 });
    expect(errorEnvelope(result.structuredContent).error).toMatchObject({
      data: { reason: 'person_not_found', recovery: { hint: expect.stringContaining('query') } },
    });
    expect(textOf(result)).toContain('person_not_found');
    expect(getHttp().calls).toHaveLength(1);
  });

  it.each([
    {},
    { query: ' ' },
    { query: 'Mike', person_id: 1 },
    { query: 'Mike', credit_kind: 'cast' as const },
    { query: 'Mike', limit: 50 },
    { query: 'Mike', cursor: '' },
    { person_id: 0 },
    { person_id: 1, limit: 0 },
    { person_id: 1, limit: 1.5 },
  ])('rejects invalid selection %j before fetching', async (input) => {
    const result = await runToolContract(getPerson, input);
    expect(result.isError).toBe(true);
    expect(getHttp().calls).toHaveLength(0);
  });

  it('advertises one flat serializable input object', () => {
    const schema = z.toJSONSchema(getPerson.input);
    expect(schema.type).toBe('object');
    expect(schema).not.toHaveProperty('oneOf');
  });
});
