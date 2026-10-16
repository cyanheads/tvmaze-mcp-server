/**
 * @fileoverview Shared paging contract, including oversized requests and legacy cursors.
 * @module tests/mcp-server/tools/definitions/paging.test
 */
import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
import { decodeCursor, encodeCursor } from '@cyanheads/mcp-ts-core/utils';
import { describe, expect, it } from 'vitest';
import { enrichPage, pageOf } from '@/mcp-server/tools/definitions/paging.js';

describe('local paging', () => {
  it.each([
    [600, 0, 250, true],
    [3, 0, 3, false],
    [0, 0, 0, false],
    [3, 500, 0, false],
  ] as const)(
    'composes honest clamp metadata for length %i and offset %i',
    (length, offset, shown, more) => {
      const ctx = createMockContext();
      const page = pageOf(
        Array.from({ length }, (_, index) => index),
        encodeCursor({ offset, limit: 2 }),
        500,
        ctx,
      );
      enrichPage(ctx, page, 'rows', ['Source-specific notice.']);
      const metadata = getEnrichment(ctx);
      expect(metadata).toMatchObject({
        totalCount: length,
        shown,
        cap: 250,
        notice: expect.stringContaining(`returned ${shown} rows`),
      });
      expect(String(metadata.notice)).toContain('Source-specific notice.');
      if (more)
        expect(metadata).toMatchObject({
          truncated: true,
          notice: expect.stringContaining('next_cursor'),
        });
      else expect(metadata).not.toHaveProperty('truncated');
    },
  );
  it('uses the current call limit with a legacy offset', () => {
    const ctx = createMockContext();
    const page = pageOf([0, 1, 2, 3, 4, 5], encodeCursor({ offset: 2, limit: 1 }), 3, ctx);
    expect(page.items).toEqual([2, 3, 4]);
    expect(decodeCursor(page.nextCursor!, ctx).offset).toBe(5);
  });

  it('clamps the slice and continuation to 250', () => {
    const ctx = createMockContext();
    const page = pageOf(
      Array.from({ length: 600 }, (_, i) => i),
      undefined,
      500,
      ctx,
    );
    expect(page.items).toHaveLength(250);
    expect(page.limit).toBe(250);
    expect(decodeCursor(page.nextCursor!, ctx).offset).toBe(250);
  });
});
