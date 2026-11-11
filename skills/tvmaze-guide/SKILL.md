---
name: tvmaze-guide
description: Use the tvmaze_* tools to resolve same-name series, check schedule coverage for a channel or streaming service, identify an overnight episode from a viewer's date, or verify an episode credit.
license: Apache-2.0
metadata:
  author: "cyanheads"
  version: "1.0"
---

## Scope

Use TVmaze for television metadata, scheduled broadcasts and releases, and recorded credits. It needs no API key. Use a playback catalog for viewing availability or subscription access.

## Identifiers

- Resolve a title with `tvmaze_search_shows` or an IMDb, TheTVDB, or TVRage show ID with `tvmaze_lookup_show`. A schedule row's nested show or a person's credit can also carry a TVmaze show ID.
- Read the season number from `tvmaze_get_show` before requesting a season from `tvmaze_get_episodes`.
- Use the TVmaze episode ID from an episode list, schedule row, profile or next-episode result, or a person's guest credit. Pass it to the episode scope of `tvmaze_get_cast`.
- Get a TVmaze person ID from `tvmaze_get_cast` or a candidate from `tvmaze_get_person`. Check available identifying details before selecting a person when names collide.

## Gates

- Resolve same-name shows against a known premiere year or carrier before asking for the next episode or credits. A fuzzy rank or a single best title match is a lead. If title search hits its ten-result ceiling, narrow the title or look up a known external ID. A resolved show with no scheduled next episode supports “TVmaze lists no upcoming episode.” Its previous episode can show where the series left off.
- Before reporting a missing release, confirm the requested date and that `applied_feeds` includes every feed relevant to the question. Read partial-feed notices and retry any missing feed needed for the answer. When scanning for a title across schedule rows, continue through the relevant pages before reporting a miss. Limit the conclusion to the feeds TVmaze returned.
- Before reporting a missing credit, check the credit category and scope. The show cast list has no recurring-versus-guest flag. Community records can be sparse, so report what TVmaze credits.

## Workflows

### Find a release on a named channel

Choose the feed for the service and country in the question. When the relevant coverage spans linear, local web and global web, request all three for that country. On an empty channel result, read the retry guidance and browse without the channel filter if the exact name is uncertain. The filter matches the recorded network or web-channel name, so check both carriers even if the row displays just one as its channel.

### Find an episode by the viewer's calendar date

For a resolved show, a date lookup in `tvmaze_get_episodes` checks the source's programming date. If the question is about the viewer's calendar date, use `tvmaze_get_show` to identify the applicable season, then page through that season in `tvmaze_get_episodes` using the viewer's timezone. Compare `local_date` for timed episodes and include specials when relevant. For an untimed episode, preserve the source date when available and report the time as unknown. A late-night slot can cross midnight in the viewer's timezone.

### Verify an episode credit

Resolve the show and episode first, then call `tvmaze_get_cast` for that episode's guest credits. Include guest crew when the question asks about an episode role such as writer or director. When starting with a person, resolve their identity with `tvmaze_get_person`, choose guest credits, and follow any returned episode ID back to the episode's credits. Show-level credits answer a separate question about the series.
