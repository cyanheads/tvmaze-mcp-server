/**
 * @fileoverview Tests for the TVMAZE_* environment configuration — the schema
 * bounds that decide what a deployment may point the server's upstream at.
 * Each case re-imports the module because `getServerConfig()` memoizes.
 * @module tests/config/server-config.test
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

const ORIGINAL_BASE_URL = process.env.TVMAZE_BASE_URL;

/** Parse the server config with one `TVMAZE_BASE_URL` value, bypassing the memo. */
async function parseWithBaseUrl(baseUrl: string | undefined) {
  vi.resetModules();
  if (baseUrl === undefined) delete process.env.TVMAZE_BASE_URL;
  else process.env.TVMAZE_BASE_URL = baseUrl;
  const { getServerConfig } = await import('@/config/server-config.js');
  return getServerConfig();
}

afterEach(() => {
  if (ORIGINAL_BASE_URL === undefined) delete process.env.TVMAZE_BASE_URL;
  else process.env.TVMAZE_BASE_URL = ORIGINAL_BASE_URL;
});

describe('TVMAZE_BASE_URL', () => {
  it('defaults to the public TVmaze API when unset', async () => {
    await expect(parseWithBaseUrl(undefined)).resolves.toMatchObject({
      baseUrl: 'https://api.tvmaze.com',
    });
  });

  it('accepts an http or https override', async () => {
    await expect(parseWithBaseUrl('http://tvmaze.internal:8080')).resolves.toMatchObject({
      baseUrl: 'http://tvmaze.internal:8080',
    });
    await expect(parseWithBaseUrl('https://mirror.example.test/api')).resolves.toMatchObject({
      baseUrl: 'https://mirror.example.test/api',
    });
  });

  it('rejects a non-http scheme at startup rather than handing it to fetch', async () => {
    await expect(parseWithBaseUrl('file:///etc/passwd')).rejects.toThrow();
    await expect(parseWithBaseUrl('ftp://example.test')).rejects.toThrow();
    await expect(parseWithBaseUrl('javascript:alert(1)')).rejects.toThrow();
  });
});
