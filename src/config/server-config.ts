/**
 * @fileoverview Server-specific configuration for tvmaze-mcp-server, parsed
 * lazily from environment variables. Every variable is optional — TVmaze is a
 * keyless public API, so the server runs with nothing set.
 * @module config/server-config
 */

import { z } from '@cyanheads/mcp-ts-core';
import { parseEnvConfig } from '@cyanheads/mcp-ts-core/config';

const ServerConfigSchema = z.object({
  baseUrl: z
    .url()
    .default('https://api.tvmaze.com')
    .describe('TVmaze API base URL. Override to point at an enterprise endpoint.'),
  userAgent: z
    .string()
    .min(1)
    .optional()
    .describe(
      'User-Agent sent on every upstream request. Defaults to the server name, version, and repository URL.',
    ),
  defaultTimezone: z
    .string()
    .min(1)
    .default('UTC')
    .describe('IANA timezone used when a tool call omits `timezone`.'),
  defaultCountry: z
    .string()
    .regex(/^[A-Za-z]{2}$/)
    .default('US')
    .describe(
      'ISO 3166-1 alpha-2 country used for tvmaze_get_schedule scopes "linear" and "all" when `country` is omitted.',
    ),
  cacheTtlS: z.coerce
    .number()
    .int()
    .min(0)
    .default(300)
    .describe('Seconds to hold an upstream response in the in-process cache. 0 disables caching.'),
  maxConcurrency: z.coerce
    .number()
    .int()
    .min(1)
    .max(16)
    .default(4)
    .describe('Concurrent upstream requests.'),
  requestTimeoutMs: z.coerce
    .number()
    .int()
    .min(1_000)
    .max(120_000)
    .default(10_000)
    .describe('Per-request timeout in milliseconds.'),
});

export type ServerConfig = z.infer<typeof ServerConfigSchema>;

let _config: ServerConfig | undefined;

/** Lazily parse and memoize the server's own environment configuration. */
export function getServerConfig(): ServerConfig {
  _config ??= parseEnvConfig(ServerConfigSchema, {
    baseUrl: 'TVMAZE_BASE_URL',
    userAgent: 'TVMAZE_USER_AGENT',
    defaultTimezone: 'TVMAZE_DEFAULT_TIMEZONE',
    defaultCountry: 'TVMAZE_DEFAULT_COUNTRY',
    cacheTtlS: 'TVMAZE_CACHE_TTL_S',
    maxConcurrency: 'TVMAZE_MAX_CONCURRENCY',
    requestTimeoutMs: 'TVMAZE_REQUEST_TIMEOUT_MS',
  });
  return _config;
}
