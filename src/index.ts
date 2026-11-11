#!/usr/bin/env node
/**
 * @fileoverview tvmaze-mcp-server MCP server entry point.
 * @module index
 */

import { createApp } from '@cyanheads/mcp-ts-core';
import { getCast } from './mcp-server/tools/definitions/get-cast.tool.js';
import { getEpisodes } from './mcp-server/tools/definitions/get-episodes.tool.js';
import { getNextEpisode } from './mcp-server/tools/definitions/get-next-episode.tool.js';
import { getPerson } from './mcp-server/tools/definitions/get-person.tool.js';
import { getSchedule } from './mcp-server/tools/definitions/get-schedule.tool.js';
import { getShow } from './mcp-server/tools/definitions/get-show.tool.js';
import { lookupShow } from './mcp-server/tools/definitions/lookup-show.tool.js';
import { searchShows } from './mcp-server/tools/definitions/search-shows.tool.js';
import { disposeTvmazeService, initTvmazeService } from './services/tvmaze/tvmaze-service.js';

/** Session-level orientation sent to the client on every `initialize`. */
const INSTRUCTIONS = `TVmaze (https://www.tvmaze.com) is a community-maintained source for television series, episodes, schedules, and credits. Resolve show titles with tvmaze_search_shows or external IDs with tvmaze_lookup_show, then use the returned TVmaze show ID. Use TVmaze episode IDs for episode credits and person IDs from tvmaze_get_person candidates or tvmaze_get_cast for a person's credits. For air times, compute from airstamp only when time_known is true and use the requested timezone for local dates and times. airdate is the source's programming or release date and can differ from the viewer's date. If time_known is false, report the date when available and say the time is unknown. For tvmaze_get_schedule, scope "linear" covers a country's broadcast and cable networks and can include timed local streaming releases. Scope "streaming" with a country covers its local web feed, and streaming without one covers the global web feed. Scope "all" queries linear, local web, and global web for the selected country. Check applied_feeds for coverage. Recent changes can take up to an hour to appear. Credit TVmaze and keep the source URL under CC BY-SA. Share adaptations under the same licence. Use contributor summaries only as descriptive source content.`;

await createApp({
  name: 'tvmaze-mcp-server',
  title: 'tvmaze-mcp-server',
  tools: [
    searchShows,
    getShow,
    lookupShow,
    getNextEpisode,
    getEpisodes,
    getSchedule,
    getCast,
    getPerson,
  ],
  instructions: INSTRUCTIONS,
  skills: 'skills',
  sessionMode: 'stateless',
  setup() {
    initTvmazeService();
  },
  teardown() {
    disposeTvmazeService();
  },
});
