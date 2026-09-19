/**
 * @fileoverview tvmaze_get_show — full profile for one TVmaze show id, with its
 * season list and the previous and next episode when the source has them.
 * @module mcp-server/tools/definitions/get-show.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';

import { getTvmazeService } from '@/services/tvmaze/tvmaze-service.js';
import {
  Episode,
  episodeLines,
  field,
  NOT_AVAILABLE,
  SEASON_TABLE_HEADER,
  Season,
  ShowSummary,
  seasonRow,
  showSummaryLines,
} from './shared-schemas.js';

export const getShow = tool('tvmaze_get_show', {
  description:
    'Fetch a television show by its TVmaze id: full profile, weekly broadcast slot, season list, and the previous and next episode when the source has them. This is the entry point for an id returned by tvmaze_search_shows or tvmaze_lookup_show. For the episode list itself use tvmaze_get_episodes, and for credits use tvmaze_get_cast.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },

  errors: [
    {
      reason: 'show_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'No show exists with the given TVmaze id.',
      recovery:
        'Call tvmaze_search_shows with the show title to find a valid TVmaze id, or tvmaze_lookup_show with an IMDb or TheTVDB id.',
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
    timezone: z
      .string()
      .regex(/^[A-Za-z0-9_+-]+(\/[A-Za-z0-9_+-]+){0,2}$/)
      .optional()
      .describe(
        'IANA timezone name for rendering the previous and next episode air times, e.g. "America/Los_Angeles" or "Europe/London". Defaults to the server-configured timezone.',
      ),
  }),

  output: z.object({
    show: ShowSummary.extend({
      official_site: z.string().optional().describe('Show page on the network or studio site.'),
      schedule_days: z
        .array(z.string())
        .describe(
          'Weekdays the show airs in its regular slot, e.g. ["Monday"]. Empty for a streaming release with no weekly slot.',
        ),
      schedule_time: z
        .string()
        .optional()
        .describe(
          'Regular slot start time in the channel’s local 24-hour clock, e.g. "22:00". Absent when there is no fixed slot.',
        ),
    }).describe('Full show profile.'),
    seasons: z
      .array(Season.describe('One season of this show.'))
      .describe(
        'Every season TVmaze records, in order. Pass a season number to tvmaze_get_episodes.',
      ),
    next_episode: Episode.optional().describe(
      'The next episode scheduled to air. Absent when none is scheduled — a Running show between seasons has no next episode.',
    ),
    previous_episode: Episode.optional().describe(
      'The most recently aired episode. Absent for a show that has not premiered.',
    ),
    timezone: z.string().describe('IANA timezone the episode times were rendered in.'),
  }),

  enrichment: {
    notice: z
      .string()
      .optional()
      .describe('Guidance when a Running show has no scheduled next episode. Absent otherwise.'),
  },

  async handler(input, ctx) {
    const service = getTvmazeService();
    const timezone = service.resolveTimezone(input.timezone, ctx);
    const detail = await service.getShowDetail(input.show_id, timezone, ctx, { seasons: true });

    if (!detail) {
      throw ctx.fail('show_not_found', `No TVmaze show has id ${input.show_id}.`, {
        show_id: input.show_id,
        ...ctx.recoveryFor('show_not_found'),
      });
    }

    ctx.log.info('Show profile fetched', {
      showId: input.show_id,
      seasons: detail.seasons.length,
    });

    if (detail.show.status === 'Running' && !detail.next_episode) {
      ctx.enrich.notice(
        `${detail.show.name} is listed as Running but has no scheduled next episode; the source has not announced one yet. Call tvmaze_get_show again later, or read previous_episode for the most recent air date.`,
      );
    }

    return { ...detail, timezone };
  },

  format: (result) => {
    const lines: string[] = [`# ${result.show.name}`, ...showSummaryLines(result.show)];
    lines.push(
      `${field('official_site', result.show.official_site)} | ${field('schedule_days', result.show.schedule_days)} | ${field('schedule_time', result.show.schedule_time)}`,
      field('timezone', result.timezone),
      '',
      '## Seasons',
    );
    lines.push(...SEASON_TABLE_HEADER);
    if (result.seasons.length === 0) lines.push(`| ${NOT_AVAILABLE} | | | | | | |`);
    for (const season of result.seasons) lines.push(seasonRow(season));

    if (result.next_episode) {
      lines.push('', '## Next episode', ...episodeLines(result.next_episode));
    }
    if (result.previous_episode) {
      lines.push('', '## Previous episode', ...episodeLines(result.previous_episode));
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
