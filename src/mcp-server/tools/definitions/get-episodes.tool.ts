/**
 * @fileoverview tvmaze_get_episodes — a show's episode guide: one season, one
 * air date, or the whole run paged, with specials filtered locally and counted
 * on every arm.
 * @module mcp-server/tools/definitions/get-episodes.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';

import { getTvmazeService } from '@/services/tvmaze/tvmaze-service.js';
import type { Episode as EpisodeShape, Season as SeasonShape } from '@/services/tvmaze/types.js';
import { DEFAULT_PAGE_SIZE, enrichPage, MAX_PAGE_SIZE, pageOf } from './paging.js';
import {
  Episode,
  episodeLines,
  field,
  inline,
  ShowSummary,
  showSummaryLines,
} from './shared-schemas.js';

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
    'List a show’s episodes with air times, runtimes, and synopses. Pass a season number to list one season, which is the cheaper path and the usual one; pass air_date to list the episodes dated to one day, the direct path to a single night of a daily show; omit both to walk the whole run, which is paged because a long-running series returns hundreds of episodes. Specials are excluded unless include_specials is set, and the number left out is reported.',
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
      reason: 'invalid_date',
      code: JsonRpcErrorCode.ValidationError,
      when: 'The air_date is well-formed but not a real calendar date.',
      recovery:
        'Pass a real calendar date as YYYY-MM-DD in air_date, or pass season instead to list the whole season.',
      thrownBy: 'service',
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

  input: z
    .object({
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
          'Season number to list, as numbered in the season list from tvmaze_get_show. Omit, together with air_date, to list every episode of the series. Daily shows number seasons by calendar year.',
        ),
      air_date: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .optional()
        .describe(
          'Date to list, ISO 8601 (YYYY-MM-DD): the episodes the source dates to that day. It matches the source’s airdate, the broadcaster’s own programming day, so on a late-night slot it can differ by a day from the local_date an episode reports. Cannot be combined with season.',
        ),
      include_specials: z
        .boolean()
        .default(false)
        .describe(
          'Include specials alongside regular episodes. Off by default because specials roughly double the result count on a series that has many; when off, notice reports how many were left out.',
        ),
      limit: z
        .number()
        .int()
        .min(1)
        .max(MAX_PAGE_SIZE)
        .default(DEFAULT_PAGE_SIZE)
        .describe(
          'Maximum episodes to return in this call. Applies to every page, including a call that passes cursor. Raise it for a short series; the default keeps a long run inside a reasonable response size.',
        ),
      cursor: z
        .string()
        .optional()
        .describe(
          'Continuation token from a previous call’s next_cursor. It carries only the position to resume from; the page size comes from limit. Omit for the first page.',
        ),
      timezone: z
        .string()
        .regex(/^[A-Za-z0-9_+-]+(\/[A-Za-z0-9_+-]+){0,2}$/)
        .optional()
        .describe(
          'IANA timezone name for the air times, e.g. "America/Los_Angeles". Defaults to the server-configured timezone.',
        ),
    })
    .refine((input) => input.season === undefined || input.air_date === undefined, {
      message:
        'season and air_date cannot be combined — pass season to list a season, or air_date to list one day.',
      path: ['air_date'],
    }),

  output: z.object({
    episodes: z
      .array(Episode.describe('One episode of this show.'))
      .describe('Episodes in airing order.'),
    show: ShowSummary.describe('The show the episodes belong to.'),
    season: z
      .number()
      .optional()
      .describe('Season number listed. Absent when the whole run or one air date was listed.'),
    air_date: z
      .string()
      .optional()
      .describe('Air date listed, YYYY-MM-DD. Absent unless air_date was given.'),
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
    cap: z.number().optional().describe('The page size applied to this call — its limit.'),
    notice: z
      .string()
      .optional()
      .describe(
        'Guidance when the page was truncated, when nothing was recorded, or when specials were filtered out — every one that applies, joined. Absent otherwise.',
      ),
  },

  async handler(input, ctx) {
    const service = getTvmazeService();
    const timezone = service.resolveTimezone(input.timezone, ctx);

    // The season arm needs the profile first, to map the season number onto
    // the season id its route takes; the other two arms fetch alongside it.
    const [profile, listed] = await Promise.all([
      service.getShowWithSeasons(input.show_id, ctx),
      input.air_date !== undefined
        ? service.getEpisodesByDate(input.show_id, input.air_date, timezone, ctx)
        : input.season === undefined
          ? service.getShowEpisodes(input.show_id, timezone, ctx)
          : null,
    ]);
    // The date route answers the same 404 for a missing show as for an empty
    // date, so the profile is what decides whether the show exists.
    if (!profile) {
      throw ctx.fail('show_not_found', `No TVmaze show has id ${input.show_id}.`, {
        show_id: input.show_id,
        ...ctx.recoveryFor('show_not_found'),
      });
    }
    const show = profile.show;

    let all: EpisodeShape[];
    if (input.season === undefined) {
      all = listed ?? [];
    } else {
      const season = profile.seasons.find((candidate) => candidate.number === input.season);
      if (!season) {
        throw ctx.fail(
          'season_not_found',
          `Season ${input.season} not found for ${show.name}. Available seasons: ${describeSeasons(profile.seasons)}.`,
          { show_id: input.show_id, season: input.season, ...ctx.recoveryFor('season_not_found') },
        );
      }
      all = (await service.getSeasonEpisodes(season.id, timezone, ctx)) ?? [];
    }

    // Every route this tool reads returns specials, so one local filter keeps
    // one contract across the arms and always knows how many it dropped.
    const matching = input.include_specials
      ? all
      : all.filter((episode) => episode.type === 'regular');
    const omitted = all.length - matching.length;

    const fragments: string[] = [];
    if (input.air_date !== undefined) {
      if (all.length === 0) {
        fragments.push(
          `No episode of ${show.name} is dated ${input.air_date}. air_date matches the source’s airdate, the broadcaster’s programming day, which can differ by a day from local_date on a late-night slot. Call again with season in place of air_date to see that season’s dates.`,
        );
      }
    } else if (input.season === undefined) {
      if (all.length === 0) {
        fragments.push(
          `${show.name} has no episodes recorded yet. Call tvmaze_get_show to check its status and announced seasons.`,
        );
      }
    } else if (matching.length === 0) {
      fragments.push(
        `Season ${input.season} of ${show.name} has no episodes recorded. Call tvmaze_get_show to see which seasons exist.`,
      );
    }
    if (omitted > 0) {
      const scope =
        input.air_date !== undefined
          ? `dated ${input.air_date}`
          : input.season === undefined
            ? 'across the whole run'
            : 'in this season';
      fragments.push(
        `${omitted} special(s) ${scope} were omitted. Call again with include_specials true to include them.`,
      );
    }

    const page = pageOf(matching, input.cursor, input.limit, ctx);
    ctx.log.info('Episode guide fetched', {
      showId: input.show_id,
      season: input.season,
      airDate: input.air_date,
      matching: matching.length,
      omittedSpecials: omitted,
      returned: page.items.length,
    });

    enrichPage(ctx, page, 'episodes', fragments);

    return {
      episodes: page.items,
      show,
      ...(input.season === undefined ? {} : { season: input.season }),
      ...(input.air_date === undefined ? {} : { air_date: input.air_date }),
      timezone,
      ...(page.nextCursor ? { next_cursor: page.nextCursor } : {}),
      has_more: page.nextCursor !== undefined,
    };
  },

  format: (result) => {
    const scope =
      result.air_date !== undefined
        ? `air date ${result.air_date}`
        : result.season === undefined
          ? 'all episodes'
          : `Season ${result.season}`;
    const echo = [
      field('season', result.season),
      ...(result.air_date === undefined ? [] : [field('air_date', result.air_date)]),
      field('timezone', result.timezone),
    ];
    const lines: string[] = [
      `# ${inline(result.show.name)} — ${scope}`,
      echo.join(' | '),
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
