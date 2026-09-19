/**
 * @fileoverview tvmaze_search_shows — fuzzy title search against the TVmaze
 * show index, capped at ten rows by the source.
 * @module mcp-server/tools/definitions/search-shows.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';

import { getTvmazeService } from '@/services/tvmaze/tvmaze-service.js';
import { field, ShowSummary, showSummaryLines, yearRange } from './shared-schemas.js';

/** The source's fixed ceiling on `/search/shows`. There is no paging past it. */
const SEARCH_RESULT_CAP = 10;

export const searchShows = tool('tvmaze_search_shows', {
  description:
    'Search television shows by title and return up to 10 matches, each with its network or streaming service, production status, genres, rating, and ids in other catalogs. Matching is fuzzy, so small typos still resolve. The result set is hard-capped at 10 by the source and cannot be paged — narrow the title to reach an eleventh match. To go the other way, from an IMDb or TheTVDB id to a show, use tvmaze_lookup_show.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },

  errors: [
    {
      reason: 'search_unavailable',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'TVmaze search did not respond after retries.',
      recovery:
        'Wait a few seconds and call tvmaze_search_shows again; the source rate-limits search requests.',
      retryable: true,
      thrownBy: 'service',
    },
  ],

  input: z.object({
    query: z
      .string()
      .min(1)
      .describe(
        'Show title or title fragment. Matched fuzzily against every show title in the database, so minor misspellings still resolve.',
      ),
  }),

  output: z.object({
    shows: z
      .array(
        ShowSummary.extend({
          match_score: z
            .number()
            .describe(
              'Relevance score assigned by the source search. Higher is a closer title match; values are comparable only within one result set.',
            ),
        }).describe('A matching show with the relevance score the source assigned it.'),
      )
      .describe('Matching shows, best match first. At most 10.'),
  }),

  enrichment: {
    effectiveQuery: z.string().describe('The query as submitted upstream.'),
    truncated: z
      .boolean()
      .optional()
      .describe("True when the source's fixed ten-result ceiling was reached."),
    shown: z.number().optional().describe('Number of shows returned.'),
    cap: z.number().optional().describe('The result ceiling the source applied.'),
    notice: z
      .string()
      .optional()
      .describe(
        'Guidance when nothing matched or when the ten-result ceiling was reached. Absent otherwise.',
      ),
  },

  async handler(input, ctx) {
    const shows = await getTvmazeService().searchShows(input.query, ctx);
    ctx.log.info('Show search completed', { query: input.query, matches: shows.length });

    ctx.enrich.echo(input.query);

    const fragments: string[] = [];
    if (shows.length === 0) {
      fragments.push(
        `No show title matched "${input.query}". Try fewer words or the show's original-language title, or call tvmaze_lookup_show with an IMDb or TheTVDB id if you have one.`,
      );
    }
    if (shows.length === SEARCH_RESULT_CAP) {
      ctx.enrich.truncated({ shown: shows.length, cap: SEARCH_RESULT_CAP });
      fragments.push(
        'The source caps this search at 10 results and offers no pagination. Add words from the title to narrow it, or call tvmaze_lookup_show with an external id for an exact resolve.',
      );
    }
    if (fragments.length > 0) ctx.enrich.notice(fragments.join(' '));

    return { shows };
  },

  format: (result) => {
    const lines: string[] = [`**${result.shows.length} shows**`];
    for (const show of result.shows) {
      lines.push(
        '',
        `### ${show.name} (${yearRange(show)})`,
        field('match_score', show.match_score),
        ...showSummaryLines(show),
      );
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
