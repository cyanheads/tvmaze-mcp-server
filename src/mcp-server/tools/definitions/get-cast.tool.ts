/**
 * @fileoverview tvmaze_get_cast — a show's credited cast (optionally with crew),
 * or the guest cast of one episode (optionally with its guest crew). Cast and
 * crew page together as one sequence, cast first.
 * @module mcp-server/tools/definitions/get-cast.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';

import { getTvmazeService } from '@/services/tvmaze/tvmaze-service.js';
import type { CastCredit as CastCreditShape } from '@/services/tvmaze/types.js';
import { DEFAULT_PAGE_SIZE, enrichPage, MAX_PAGE_SIZE, pageOf } from './paging.js';
import { CastCredit, castCreditLines, field, NOT_AVAILABLE } from './shared-schemas.js';

/** Paging inputs shared by both scopes. */
const pagingInput = {
  limit: z
    .number()
    .int()
    .min(1)
    .max(MAX_PAGE_SIZE)
    .default(DEFAULT_PAGE_SIZE)
    .describe(
      'Maximum credits to return in this call, cast and crew together. Applies to every page, including a call that passes cursor. A long-running series carries over a thousand cast credits.',
    ),
  cursor: z
    .string()
    .optional()
    .describe(
      'Continuation token from a previous call’s next_cursor. It carries only the position to resume from; the page size comes from limit. Omit for the first page.',
    ),
};

/**
 * What an empty credit list on this page renders as. `Not available` only when
 * the list is empty across every page — cast precedes crew in the sequence, so
 * a page can hold none of a list whose rows sit on other pages.
 */
function emptyListLine(total: number): string {
  return total === 0
    ? NOT_AVAILABLE
    : `None on this page — ${total} in total, on other pages of this sequence.`;
}

export const getCast = tool('tvmaze_get_cast', {
  description:
    'List the credited cast of a show with the characters they play, optionally with crew; or list the guest cast of one episode, optionally with its guest crew such as the director and writers. Results are paged: cast rows come first, then crew rows, and each page splits them back into cast and crew. The source records no recurring-versus-guest distinction on a show’s cast list, so a name’s absence from it does not mean the performer never appeared — check an episode’s guest cast for that.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },

  errors: [
    {
      reason: 'show_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'No show exists with the given TVmaze id.',
      recovery:
        'Call tvmaze_search_shows with the show title to find a valid TVmaze id, then call tvmaze_get_cast again.',
    },
    {
      reason: 'episode_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'No episode exists with the given TVmaze id.',
      recovery:
        'Call tvmaze_get_episodes for the show to find a valid episode id, then call tvmaze_get_cast again.',
    },
  ],

  input: z.discriminatedUnion('scope', [
    z.object({
      scope: z.literal('show').describe('List the show’s main cast.'),
      show_id: z
        .number()
        .int()
        .positive()
        .describe(
          'TVmaze show id, from tvmaze_search_shows, tvmaze_lookup_show, or tvmaze_get_schedule.',
        ),
      include_crew: z
        .boolean()
        .default(false)
        .describe(
          'Also list the show’s crew credits — producers, creators, and other series-level roles, with no episode attribution. Off by default; a long-running series carries hundreds and they are rarely what a cast question is asking for.',
        ),
      ...pagingInput,
    }),
    z.object({
      scope: z.literal('episode').describe('List one episode’s guest cast.'),
      episode_id: z
        .number()
        .int()
        .positive()
        .describe(
          'TVmaze episode id, from tvmaze_get_episodes, tvmaze_get_next_episode, tvmaze_get_schedule, or tvmaze_get_show.',
        ),
      include_crew: z
        .boolean()
        .default(false)
        .describe(
          'Also list the episode’s guest crew — who directed and wrote it, as TVmaze credits them. Off by default.',
        ),
      ...pagingInput,
    }),
  ]),

  output: z.object({
    cast: z
      .array(CastCredit.describe('One cast credit.'))
      .describe(
        'Cast credits on this page — for scope "show", the main cast; for scope "episode", that episode’s guest cast. Empty on a page past the last cast row.',
      ),
    crew: z
      .array(CastCredit.describe('One crew credit.'))
      .optional()
      .describe(
        'Crew credits on this page — for scope "show", the show’s crew; for scope "episode", that episode’s guest crew. Present, possibly empty, whenever include_crew was set; crew rows follow every cast row, so a page that ends inside the cast carries none.',
      ),
    cast_total: z.number().describe('Cast credits across every page.'),
    crew_total: z
      .number()
      .optional()
      .describe('Crew credits across every page. Present when include_crew was set.'),
    scope: z.enum(['show', 'episode']).describe('Which credit list was returned.'),
    subject_id: z
      .number()
      .describe('TVmaze id the credits belong to — a show id or an episode id, matching scope.'),
    next_cursor: z
      .string()
      .optional()
      .describe('Pass as cursor to fetch the next page. Absent on the last page.'),
    has_more: z.boolean().describe('True when more credits remain beyond this page.'),
  }),

  enrichment: {
    totalCount: z.number().describe('Credits across every page, cast plus crew.'),
    truncated: z.boolean().optional().describe('True when the page limit was reached.'),
    shown: z.number().optional().describe('Number of credits returned on this page.'),
    cap: z.number().optional().describe('The page size applied to this call — its limit.'),
    notice: z
      .string()
      .optional()
      .describe(
        'Guidance when the page was truncated, or when no cast is recorded — every one that applies, joined. Absent otherwise.',
      ),
  },

  async handler(input, ctx) {
    const service = getTvmazeService();

    let cast: CastCreditShape[];
    let crew: CastCreditShape[] | undefined;
    let subjectId: number;
    const fragments: string[] = [];

    if (input.scope === 'show') {
      const [showCast, showCrew] = await Promise.all([
        service.getShowCast(input.show_id, ctx),
        input.include_crew ? service.getShowCrew(input.show_id, ctx) : Promise.resolve(null),
      ]);
      if (showCast === null) {
        throw ctx.fail('show_not_found', `No TVmaze show has id ${input.show_id}.`, {
          show_id: input.show_id,
          ...ctx.recoveryFor('show_not_found'),
        });
      }
      cast = showCast;
      crew = input.include_crew ? (showCrew ?? []) : undefined;
      subjectId = input.show_id;
      if (cast.length === 0) {
        fragments.push(
          'No cast is recorded for this show. TVmaze is community-maintained and credits are often missing on smaller titles; call tvmaze_get_cast with scope "episode" on a specific episode for its guest cast.',
        );
      }
    } else {
      // One request either way: the embed form only when crew was asked for.
      const credits = input.include_crew
        ? await service.getEpisodeCredits(input.episode_id, ctx)
        : await service.getEpisodeGuestCast(input.episode_id, ctx);
      if (credits === null) {
        throw ctx.fail('episode_not_found', `No TVmaze episode has id ${input.episode_id}.`, {
          episode_id: input.episode_id,
          ...ctx.recoveryFor('episode_not_found'),
        });
      }
      cast = Array.isArray(credits) ? credits : credits.cast;
      crew = Array.isArray(credits) ? undefined : credits.crew;
      subjectId = input.episode_id;
      if (cast.length === 0) {
        fragments.push(
          'No guest cast is recorded for this episode. Call tvmaze_get_cast with scope "show" for the main cast.',
        );
      }
    }

    // Cast then crew as one sequence; the split point on this page is wherever
    // the cast ends, clamped to the page.
    const page = pageOf([...cast, ...(crew ?? [])], input.cursor, input.limit, ctx);
    const castEnd = Math.min(Math.max(cast.length - page.offset, 0), page.items.length);

    ctx.log.info('Credits fetched', {
      scope: input.scope,
      subjectId,
      cast: cast.length,
      crew: crew?.length ?? 0,
      returned: page.items.length,
    });
    enrichPage(ctx, page, 'credits', fragments);

    return {
      cast: page.items.slice(0, castEnd),
      ...(crew ? { crew: page.items.slice(castEnd) } : {}),
      cast_total: cast.length,
      ...(crew ? { crew_total: crew.length } : {}),
      scope: input.scope,
      subject_id: subjectId,
      ...(page.nextCursor ? { next_cursor: page.nextCursor } : {}),
      has_more: page.nextCursor !== undefined,
    };
  },

  format: (result) => {
    const lines: string[] = [
      `${field('scope', result.scope)} | ${field('subject_id', result.subject_id)}`,
      `${field('cast_total', result.cast_total)} | ${field('crew_total', result.crew_total)}`,
      '',
      '## Cast',
    ];
    if (result.cast.length === 0) lines.push(emptyListLine(result.cast_total));
    for (const credit of result.cast) lines.push('', ...castCreditLines(credit));

    if (result.crew) {
      lines.push('', '## Crew');
      if (result.crew.length === 0) lines.push(emptyListLine(result.crew_total ?? 0));
      for (const credit of result.crew) lines.push('', ...castCreditLines(credit));
    }

    lines.push(
      '',
      `${field('has_more', result.has_more)} | ${field('next_cursor', result.next_cursor)}`,
    );
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
