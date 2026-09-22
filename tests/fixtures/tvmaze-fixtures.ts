/**
 * @fileoverview Trimmed copies of real TVmaze response shapes, as recorded in
 * docs/design.md's API Reference (verified against api.tvmaze.com 2026-09-19).
 * Every builder returns a fresh object — callers may mutate the result or pass
 * overrides without leaking state across tests.
 * @module tests/fixtures/tvmaze-fixtures
 */

import type {
  RawCastCredit,
  RawCrewCredit,
  RawEpisode,
  RawGuestCrewCredit,
  RawSearchHit,
  RawSeason,
  RawShow,
} from '@/services/tvmaze/types.js';

/** A full show record — network-carried, every optional field populated. */
export function rawShow(overrides: Partial<RawShow> = {}): RawShow {
  return {
    id: 169,
    url: 'https://www.tvmaze.com/shows/169/breaking-bad',
    name: 'Breaking Bad',
    type: 'Scripted',
    language: 'English',
    genres: ['Drama', 'Crime', 'Thriller'],
    status: 'Ended',
    runtime: 60,
    averageRuntime: 47,
    premiered: '2008-01-20',
    ended: '2013-09-29',
    officialSite: 'https://www.amc.com/shows/breaking-bad',
    schedule: { time: '22:00', days: ['Sunday'] },
    rating: { average: 9.3 },
    network: {
      id: 20,
      name: 'AMC',
      country: { name: 'United States', code: 'US', timezone: 'America/New_York' },
      officialSite: 'https://www.amc.com/',
    },
    webChannel: null,
    externals: { tvrage: 18164, thetvdb: 81189, imdb: 'tt0903747' },
    image: {
      medium: 'https://static.tvmaze.com/uploads/images/medium_portrait/0/2400.jpg',
      original: 'https://static.tvmaze.com/uploads/images/original_untouched/0/2400.jpg',
    },
    summary:
      '<p><b>Breaking Bad</b> follows protagonist Walter White.</p><p>A high school chemistry teacher.</p>',
    updated: 1_600_000_000,
    _links: {},
    ...overrides,
  } as RawShow;
}

/** A show with only a `network`, no `webChannel`, no externals/rating/summary/image. */
export function rawShowSparse(overrides: Partial<RawShow> = {}): RawShow {
  return {
    id: 999,
    url: 'https://www.tvmaze.com/shows/999/small-title',
    name: 'A Small Title',
    genres: [],
    ...overrides,
  } as RawShow;
}

/** A show carried only by a streaming service — `webChannel` set, `network` absent. */
export function rawShowStreaming(overrides: Partial<RawShow> = {}): RawShow {
  return {
    id: 500,
    url: 'https://www.tvmaze.com/shows/500/streaming-show',
    name: 'Streaming Show',
    type: 'Scripted',
    genres: ['Drama'],
    status: 'Running',
    webChannel: {
      id: 200,
      name: 'Netflix',
      country: null,
      officialSite: 'https://www.netflix.com',
    },
    network: null,
    externals: {},
    ...overrides,
  } as RawShow;
}

/** A regular, numbered, announced-time episode. */
export function rawEpisode(overrides: Partial<RawEpisode> = {}): RawEpisode {
  return {
    id: 11,
    url: 'https://www.tvmaze.com/episodes/11/breaking-bad-1x01-pilot',
    name: 'Pilot',
    season: 1,
    number: 1,
    type: 'regular',
    airdate: '2008-01-20',
    airtime: '22:00',
    airstamp: '2008-01-21T03:00:00+00:00',
    runtime: 58,
    rating: { average: 8.7 },
    image: {
      medium: 'https://static.tvmaze.com/uploads/images/medium_landscape/0/1.jpg',
      original: 'https://static.tvmaze.com/uploads/images/original_untouched/0/1.jpg',
    },
    summary: '<p>Walter White begins his transformation.</p>',
    ...overrides,
  } as RawEpisode;
}

/** A special: unnumbered, classified as anything other than "regular". */
export function rawEpisodeSpecial(overrides: Partial<RawEpisode> = {}): RawEpisode {
  return {
    id: 12,
    url: 'https://www.tvmaze.com/episodes/12/doctor-who-a-christmas-special',
    name: 'A Christmas Special',
    season: 2015,
    number: undefined,
    type: 'significant_special',
    airdate: '2015-12-25',
    airtime: '19:30',
    airstamp: '2015-12-25T19:30:00+00:00',
    ...overrides,
  } as unknown as RawEpisode;
}

/**
 * A global-streaming placeholder row: `airtime` is empty and `airstamp` sits at
 * the synthetic `T12:00:00+00:00` marker TVmaze uses when no clock time was
 * ever announced (measured: 117 of 133 such rows in one day's feed).
 */
export function rawEpisodeNoTime(overrides: Partial<RawEpisode> = {}): RawEpisode {
  return {
    id: 13,
    url: 'https://www.tvmaze.com/episodes/13/streaming-release',
    name: 'Streaming Release',
    season: 3,
    number: 5,
    type: 'regular',
    airdate: '2026-09-18',
    airtime: '',
    airstamp: '2026-09-18T12:00:00+00:00',
    ...overrides,
  } as RawEpisode;
}

/** A season header, network-carried. */
export function rawSeason(overrides: Partial<RawSeason> = {}): RawSeason {
  return {
    id: 1,
    url: 'https://www.tvmaze.com/seasons/1/breaking-bad-season-1',
    number: 1,
    name: '',
    episodeOrder: 7,
    premiereDate: '2008-01-20',
    endDate: '2008-03-09',
    network: {
      id: 20,
      name: 'AMC',
      country: { name: 'United States', code: 'US', timezone: 'America/New_York' },
    },
    webChannel: null,
    ...overrides,
  } as RawSeason;
}

/** A `/search/shows` row: `{ score, show }`. */
export function rawSearchHit(overrides: Partial<RawSearchHit> = {}): RawSearchHit {
  return { score: 0.9, show: rawShow(), ...overrides };
}

/** A cast row — `{ person, character, self, voice }`. */
export function rawCastCredit(overrides: Partial<RawCastCredit> = {}): RawCastCredit {
  return {
    person: {
      id: 1,
      url: 'https://www.tvmaze.com/people/1/bryan-cranston',
      name: 'Bryan Cranston',
      image: {
        medium: 'https://static.tvmaze.com/uploads/images/medium_portrait/0/10.jpg',
        original: 'https://static.tvmaze.com/uploads/images/original_untouched/0/10.jpg',
      },
    },
    character: {
      id: 2,
      url: 'https://www.tvmaze.com/characters/2/breaking-bad-walter-white',
      name: 'Walter White',
      image: null,
    },
    self: false,
    voice: false,
    ...overrides,
  } as RawCastCredit;
}

/** A crew row — `{ type, person }`, no character/self/voice. */
export function rawCrewCredit(overrides: Partial<RawCrewCredit> = {}): RawCrewCredit {
  return {
    type: 'Executive Producer',
    person: {
      id: 3,
      url: 'https://www.tvmaze.com/people/3/vince-gilligan',
      name: 'Vince Gilligan',
      image: null,
    },
    ...overrides,
  } as RawCrewCredit;
}

/**
 * An episode guest-crew row from the `guestcrew` embed — `{ person, guestCrewType }`,
 * not the show-crew `{ type, person }` shape (verified on episode 2939679).
 */
export function rawGuestCrewCredit(
  overrides: Partial<RawGuestCrewCredit> = {},
): RawGuestCrewCredit {
  return {
    guestCrewType: 'Director',
    person: {
      id: 39_582,
      url: 'https://www.tvmaze.com/people/39582/ben-stiller',
      name: 'Ben Stiller',
      image: {
        medium: 'https://static.tvmaze.com/uploads/images/medium_portrait/10/25671.jpg',
        original: 'https://static.tvmaze.com/uploads/images/original_untouched/10/25671.jpg',
      },
    },
    ...overrides,
  } as RawGuestCrewCredit;
}

/** `count` distinct cast rows, person ids `firstId`, `firstId + 1`, … in order. */
export function rawCastCredits(count: number, firstId = 1): RawCastCredit[] {
  return Array.from({ length: count }, (_, index) =>
    rawCastCredit({
      person: {
        id: firstId + index,
        url: `https://www.tvmaze.com/people/${firstId + index}/performer`,
        name: `Performer ${firstId + index}`,
      },
    }),
  );
}

/** `count` distinct crew rows, person ids `firstId`, `firstId + 1`, … in order. */
export function rawCrewCredits(count: number, firstId = 1000): RawCrewCredit[] {
  return Array.from({ length: count }, (_, index) =>
    rawCrewCredit({
      person: {
        id: firstId + index,
        url: `https://www.tvmaze.com/people/${firstId + index}/crew-member`,
        name: `Crew ${firstId + index}`,
      },
    }),
  );
}

/** The upstream JSON error envelope TVmaze returns for a non-2xx. */
export function tvmazeErrorBody(name: string, message: string, status: number): string {
  return JSON.stringify({ name, message, code: 0, status });
}
