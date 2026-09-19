/**
 * @fileoverview tvmaze_get_next_episode — when a show's next episode airs, by
 * TVmaze id or by title, converted into a viewer's timezone.
 * @module mcp-server/tools/definitions/get-next-episode.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';

import { getTvmazeService } from '@/services/tvmaze/tvmaze-service.js';
import { Episode, episodeLines, field, ShowSummary, showSummaryLines } from './shared-schemas.js';

const TIMEZONE_INPUT = z
  .string()
  .regex(/^[A-Za-z0-9_+-]+(\/[A-Za-z0-9_+-]+){0,2}$/)
  .optional()
  .describe(
    'IANA timezone name for the air time, e.g. "America/Los_Angeles". Defaults to the server-configured timezone.',
  );

export const getNextEpisode = tool('tvmaze_get_next_episode', {
  description:
    'Report when a show’s next episode airs, converted to a viewer timezone. Accepts a TVmaze id or a show title — a title is resolved with a stricter single-match search than tvmaze_search_shows uses. A show with no scheduled next episode is reported as a miss carrying its most recent episode, which is the normal state for a series between seasons.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },

  errors: [
    {
      reason: 'show_not_found_by_id',
      code: JsonRpcErrorCode.NotFound,
      when: 'A TVmaze id was supplied and no show carries it.',
      recovery:
        'Call tvmaze_search_shows with the show title to find a valid TVmaze id, then call tvmaze_get_next_episode again.',
    },
    {
      reason: 'invalid_timezone',
      code: JsonRpcErrorCode.ValidationError,
      when: 'The timezone is not an IANA zone name the runtime recognizes.',
      recovery:
        'Pass an IANA timezone name such as "America/New_York" or "Europe/London", or omit timezone to use the server default.',
      thrownBy: 'service',
    },
  ],

  input: z.discriminatedUnion('by', [
    z.object({
      by: z.literal('id').describe('Identify the show by its TVmaze id.'),
      show_id: z
        .number()
        .int()
        .positive()
        .describe(
          'TVmaze show id, from tvmaze_search_shows, tvmaze_lookup_show, or tvmaze_get_schedule.',
        ),
      timezone: TIMEZONE_INPUT,
    }),
    z.object({
      by: z
        .literal('title')
        .describe('Identify the show by title. Resolved to a single best match.'),
      title: z
        .string()
        .min(1)
        .describe(
          'Show title. Matched to one best result; when several shows share a title, resolve the id with tvmaze_search_shows first and call again with by "id".',
        ),
      timezone: TIMEZONE_INPUT,
    }),
  ]),

  output: z.object({
    found: z.boolean().describe('True when a next episode is scheduled.'),
    miss_reason: z
      .enum(['show_not_found', 'no_scheduled_episode'])
      .optional()
      .describe(
        'Why no next episode was returned. "show_not_found" means the title or id resolved to nothing; "no_scheduled_episode" means the show exists but has nothing on the schedule.',
      ),
    guidance: z
      .string()
      .optional()
      .describe('What to do next when no next episode was returned. Absent on a hit.'),
    show: ShowSummary.optional().describe(
      'The show the answer is about. Absent when the show itself could not be resolved.',
    ),
    next_episode: Episode.optional().describe('The next scheduled episode. Absent on a miss.'),
    previous_episode: Episode.optional().describe(
      'The most recently aired episode. Returned on a hit and on a "no_scheduled_episode" miss, so a between-seasons answer still says where the show left off.',
    ),
    timezone: z.string().describe('IANA timezone the air times were rendered in.'),
  }),

  async handler(input, ctx) {
    const service = getTvmazeService();
    const timezone = service.resolveTimezone(input.timezone, ctx);

    const detail =
      input.by === 'id'
        ? await service.getShowDetail(input.show_id, timezone, ctx, { seasons: false })
        : await service.singleSearchShow(input.title, timezone, ctx);

    if (!detail) {
      if (input.by === 'id') {
        throw ctx.fail('show_not_found_by_id', `No TVmaze show has id ${input.show_id}.`, {
          show_id: input.show_id,
          ...ctx.recoveryFor('show_not_found_by_id'),
        });
      }
      ctx.log.info('Title did not resolve to a show', { title: input.title });
      return {
        found: false,
        miss_reason: 'show_not_found' as const,
        guidance: `No show matched "${input.title}". Call tvmaze_search_shows with the title to see the closest matches and their TVmaze ids, then call again with by "id".`,
        timezone,
      };
    }

    const previous = detail.previous_episode ? { previous_episode: detail.previous_episode } : {};

    if (!detail.next_episode) {
      return {
        found: false,
        miss_reason: 'no_scheduled_episode' as const,
        guidance: `${detail.show.name} is ${detail.show.status ?? 'listed with no production status'} and has no episode on the schedule. previous_episode carries the most recent air date; call tvmaze_get_show later to check whether a new episode has been announced.`,
        show: detail.show,
        ...previous,
        timezone,
      };
    }

    ctx.log.info('Next episode resolved', {
      showId: detail.show.id,
      airstamp: detail.next_episode.airstamp,
    });

    return {
      found: true,
      show: detail.show,
      next_episode: detail.next_episode,
      ...previous,
      timezone,
    };
  },

  format: (result) => {
    const lines: string[] = [
      `${field('found', result.found)} | ${field('miss_reason', result.miss_reason)} | ${field('timezone', result.timezone)}`,
    ];
    if (!result.found) lines.push('**No scheduled episode**');
    if (result.guidance) lines.push(field('guidance', result.guidance));
    if (result.next_episode) {
      lines.push('', `## Next: ${result.next_episode.name}`, ...episodeLines(result.next_episode));
    }
    if (result.previous_episode) {
      lines.push('', '## Previously', ...episodeLines(result.previous_episode));
    }
    if (result.show) {
      lines.push('', `## Show: ${result.show.name}`, ...showSummaryLines(result.show));
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
