/**
 * @fileoverview Local paging for the tvmaze_* list tools. TVmaze returns each
 * list whole, so the tools page it in memory. The cursor carries only a
 * position: the page size comes from the current call's `limit` every time,
 * which the framework's `paginateArray` does not do (it reads the size back
 * out of the cursor, freezing the first call's limit).
 * @module mcp-server/tools/definitions/paging
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import { decodeCursor, encodeCursor } from '@cyanheads/mcp-ts-core/utils';

/** The highest page size any list tool's `limit` allows. */
export const MAX_PAGE_SIZE = 250;

/** The page size a list tool applies when `limit` is omitted. */
export const DEFAULT_PAGE_SIZE = 50;

/** One page of a locally paged list. */
export interface Page<T> {
  items: T[];
  /** Page size applied to this call. */
  limit: number;
  /** Continuation token. Absent on the last page. */
  nextCursor?: string;
  /** Zero-based position of `items[0]` in the full list. */
  offset: number;
  /** Page size requested before applying the ceiling. */
  requestedLimit: number;
  /** Length of the full list. */
  total: number;
}

/**
 * Slice one page out of `items`. A cursor from any release decodes to its
 * `offset`, and the `limit` it also carries is ignored. New cursors still encode
 * `limit` because `decodeCursor` rejects a state without one.
 */
export function pageOf<T>(
  items: readonly T[],
  cursor: string | undefined,
  limit: number,
  ctx: Context,
): Page<T> {
  const requestedLimit = limit;
  limit = Math.min(limit, MAX_PAGE_SIZE);
  const offset = cursor ? decodeCursor(cursor, ctx).offset : 0;
  const slice = items.slice(offset, offset + limit);
  const end = offset + slice.length;
  return {
    items: slice,
    limit,
    requestedLimit,
    offset,
    total: items.length,
    ...(end < items.length ? { nextCursor: encodeCursor({ offset: end, limit }) } : {}),
  };
}

/**
 * Write `totalCount` always, `shown` / `cap` when clamped or more rows follow,
 * and `truncated` only when more rows follow. `ctx.enrich.notice` is last-wins, so the
 * truncation guidance and the tool's own `fragments` are joined into one
 * notice here instead of each being written separately.
 */
export function enrichPage(
  ctx: Context,
  page: Page<unknown>,
  noun: string,
  fragments: readonly string[] = [],
): void {
  ctx.enrich.total(page.total);
  const notices = [...fragments];
  if (page.requestedLimit > page.limit) {
    ctx.enrich({ shown: page.items.length, cap: page.limit });
    notices.unshift(
      `Requested limit ${page.requestedLimit} exceeds the cap ${page.limit}; returned ${page.items.length} ${noun}.`,
    );
  }
  if (page.nextCursor) {
    const first = page.offset + 1;
    const last = page.offset + page.items.length;
    const guidance = `Showing ${noun} ${first}–${last} of ${page.total}. Call again with cursor set to next_cursor for the next page; limit sets the page size, up to ${MAX_PAGE_SIZE}.`;
    ctx.enrich.truncated({
      shown: page.items.length,
      cap: page.limit,
      guidance: [guidance, ...notices].join(' '),
    });
  } else if (notices.length > 0) {
    ctx.enrich.notice(notices.join(' '));
  }
}
