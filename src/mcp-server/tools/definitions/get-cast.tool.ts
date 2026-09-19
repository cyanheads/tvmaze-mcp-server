/**
 * @fileoverview tvmaze_get_cast — a show's credited cast (optionally with crew),
 * or the guest cast of one episode.
 * @module mcp-server/tools/definitions/get-cast.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';

import { getTvmazeService } from '@/services/tvmaze/tvmaze-service.js';
import { CastCredit, castCreditLines, field, NOT_AVAILABLE } from './shared-schemas.js';

export const getCast = tool('tvmaze_get_cast', {
  description:
    'List the credited cast of a show with the characters they play, optionally with crew; or list the guest cast of one episode. The source records no recurring-versus-guest distinction on a show’s cast list, so a name’s absence from it does not mean the performer never appeared — check an episode’s guest cast for that.',
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
          'Also list crew credits — producers, writers, directors. Off by default; a long-running series carries dozens and they are rarely what a cast question is asking for.',
        ),
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
    }),
  ]),

  output: z.object({
    cast: z
      .array(CastCredit.describe('One cast credit.'))
      .describe(
        'Cast credits — for scope "show", the main cast; for scope "episode", that episode’s guest cast.',
      ),
    crew: z
      .array(CastCredit.describe('One crew credit.'))
      .optional()
      .describe('Crew credits. Present only when include_crew was set on a show query.'),
    scope: z.enum(['show', 'episode']).describe('Which credit list was returned.'),
    subject_id: z
      .number()
      .describe('TVmaze id the credits belong to — a show id or an episode id, matching scope.'),
  }),

  enrichment: {
    totalCount: z.number().describe('Credits returned, cast plus crew.'),
    notice: z
      .string()
      .optional()
      .describe('Guidance when no credits are recorded. Absent otherwise.'),
  },

  async handler(input, ctx) {
    const service = getTvmazeService();

    if (input.scope === 'show') {
      const [cast, crew] = await Promise.all([
        service.getShowCast(input.show_id, ctx),
        input.include_crew ? service.getShowCrew(input.show_id, ctx) : Promise.resolve(null),
      ]);

      if (cast === null) {
        throw ctx.fail('show_not_found', `No TVmaze show has id ${input.show_id}.`, {
          show_id: input.show_id,
          ...ctx.recoveryFor('show_not_found'),
        });
      }

      const crewCredits = input.include_crew ? (crew ?? []) : undefined;
      ctx.log.info('Show credits fetched', {
        showId: input.show_id,
        cast: cast.length,
        crew: crewCredits?.length ?? 0,
      });

      ctx.enrich.total(cast.length + (crewCredits?.length ?? 0));
      if (cast.length === 0) {
        ctx.enrich.notice(
          'No cast is recorded for this show. TVmaze is community-maintained and credits are often missing on smaller titles; call tvmaze_get_cast with scope "episode" on a specific episode for its guest cast.',
        );
      }

      return {
        cast,
        ...(crewCredits ? { crew: crewCredits } : {}),
        scope: 'show' as const,
        subject_id: input.show_id,
      };
    }

    const guestCast = await service.getEpisodeGuestCast(input.episode_id, ctx);
    if (guestCast === null) {
      throw ctx.fail('episode_not_found', `No TVmaze episode has id ${input.episode_id}.`, {
        episode_id: input.episode_id,
        ...ctx.recoveryFor('episode_not_found'),
      });
    }

    ctx.log.info('Episode guest credits fetched', {
      episodeId: input.episode_id,
      cast: guestCast.length,
    });

    ctx.enrich.total(guestCast.length);
    if (guestCast.length === 0) {
      ctx.enrich.notice(
        'No guest cast is recorded for this episode. Call tvmaze_get_cast with scope "show" for the main cast.',
      );
    }

    return { cast: guestCast, scope: 'episode' as const, subject_id: input.episode_id };
  },

  format: (result) => {
    const lines: string[] = [
      `${field('scope', result.scope)} | ${field('subject_id', result.subject_id)}`,
      '',
      '## Cast',
    ];
    if (result.cast.length === 0) lines.push(NOT_AVAILABLE);
    for (const credit of result.cast) lines.push('', ...castCreditLines(credit));

    if (result.crew) {
      lines.push('', '## Crew');
      if (result.crew.length === 0) lines.push(NOT_AVAILABLE);
      for (const credit of result.crew) lines.push('', ...castCreditLines(credit));
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
