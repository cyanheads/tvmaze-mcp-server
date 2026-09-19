/**
 * @fileoverview tvmaze_lookup_show — resolve a show from its id in another
 * catalog (IMDb, TheTVDB, TVRage) into its TVmaze profile.
 * @module mcp-server/tools/definitions/lookup-show.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';

import { getTvmazeService } from '@/services/tvmaze/tvmaze-service.js';
import { field, ShowSummary, showSummaryLines } from './shared-schemas.js';

export const lookupShow = tool('tvmaze_lookup_show', {
  description:
    'Resolve a television show from its id in another catalog — IMDb, TheTVDB, or TVRage — and return the matching TVmaze profile. Use this to cross a show id from another source into TVmaze. A show absent from TVmaze is reported as a miss with guidance, not an error.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },

  errors: [
    {
      reason: 'lookup_unavailable',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'The lookup endpoint did not respond after retries.',
      recovery:
        'Wait a few seconds and call tvmaze_lookup_show again, or call tvmaze_search_shows with the show title.',
      retryable: true,
      thrownBy: 'service',
    },
  ],

  input: z.discriminatedUnion('source', [
    z.object({
      source: z.literal('imdb').describe('Look up by IMDb title id.'),
      external_id: z
        .string()
        .regex(/^tt\d{7,}$/)
        .describe('IMDb title id including the "tt" prefix, e.g. "tt0903747".'),
    }),
    z.object({
      source: z.literal('thetvdb').describe('Look up by TheTVDB series id.'),
      external_id: z.string().regex(/^\d+$/).describe('TheTVDB series id as digits, e.g. "81189".'),
    }),
    z.object({
      source: z
        .literal('tvrage')
        .describe(
          'Look up by TVRage show id. TVRage is defunct; these ids appear only in older records.',
        ),
      external_id: z.string().regex(/^\d+$/).describe('TVRage show id as digits.'),
    }),
  ]),

  output: z.object({
    found: z.boolean().describe('True when the external id resolved to a TVmaze show.'),
    show: ShowSummary.optional().describe('The resolved show. Absent on a miss.'),
    guidance: z
      .string()
      .optional()
      .describe('What to do next when the lookup missed. Absent on a hit.'),
    source: z.enum(['imdb', 'thetvdb', 'tvrage']).describe('Catalog the lookup was made against.'),
    external_id: z.string().describe('Id that was looked up, as submitted.'),
  }),

  async handler(input, ctx) {
    const show = await getTvmazeService().lookupShow(input.source, input.external_id, ctx);
    ctx.log.info('External id lookup completed', {
      source: input.source,
      found: show !== null,
    });

    if (!show) {
      return {
        found: false,
        source: input.source,
        external_id: input.external_id,
        guidance: `No TVmaze show carries the ${input.source} id "${input.external_id}". The show may not be in TVmaze, or the id may belong to a film rather than a series. Call tvmaze_search_shows with the title instead.`,
      };
    }

    return { found: true, show, source: input.source, external_id: input.external_id };
  },

  format: (result) => {
    const lines: string[] = [];
    if (result.show) {
      lines.push(`# ${result.show.name}`, ...showSummaryLines(result.show));
    }
    if (result.guidance) {
      lines.push('**No match**', field('guidance', result.guidance));
    }
    lines.push(
      `${field('found', result.found)} | ${field('source', result.source)} | ${field('external_id', result.external_id)}`,
    );
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
