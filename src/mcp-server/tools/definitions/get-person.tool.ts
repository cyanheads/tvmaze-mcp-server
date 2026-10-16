/**
 * @fileoverview Resolve person names to candidates or page one person's selected credits.
 * @module mcp-server/tools/definitions/get-person.tool
 */
import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getTvmazeService } from '@/services/tvmaze/tvmaze-service.js';
import { DEFAULT_PAGE_SIZE, enrichPage, pageOf } from './paging.js';
import { field, inline, noticeText } from './shared-schemas.js';

const Person = z.object({
  id: z.number().describe('TVmaze person id; pass as person_id to select this person.'),
  name: z.string().describe('Person name.'),
  url: z.string().describe('Canonical TVmaze person page; retain for attribution.'),
  country: z.string().optional().describe('Country name when recorded.'),
  birthday: z.string().optional().describe('Date of birth, YYYY-MM-DD, when recorded.'),
  image_url: z.string().optional().describe('Original headshot URL when recorded.'),
});

const Credit = z.object({
  show_id: z
    .number()
    .optional()
    .describe('TVmaze show id for tvmaze_get_show or tvmaze_get_episodes.'),
  show_name: z.string().optional().describe('Show title when available.'),
  show_url: z.string().optional().describe('Canonical TVmaze show page for attribution.'),
  episode_id: z
    .number()
    .optional()
    .describe('TVmaze episode id for tvmaze_get_cast with scope "episode".'),
  episode_name: z.string().optional().describe('Episode title on guest credits when available.'),
  episode_url: z.string().optional().describe('Canonical TVmaze episode page for attribution.'),
  character_id: z.number().optional().describe('TVmaze character id when embedded.'),
  character_name: z.string().optional().describe('Character name when embedded.'),
  character_url: z.string().optional().describe('Canonical TVmaze character page when embedded.'),
  credit_type: z.string().optional().describe('Crew role when recorded.'),
  as_self: z
    .boolean()
    .optional()
    .describe('Whether the person appears as themselves, when recorded.'),
  voice_only: z.boolean().optional().describe('Whether the role is voice-only, when recorded.'),
});

/** Render identity and optional disambiguators without inventing missing values. */
function personLines(person: z.infer<typeof Person>): string[] {
  return [
    field('id', person.id),
    field('name', person.name),
    field('url', person.url),
    field('country', person.country),
    field('birthday', person.birthday),
    field('image_url', person.image_url),
  ];
}

export const getPerson = tool('tvmaze_get_person', {
  title: 'Get person',
  description:
    'Search people by name to return candidates, then select a person_id to list their cast, guest, or crew credits. Name searches never select a person automatically. Credits preserve source order and page at 50 rows by default, up to 250 per call; show_id chains to tvmaze_get_show or tvmaze_get_episodes, and guest episode_id chains to tvmaze_get_cast with scope "episode".',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  errors: [
    {
      reason: 'person_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'The supplied TVmaze person id does not exist.',
      recovery:
        'Call tvmaze_get_person with query set to the person name, then choose a returned person id.',
    },
    {
      reason: 'person_search_unavailable',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'Person search did not respond after retries.',
      recovery: 'Wait a few seconds and call tvmaze_get_person again with the same query.',
      retryable: true,
      thrownBy: 'service',
    },
  ],
  input: z
    .object({
      query: z
        .string()
        .trim()
        .optional()
        .describe('Person name to search. Supply query or person_id, never both. Blank is unset.'),
      person_id: z
        .number()
        .int()
        .positive()
        .optional()
        .describe('TVmaze person id from tvmaze_get_cast or this tool’s candidates.'),
      credit_kind: z
        .enum(['cast', 'guest', 'crew'])
        .optional()
        .describe('Credit category for person_id only. Defaults to cast.'),
      limit: z
        .number()
        .int()
        .positive()
        .optional()
        .describe(
          'Page size for person_id only. Defaults to 50; requests above 250 are clamped to 250.',
        ),
      cursor: z
        .string()
        .optional()
        .describe('Previous next_cursor for person_id only; the current limit sets page size.'),
    })
    .refine((input) => Boolean(input.query) !== (input.person_id !== undefined), {
      message: 'Supply exactly one of query or person_id.',
    })
    .refine(
      (input) =>
        !input.query ||
        (input.credit_kind === undefined &&
          input.limit === undefined &&
          input.cursor === undefined),
      {
        message:
          'credit_kind, limit, and cursor require person_id; omit them when searching query.',
      },
    ),
  output: z.object({
    kind: z
      .enum(['search', 'person'])
      .describe('Search candidates or one selected person with credits.'),
    candidates: z
      .array(
        Person.extend({
          match_score: z.number().describe('Source relevance score within this search.'),
        }).describe('One person candidate.'),
      )
      .optional()
      .describe('Name search candidates, in source order. Never automatically selected.'),
    person: Person.optional().describe('Selected person profile.'),
    credit_kind: z
      .enum(['cast', 'guest', 'crew'])
      .optional()
      .describe('Credit category returned for the selected person.'),
    credits: z
      .array(Credit.describe('One compact credit.'))
      .optional()
      .describe('Selected credits on this page, in source order.'),
    has_more: z.boolean().optional().describe('Whether further credit rows remain.'),
    next_cursor: z.string().optional().describe('Continuation token for the selected credit list.'),
  }),
  enrichment: {
    effectiveQuery: z.string().optional().describe('Trimmed person name searched.'),
    totalCount: z
      .number()
      .describe('Candidates returned by search, or total selected credits before paging.'),
    truncated: z
      .boolean()
      .optional()
      .describe('More credits remain, or the source may have capped search candidates.'),
    shown: z.number().optional().describe('Actual number of candidates or credits returned.'),
    cap: z.number().optional().describe('Applied page size or possible source search ceiling.'),
    notice: z
      .string()
      .optional()
      .describe('Candidate selection, empty result, paging, and clamp guidance.'),
  },
  enrichmentTrailer: {
    notice: { render: noticeText },
    effectiveQuery: { render: (value) => (value === undefined ? '' : `Query: ${inline(value)}`) },
  },
  async handler(input, ctx) {
    const service = getTvmazeService();
    if (input.query) {
      const candidates = await service.searchPeople(input.query, ctx);
      ctx.enrich.echo(input.query);
      ctx.enrich.total(candidates.length);
      const fragments = [
        candidates.length
          ? 'Choose a candidate id and call tvmaze_get_person with person_id to list their credits.'
          : 'No person matched this query. Try fewer words or another spelling.',
      ];
      if (candidates.length >= 10) {
        ctx.enrich.truncated({ shown: candidates.length, cap: 10 });
        fragments.push(
          'The source may have capped matches at ten; narrow the name. Search has no continuation cursor.',
        );
      }
      ctx.enrich.notice(fragments.join(' '));
      return { kind: 'search' as const, candidates };
    }
    const personId = input.person_id as number;
    const person = await service.getPerson(personId, ctx);
    if (!person) throw ctx.fail('person_not_found', `No TVmaze person has id ${input.person_id}.`);
    const creditKind = input.credit_kind ?? 'cast';
    const credits = await service.getPersonCredits(personId, creditKind, ctx);
    const page = pageOf(credits, input.cursor, input.limit ?? DEFAULT_PAGE_SIZE, ctx);
    enrichPage(
      ctx,
      page,
      'credits',
      credits.length
        ? []
        : [`No ${creditKind} credits are recorded for this person. Try another credit_kind.`],
    );
    return {
      kind: 'person' as const,
      person,
      credit_kind: creditKind,
      credits: page.items,
      has_more: Boolean(page.nextCursor),
      ...(page.nextCursor ? { next_cursor: page.nextCursor } : {}),
    };
  },
  format(result) {
    const lines = [field('kind', result.kind)];
    if (result.candidates) {
      lines.push('## Candidates');
      for (const person of result.candidates)
        lines.push(
          `### ${inline(person.name)}`,
          ...personLines(person),
          field('match_score', person.match_score),
        );
    }
    if (result.person)
      lines.push(`## ${inline(result.person.name)}`, ...personLines(result.person));
    if (result.credits) {
      lines.push(field('credit_kind', result.credit_kind), '## Credits');
      for (const credit of result.credits)
        lines.push(
          '',
          field('show_id', credit.show_id),
          field('show_name', credit.show_name),
          field('show_url', credit.show_url),
          field('episode_id', credit.episode_id),
          field('episode_name', credit.episode_name),
          field('episode_url', credit.episode_url),
          field('character_id', credit.character_id),
          field('character_name', credit.character_name),
          field('character_url', credit.character_url),
          field('credit_type', credit.credit_type),
          field('as_self', credit.as_self),
          field('voice_only', credit.voice_only),
        );
    }
    if (result.has_more !== undefined) lines.push(field('has_more', result.has_more));
    if (result.next_cursor) lines.push(field('next_cursor', result.next_cursor));
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
