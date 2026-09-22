/**
 * @fileoverview Raw TVmaze record shapes and the normalized domain types this
 * server exposes. Raw fields are optional or nullable by default — TVmaze is
 * community-maintained and omits or nulls liberally, so absence is preserved
 * as absence rather than coerced into a concrete value.
 * @module services/tvmaze/types
 */

// ---------------------------------------------------------------------------
// Raw upstream shapes
// ---------------------------------------------------------------------------

/** An image in TVmaze's two published sizes. */
export interface RawImage {
  medium?: string | null;
  original?: string | null;
}

/** The country block hanging off a network or web channel. */
export interface RawCountry {
  code?: string | null;
  name?: string | null;
  timezone?: string | null;
}

/** A broadcast network or a streaming service. */
export interface RawChannel {
  country?: RawCountry | null;
  id?: number;
  name?: string | null;
  officialSite?: string | null;
}

/** TVmaze wraps every community rating in an object whose `average` is usually null. */
export interface RawRating {
  average?: number | null;
}

/** Ids for a show in other catalogs. */
export interface RawExternals {
  imdb?: string | null;
  thetvdb?: number | null;
  tvrage?: number | null;
}

/** A person credited on a show or episode. */
export interface RawPerson {
  id: number;
  image?: RawImage | null;
  name: string;
  url: string;
}

/** A character a person plays. */
export interface RawCharacter {
  id: number;
  image?: RawImage | null;
  name: string;
  url: string;
}

/** A cast row — `/shows/{id}/cast` and `/episodes/{id}/guestcast` share this shape. */
export interface RawCastCredit {
  character?: RawCharacter | null;
  person: RawPerson;
  self?: boolean | null;
  voice?: boolean | null;
}

/** A crew row — `{ type, person }`, with no character, self, or voice fields. */
export interface RawCrewCredit {
  person: RawPerson;
  type?: string | null;
}

/**
 * An episode guest-crew row from the `guestcrew` embed — `{ person, guestCrewType }`,
 * a different key from the show-crew row's `type`.
 */
export interface RawGuestCrewCredit {
  guestCrewType?: string | null;
  person: RawPerson;
}

/** A season header from `/shows/{id}/seasons` or the `seasons` embed. */
export interface RawSeason {
  endDate?: string | null;
  episodeOrder?: number | null;
  id: number;
  name?: string | null;
  network?: RawChannel | null;
  number: number;
  premiereDate?: string | null;
  url: string;
  webChannel?: RawChannel | null;
}

/** A show record. `_embedded` holds only the embeds that resolved. */
export interface RawShow {
  _embedded?: {
    nextepisode?: RawEpisode;
    previousepisode?: RawEpisode;
    seasons?: RawSeason[];
  } | null;
  averageRuntime?: number | null;
  ended?: string | null;
  externals?: RawExternals | null;
  genres?: string[] | null;
  id: number;
  image?: RawImage | null;
  language?: string | null;
  name: string;
  network?: RawChannel | null;
  officialSite?: string | null;
  premiered?: string | null;
  rating?: RawRating | null;
  runtime?: number | null;
  schedule?: { time?: string | null; days?: string[] | null } | null;
  status?: string | null;
  summary?: string | null;
  type?: string | null;
  url: string;
  webChannel?: RawChannel | null;
}

/**
 * An episode record. Schedule rows carry the show at `show` (linear feed) or at
 * `_embedded.show` (streaming feed) — never both. `/episodes/{id}` carries the
 * credits embeds it was asked for.
 */
export interface RawEpisode {
  _embedded?: {
    guestcast?: RawCastCredit[];
    guestcrew?: RawGuestCrewCredit[];
    show?: RawShow;
  } | null;
  airdate?: string | null;
  airstamp: string;
  airtime?: string | null;
  id: number;
  image?: RawImage | null;
  name: string;
  number?: number | null;
  rating?: RawRating | null;
  runtime?: number | null;
  season: number;
  show?: RawShow | null;
  summary?: string | null;
  type: string;
  url: string;
}

/** A `/search/shows` row — a relevance score wrapped around a show. */
export interface RawSearchHit {
  score: number;
  show: RawShow;
}

// ---------------------------------------------------------------------------
// Normalized domain shapes
// ---------------------------------------------------------------------------

/** Show identity and profile summary, shared by search results, lookups, and episode listings. */
export interface ShowSummary {
  average_runtime_minutes?: number;
  channel?: string;
  channel_country?: string;
  channel_type?: 'network' | 'web_channel';
  ended?: string;
  externals: { imdb?: string; thetvdb?: number; tvrage?: number };
  genres: string[];
  id: number;
  image_url?: string;
  language?: string;
  name: string;
  premiered?: string;
  rating?: number;
  runtime_minutes?: number;
  status?: string;
  summary?: string;
  type?: string;
  url: string;
}

/** A search result — a show plus the source's relevance score. */
export interface ShowSearchHit extends ShowSummary {
  match_score: number;
}

/** A full show profile: the summary plus the fields only `/shows/{id}` carries. */
export interface ShowProfile extends ShowSummary {
  official_site?: string;
  schedule_days: string[];
  schedule_time?: string;
}

/** An episode with its air time resolved into the requested timezone. */
export interface Episode {
  airstamp: string;
  id: number;
  image_url?: string;
  local_date: string;
  local_time?: string;
  name: string;
  number?: number;
  rating?: number;
  runtime_minutes?: number;
  season: number;
  summary?: string;
  time_known: boolean;
  type: string;
  url: string;
}

/** A season header. */
export interface Season {
  channel?: string;
  end_date?: string;
  episode_order?: number;
  id: number;
  name?: string;
  number: number;
  premiere_date?: string;
}

/** One person credited on a show or episode. Crew rows leave the character fields absent. */
export interface CastCredit {
  as_self?: boolean;
  character_name?: string;
  character_url?: string;
  credit_type?: string;
  person_id: number;
  person_image_url?: string;
  person_name: string;
  person_url: string;
  voice_only?: boolean;
}

/** A show profile with the embeds `/shows/{id}` was asked for. */
export interface ShowDetail {
  next_episode?: Episode;
  previous_episode?: Episode;
  seasons: Season[];
  show: ShowProfile;
}

/**
 * The compact show reference a schedule row carries. A day's schedule repeats a
 * show on every episode it airs, so the row holds identity and channel only;
 * the full profile is one `/shows/{id}` call away.
 */
export type ScheduleShow = Pick<
  ShowSummary,
  'id' | 'name' | 'url' | 'type' | 'channel' | 'channel_type' | 'channel_country' | 'genres'
>;

/** A schedule row — an episode plus the show it belongs to and the feed it came from. */
export interface ScheduleEntry extends Episode {
  feed: 'linear' | 'streaming';
  show: ScheduleShow;
}

/** Which upstream schedule feed a single request reads. */
export type ScheduleFeed =
  | { kind: 'linear'; country: string }
  | { kind: 'web'; country: string }
  | { kind: 'web-global' };

/** The external catalogs `/lookup/shows` accepts. */
export type LookupSource = 'imdb' | 'thetvdb' | 'tvrage';
