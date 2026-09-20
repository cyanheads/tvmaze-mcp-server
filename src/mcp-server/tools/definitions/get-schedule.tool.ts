/**
 * @fileoverview tvmaze_get_schedule — what airs on a date, across the linear
 * broadcast feed, the streaming feed, or both merged.
 * @module mcp-server/tools/definitions/get-schedule.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { paginateArray } from '@cyanheads/mcp-ts-core/utils';

import { getTvmazeService, normalizeCountry, todayIn } from '@/services/tvmaze/tvmaze-service.js';
import type { ScheduleEntry, ScheduleFeed } from '@/services/tvmaze/types.js';
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

export const getSchedule = tool('tvmaze_get_schedule', {
  description:
    'List television episodes airing on a given date. Scope "linear" covers broadcast and cable networks in one country; "streaming" covers streaming services — global services such as Netflix and Prime Video when no country is given, or that country’s local streaming services when one is. Scope "all" merges both. The source caches schedule data for up to an hour, so a same-day listing can lag a late change.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },

  errors: [
    {
      reason: 'invalid_country',
      code: JsonRpcErrorCode.ValidationError,
      when: 'The two-letter code is not an ISO 3166-1 country the source recognizes.',
      recovery:
        'Pass an ISO 3166-1 alpha-2 code such as "US", "GB", or "JP"; note the United Kingdom is "GB", not "UK".',
      thrownBy: 'service',
    },
    {
      reason: 'invalid_date',
      code: JsonRpcErrorCode.ValidationError,
      when: 'The date is well-formed but not a real calendar date.',
      recovery: 'Pass a real calendar date as YYYY-MM-DD, or omit date to list today.',
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
    {
      reason: 'schedule_unavailable',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'Every requested feed failed after retries.',
      recovery:
        'Wait a few seconds and call tvmaze_get_schedule again; the source rate-limits by IP.',
      retryable: true,
      thrownBy: 'service',
    },
  ],

  input: z.object({
    date: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional()
      .describe(
        'Date to list, ISO 8601 (YYYY-MM-DD). Defaults to today in the requested timezone.',
      ),
    country: z
      .string()
      .regex(/^[A-Za-z]{2}$/)
      .optional()
      .describe(
        'ISO 3166-1 alpha-2 country code, e.g. "US", "GB", "JP". The United Kingdom is "GB". Required in effect for scopes "linear" and "all" — omitted, it falls back to the server-configured country. For scope "streaming", omitting it selects global streaming services rather than one country’s local ones.',
      ),
    scope: z
      .enum(['linear', 'streaming', 'all'])
      .default('linear')
      .describe(
        'Which feed to read. "linear" is broadcast and cable networks; "streaming" is streaming services; "all" merges both and costs three upstream requests.',
      ),
    timezone: z
      .string()
      .regex(/^[A-Za-z0-9_+-]+(\/[A-Za-z0-9_+-]+){0,2}$/)
      .optional()
      .describe(
        'IANA timezone name for the air times, e.g. "America/Los_Angeles". Defaults to the server-configured timezone. Also decides what "today" means when date is omitted.',
      ),
    limit: z
      .number()
      .int()
      .min(1)
      .max(MAX_PAGE_SIZE)
      .default(50)
      .describe(
        'Maximum entries to return in one call. A full day in one country runs to roughly 50 broadcast entries and over 120 global streaming entries.',
      ),
    cursor: z
      .string()
      .optional()
      .describe('Continuation token from a previous call’s next_cursor. Omit for the first page.'),
  }),

  output: z.object({
    entries: z
      .array(
        Episode.extend({
          show: ShowSummary.describe('The show this episode belongs to.'),
          feed: z
            .enum(['linear', 'streaming'])
            .describe(
              'Which feed this entry came from — a broadcast/cable network, or a streaming service.',
            ),
        }).describe('One episode airing on the requested date.'),
      )
      .describe('Episodes airing on the date, earliest first.'),
    date: z.string().describe('Date listed, ISO 8601 (YYYY-MM-DD).'),
    timezone: z.string().describe('IANA timezone the air times were rendered in.'),
    next_cursor: z
      .string()
      .optional()
      .describe('Pass as cursor to fetch the next page. Absent on the last page.'),
    has_more: z.boolean().describe('True when more entries remain beyond this page.'),
  }),

  enrichment: {
    applied_feeds: z
      .array(z.string())
      .describe(
        'Exactly which upstream feeds the results cover, e.g. ["linear:US"], ["web:global"], ["linear:GB","web:GB","web:global"].',
      ),
    totalCount: z.number().describe('Merged entry count before the page limit was applied.'),
    truncated: z.boolean().optional().describe('True when the page limit was reached.'),
    shown: z.number().optional().describe('Number of entries returned on this page.'),
    cap: z.number().optional().describe('The page limit that was applied.'),
    notice: z
      .string()
      .optional()
      .describe(
        'Guidance when nothing is listed, or when one feed of a merged query did not respond. Absent otherwise.',
      ),
  },

  enrichmentTrailer: {
    applied_feeds: { render: (feeds) => `**Feeds queried:** ${feeds.join(', ')}` },
  },

  async handler(input, ctx) {
    const service = getTvmazeService();
    const timezone = service.resolveTimezone(input.timezone, ctx);
    const date = input.date ?? todayIn(timezone);

    const explicitCountry = input.country?.trim() ? normalizeCountry(input.country) : undefined;
    const defaultedCountry = explicitCountry ?? service.resolveCountry(undefined);

    const feeds: ScheduleFeed[] = [];
    const labels: string[] = [];
    if (input.scope === 'linear' || input.scope === 'all') {
      feeds.push({ kind: 'linear', country: defaultedCountry });
      labels.push(`linear:${defaultedCountry}`);
    }
    if (input.scope === 'all') {
      feeds.push({ kind: 'web', country: defaultedCountry });
      labels.push(`web:${defaultedCountry}`);
      feeds.push({ kind: 'web-global' });
      labels.push('web:global');
    }
    if (input.scope === 'streaming') {
      if (explicitCountry) {
        feeds.push({ kind: 'web', country: explicitCountry });
        labels.push(`web:${explicitCountry}`);
      } else {
        feeds.push({ kind: 'web-global' });
        labels.push('web:global');
      }
    }

    const settled = await Promise.allSettled(
      feeds.map((feed) => service.getScheduleFeed(feed, date, timezone, ctx)),
    );

    const collected: ScheduleEntry[] = [];
    const succeeded: string[] = [];
    const failed: string[] = [];
    settled.forEach((result, index) => {
      const label = labels[index] ?? 'unknown';
      if (result.status === 'fulfilled') {
        succeeded.push(label);
        collected.push(...result.value);
      } else {
        failed.push(label);
      }
    });

    // A bad country or date is not a feed outage: the global web feed ignores
    // `country`, so it can succeed while the other feeds reject the input.
    // Surface the input error rather than degrading it to a retry notice.
    const invalidInput = settled.find(
      (result): result is PromiseRejectedResult =>
        result.status === 'rejected' && result.reason?.code === JsonRpcErrorCode.ValidationError,
    );
    if (invalidInput) throw invalidInput.reason;

    if (succeeded.length === 0) {
      const rejection = settled.find((result) => result.status === 'rejected');
      throw rejection?.reason;
    }

    // The linear feed carries a country's own streaming services too, so a
    // merged query can see one release twice. First occurrence wins.
    const seen = new Set<number>();
    const merged: ScheduleEntry[] = [];
    for (const entry of collected) {
      if (seen.has(entry.id)) continue;
      seen.add(entry.id);
      merged.push(entry);
    }
    merged.sort((a, b) => (Date.parse(a.airstamp) || 0) - (Date.parse(b.airstamp) || 0));

    const page = paginateArray(merged, input.cursor, input.limit, MAX_PAGE_SIZE, ctx);
    ctx.log.info('Schedule fetched', {
      date,
      feeds: succeeded,
      entries: merged.length,
      returned: page.items.length,
    });

    ctx.enrich({ applied_feeds: succeeded });
    ctx.enrich.total(merged.length);
    if (page.nextCursor) {
      ctx.enrich.truncated({ shown: page.items.length, cap: input.limit });
    }

    const fragments: string[] = [];
    if (merged.length === 0) {
      if (input.scope === 'linear') {
        fragments.push(
          `Nothing is listed for ${defaultedCountry} on ${date}. The linear feed covers broadcast and cable networks plus that country’s own streaming services; call tvmaze_get_schedule again with scope "streaming" for global services such as Netflix.`,
        );
      } else if (input.scope === 'streaming' && explicitCountry) {
        fragments.push(
          `No local streaming releases are listed for ${explicitCountry} on ${date}. Call tvmaze_get_schedule again with scope "streaming" and no country for global services.`,
        );
      } else if (input.scope === 'streaming') {
        fragments.push(
          `No global streaming releases are listed for ${date}. Call tvmaze_get_schedule again with scope "linear" and a country for that day's broadcast listings.`,
        );
      }
    }
    if (failed.length > 0) {
      fragments.push(
        `The ${failed.join(' and ')} feed did not respond, so these results cover ${succeeded.join(', ')} only. Call tvmaze_get_schedule again to retry it.`,
      );
    }
    if (fragments.length > 0) ctx.enrich.notice(fragments.join(' '));

    return {
      entries: page.items,
      date,
      timezone,
      ...(page.nextCursor ? { next_cursor: page.nextCursor } : {}),
      has_more: page.nextCursor !== undefined,
    };
  },

  format: (result) => {
    const lines: string[] = [
      `# Schedule — ${result.date} (${result.timezone})`,
      `${field('date', result.date)} | ${field('timezone', result.timezone)}`,
    ];

    for (const feedName of ['linear', 'streaming'] as const) {
      const rows = result.entries.filter((entry) => entry.feed === feedName);
      if (rows.length === 0) continue;
      lines.push('', `## ${feedName}`);
      for (const entry of rows) {
        lines.push(
          '',
          `### ${inline(`${entry.show.name} — ${entry.name}`)}`,
          field('feed', entry.feed),
          ...episodeLines(entry),
          ...showSummaryLines(entry.show),
        );
      }
    }

    lines.push(
      '',
      `${field('has_more', result.has_more)} | ${field('next_cursor', result.next_cursor)}`,
    );
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
