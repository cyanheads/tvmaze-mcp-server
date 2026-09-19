/**
 * @fileoverview Shared per-file harness for tvmaze_* tool tests: points the
 * TvmazeService singleton at a fake base URL, installs a fresh
 * `createFetchMock` before every test, and tears both down after. Every tool
 * test file calls `installTvmazeToolHarness()` once at module scope, then
 * reaches for `getHttp()` inside each test to register routes.
 * @module tests/helpers/tvmaze-tool-harness
 */

import { createFetchMock, type FetchMockHarness } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach } from 'vitest';

import { disposeTvmazeService, initTvmazeService } from '@/services/tvmaze/tvmaze-service.js';

/** Base URL every tool test's fetch routes match against. */
export const TVMAZE_TEST_BASE_URL = 'https://tvmaze.test';

/**
 * Registers `beforeEach`/`afterEach` hooks that give every test in the calling
 * file a fresh `TvmazeService` singleton (fresh pacer, empty cache) wired to
 * `TVMAZE_TEST_BASE_URL`, with a fresh fetch mock installed as `globalThis.fetch`.
 * Returns an accessor for the current test's harness.
 */
export function installTvmazeToolHarness(): () => FetchMockHarness {
  process.env.TVMAZE_BASE_URL = TVMAZE_TEST_BASE_URL;
  process.env.TVMAZE_USER_AGENT = 'tvmaze-mcp-server/test';
  process.env.TVMAZE_DEFAULT_TIMEZONE = 'UTC';
  process.env.TVMAZE_DEFAULT_COUNTRY = 'US';
  process.env.TVMAZE_CACHE_TTL_S = '0';
  process.env.TVMAZE_MAX_CONCURRENCY = '4';
  process.env.TVMAZE_REQUEST_TIMEOUT_MS = '10000';

  let http: FetchMockHarness | undefined;

  beforeEach(() => {
    http = createFetchMock();
    http.install();
    initTvmazeService();
  });

  afterEach(() => {
    disposeTvmazeService();
    http?.restore();
  });

  return () => {
    if (!http) throw new Error('getHttp() called outside a test — no fetch mock installed yet.');
    return http;
  };
}
