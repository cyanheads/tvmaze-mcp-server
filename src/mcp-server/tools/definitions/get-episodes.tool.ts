/**
 * @fileoverview tvmaze_get_episodes — a show's episode guide, scoped to one
 * season by default and paged across the whole run when no season is given.
 * @module mcp-server/tools/definitions/get-episodes.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { paginateArray } from '@cyanheads/mcp-ts-core/utils';

import { getTvmazeService } from '@/services/tvmaze/tvmaze-service.js';
import type { Episode as EpisodeShape, Season as SeasonShape } from '@/services/tvmaze/types.js';
import {
  Episode,
  episodeLines,
  field,
  inline,
  ShowSummary,
  showSummaryLines,
} from './shared-schemas.js';

/** The highest page size the `limit` input allows, and the ceiling a cursor is clamped to. */
const MAX_PAGE_SIZE = 250;

/** `1-8` for a contiguous run, `1, 3, 7` otherwise, `none` for a show with no seasons. */
function describeSeasons(seasons: SeasonShape[]): string {
  if (seasons.length === 0) return 'none';
  const numbers = seasons.map((season) => season.number).sort((a, b) => a - b);
  const first = numbers.at(0) ?? 0;
  const last = numbers.at(-1) ?? 0;
  const contiguous = numbers.length === last - first + 1;
  return contiguous && numbers.length > 1 ? `${first}-${last}` : numbers.join(', ');
}

export const getEpisodes = tool('tvmaze_get_episodes', {
  description:
    'List a show’s episodes with air times, runtimes, and synopses. Pass a season number to list one season, which is the cheaper path and the usual one; omit it to walk the whole run, which is paged because a long-running series returns hundreds of episodes. Specials are excluded unless include_specials is set.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },

  errors: [
    {
      reason: 'show_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'No show exists with the given TVmaze id.',
      recovery:
        'Call tvmaze_search_shows with the show title to find a valid TVmaze id, then call tvmaze_get_episodes again.',
    },
    {
      reason: 'season_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'The show has no season with the requested number.',
      recovery:
        'Call tvmaze_get_show for this id to see the seasons it has, then call tvmaze_get_episodes with one of those numbers.',
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

  input: z.object({
    show_id: z
      .number()
      .int()
      .positive()
      .describe(
        'TVmaze show id, from tvmaze_search_shows, tvmaze_lookup_show, or tvmaze_get_schedule.',
      ),
    season: z
      .number()
      .int()
      .positive()
      .optional()
      .describe(
        'Season number to list, as numbered in the season list from tvmaze_get_show. Omit to list every episode of the series. Daily shows number seasons by calendar year.',
      ),
    include_specials: z
      .boolean()
      .default(false)
      .describe(
        'Include specials alongside regular episodes. Off by default because specials roughly double the result count on a series that has many.',
      ),
    limit: z
      .number()
      .int()
      .min(1)
      .max(MAX_PAGE_SIZE)
      .default(50)
      .describe(
        'Maximum episodes to return in one call. Raise it for a short series; the default keeps a long run inside a reasonable response size.',
      ),
    cursor: z
      .string()
      .optional()
      .describe('Continuation token from a previous call’s next_cursor. Omit for the first page.'),
    timezone: z
      .string()
      .regex(/^[A-Za-z0-9_+-]+(\/[A-Za-z0-9_+-]+){0,2}$/)
      .optional()
      .describe(
        'IANA timezone name for the air times, e.g. "America/Los_Angeles". Defaults to the server-configured timezone.',
      ),
  }),

  output: z.object({
    episodes: z
      .array(Episode.describe('One episode of this show.'))
      .describe('Episodes in airing order.'),
    show: ShowSummary.describe('The show the episodes belong to.'),
    season: z
      .number()
      .optional()
      .describe('Season number listed. Absent when the whole run was listed.'),
    timezone: z.string().describe('IANA timezone the air times were rendered in.'),
    next_cursor: z
      .string()
      .optional()
      .describe('Pass as cursor to fetch the next page. Absent on the last page.'),
    has_more: z.boolean().describe('True when more episodes remain beyond this page.'),
  }),

  enrichment: {
    totalCount: z.number().describe('Episodes matching before the page limit was applied.'),
    truncated: z.boolean().optional().describe('True when the page limit was reached.'),
    shown: z.number().optional().describe('Number of episodes returned on this page.'),
    cap: z.number().optional().describe('The page limit that was applied.'),
    notice: z
      .string()
      .optional()
      .describe(
        'Guidance when nothing was recorded, or when specials were filtered out of a season listing. Absent otherwise.',
      ),
  },

  async handler(input, ctx) {
    const service = getTvmazeService();
    const timezone = service.resolveTimezone(input.timezone, ctx);
    const fragments: string[] = [];

    let show: z.infer<typeof ShowSummary>;
    let matching: EpisodeShape[];

    if (input.season === undefined) {
      const [profile, episodes] = await Promise.all([
        service.getShowWithSeasons(input.show_id, ctx),
        service.getShowEpisodes(input.show_id, timezone, ctx, input.include_specials),
      ]);
      if (!profile) {
        throw ctx.fail('show_not_found', `No TVmaze show has id ${input.show_id}.`, {
          show_id: input.show_id,
          ...ctx.recoveryFor('show_not_found'),
        });
      }
      show = profile.show;
      matching = episodes ?? [];
      if (matching.length === 0) {
        fragments.push(
          `${show.name} has no episodes recorded yet. Call tvmaze_get_show to check its status and announced seasons.`,
        );
      }
    } else {
      const profile = await service.getShowWithSeasons(input.show_id, ctx);
      if (!profile) {
        throw ctx.fail('show_not_found', `No TVmaze show has id ${input.show_id}.`, {
          show_id: input.show_id,
          ...ctx.recoveryFor('show_not_found'),
        });
      }
      show = profile.show;

      const season = profile.seasons.find((candidate) => candidate.number === input.season);
      if (!season) {
        throw ctx.fail(
          'season_not_found',
          `Season ${input.season} not found for ${show.name}. Available seasons: ${describeSeasons(profile.seasons)}.`,
          { show_id: input.show_id, season: input.season, ...ctx.recoveryFor('season_not_found') },
        );
      }

      // The season route always includes specials and ignores ?specials=1, so
      // the filter runs locally to keep one contract with the whole-run arm.
      const all = (await service.getSeasonEpisodes(season.id, timezone, ctx)) ?? [];
      matching = input.include_specials ? all : all.filter((episode) => episode.type === 'regular');
      const omitted = all.length - matching.length;

      if (matching.length === 0) {
        fragments.push(
          `Season ${input.season} of ${show.name} has no episodes recorded. Call tvmaze_get_show to see which seasons exist.`,
        );
      }
      if (omitted > 0) {
        fragments.push(
          `${omitted} special(s) in this season were omitted. Call again with include_specials true to include them.`,
        );
      }
    }

    const page = paginateArray(matching, input.cursor, input.limit, MAX_PAGE_SIZE, ctx);
    ctx.log.info('Episode guide fetched', {
      showId: input.show_id,
      season: input.season,
      matching: matching.length,
      returned: page.items.length,
    });

    ctx.enrich.total(matching.length);
    if (page.nextCursor) {
      ctx.enrich.truncated({ shown: page.items.length, cap: input.limit });
    }
    if (fragments.length > 0) ctx.enrich.notice(fragments.join(' '));

    return {
      episodes: page.items,
      show,
      ...(input.season === undefined ? {} : { season: input.season }),
      timezone,
      ...(page.nextCursor ? { next_cursor: page.nextCursor } : {}),
      has_more: page.nextCursor !== undefined,
    };
  },

  format: (result) => {
    const scope = result.season === undefined ? 'all episodes' : `Season ${result.season}`;
    const lines: string[] = [
      `# ${inline(result.show.name)} — ${scope}`,
      `${field('season', result.season)} | ${field('timezone', result.timezone)}`,
      ...showSummaryLines(result.show),
    ];
    for (const episode of result.episodes) {
      lines.push('', ...episodeLines(episode));
    }
    lines.push(
      '',
      `${field('has_more', result.has_more)} | ${field('next_cursor', result.next_cursor)}`,
    );
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
