'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  analyzeListenBrainzMusicBrainzCandidate,
  normalizeText,
} = require('../scripts/lib/precheck/listenbrainz-mb-analysis');
const {
  fetchMusicBrainzRecordingByMbid,
  fetchMusicBrainzReleaseByMbid,
} = require('../scripts/lib/sources/musicbrainz-recording');

const RECORDING_MBID = '11111111-1111-1111-1111-111111111111';
const RELEASE_MBID = '22222222-2222-2222-2222-222222222222';

function tempCacheFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'musicbrainz-recording-cache-'));
  return path.join(dir, 'cache.json');
}

function row(overrides = {}) {
  return {
    title: 'Sailing',
    artist: 'Rod Stewart',
    estimated_year: '1975',
    mb_year: '2008',
    discogs_year: '1975',
    spotify_album_name: 'Atlantic Crossing',
    status: 'review_needed',
    notes: 'open',
    ...overrides,
  };
}

function lb(overrides = {}) {
  return {
    status: 'ok',
    recording_mbid: RECORDING_MBID,
    recording_name: 'Sailing',
    release_mbid: RELEASE_MBID,
    release_name: 'Atlantic Crossing',
    ...overrides,
  };
}

function recording(overrides = {}) {
  return {
    status: 'ok',
    id: RECORDING_MBID,
    title: 'Sailing',
    artist_credit_name: 'Rod Stewart',
    year: 1975,
    year_source: 'recording_first_release_date',
    releases: [],
    ...overrides,
  };
}

function release(overrides = {}) {
  return {
    status: 'ok',
    id: RELEASE_MBID,
    title: 'Atlantic Crossing',
    artist_credit_name: 'Rod Stewart',
    release_group: {
      title: 'Atlantic Crossing',
      primary_type: 'Album',
      secondary_types: [],
    },
    ...overrides,
  };
}

async function analyzeWithMocks(inputRow, {
  listenBrainz = lb(),
  musicBrainzRecording = recording(),
  musicBrainzRelease = release(),
} = {}) {
  return analyzeListenBrainzMusicBrainzCandidate(inputRow, {
    listenBrainzLookup: async () => listenBrainz,
    fetchRecording: async () => musicBrainzRecording,
    fetchRelease: async () => musicBrainzRelease,
  });
}

test('Sailing is a useful alternative MB year', async () => {
  const result = await analyzeWithMocks(row());

  assert.equal(result.listenbrainz_match_status, 'ok');
  assert.equal(result.listenbrainz_year_signal, 'alternative_earlier_than_current_mb');
  assert.equal(result.listenbrainz_recommendation, 'useful_alternative_mb_year');
  assert.equal(result.listenbrainz_candidate_quality, 'useful_conflict_candidate');
  assert.equal(result.listenbrainz_mb_year, 1975);
  assert.equal(result.listenbrainz_year_delta_vs_current_mb, -33);
});

test('Summer Wine is a useful alternative MB year', async () => {
  const result = await analyzeWithMocks(row({
    title: 'Summer Wine',
    artist: 'Nancy Sinatra, Lee Hazlewood',
    estimated_year: '1968',
    mb_year: '1986',
    discogs_year: '1967',
    spotify_album_name: 'Nancy & Lee',
  }), {
    listenBrainz: lb({
      recording_name: 'Summer Wine',
      release_name: 'Nancy & Lee',
    }),
    musicBrainzRecording: recording({
      title: 'Summer Wine',
      artist_credit_name: 'Nancy Sinatra & Lee Hazlewood',
      year: 1968,
    }),
    musicBrainzRelease: release({
      title: 'Nancy & Lee',
      artist_credit_name: 'Nancy Sinatra & Lee Hazlewood',
    }),
  });

  assert.equal(result.listenbrainz_recommendation, 'useful_alternative_mb_year');
  assert.equal(result.listenbrainz_year_signal, 'alternative_earlier_than_current_mb');
  assert.equal(result.listenbrainz_year_delta_vs_spotify, 0);
});

test('Boys title normalization handles parentheses and Summer Time vs Summertime', async () => {
  assert.equal(normalizeText('Boys - Summertime Love'), normalizeText('Boys (Summer Time Love)'));

  const result = await analyzeWithMocks(row({
    title: 'Boys - Summertime Love',
    artist: 'Sabrina',
    estimated_year: '1988',
    mb_year: '2026',
    discogs_year: '1987',
    spotify_album_name: 'Sabrina',
  }), {
    listenBrainz: lb({
      recording_name: 'Boys (Summer Time Love)',
      release_name: 'Sabrina',
    }),
    musicBrainzRecording: recording({
      title: 'Boys (Summer Time Love)',
      artist_credit_name: 'Sabrina',
      year: 1987,
    }),
    musicBrainzRelease: release({
      title: 'Sabrina',
      artist_credit_name: 'Sabrina',
    }),
  });

  assert.equal(result.listenbrainz_recommendation, 'useful_alternative_mb_year');
  assert.doesNotMatch(result.listenbrainz_context_flags, /title_mismatch/);
});

test('Queen soundtrack context is a warning, not a strong candidate', async () => {
  const result = await analyzeWithMocks(row({
    title: 'I Want To Break Free',
    artist: 'Queen',
    estimated_year: '2018',
    mb_year: '2018',
    discogs_year: '',
    spotify_album_name: 'Bohemian Rhapsody (The Original Soundtrack)',
  }), {
    listenBrainz: lb({
      recording_name: 'I Want To Break Free',
      release_name: 'Bohemian Rhapsody: The Original Soundtrack',
    }),
    musicBrainzRecording: recording({
      title: 'I Want To Break Free',
      artist_credit_name: 'Queen',
      year: 2018,
    }),
    musicBrainzRelease: release({
      title: 'Bohemian Rhapsody: The Original Soundtrack',
      artist_credit_name: 'Queen',
      release_group: {
        title: 'Bohemian Rhapsody: The Original Soundtrack',
        primary_type: 'Album',
        secondary_types: ['Soundtrack'],
      },
    }),
  });

  assert.equal(result.listenbrainz_year_signal, 'confirms_current_mb_and_spotify');
  assert.equal(result.listenbrainz_recommendation, 'likely_accept_existing_mb_with_context_warning');
  assert.match(result.listenbrainz_context_flags, /soundtrack_context/);
  assert.notEqual(result.listenbrainz_candidate_quality, 'strong_candidate');
});

test('Ab in den Süden Neuaufnahme is manual version risk', async () => {
  const result = await analyzeWithMocks(row({
    title: 'Ab in den Süden - Neuaufnahme',
    artist: 'Buddy',
    estimated_year: '2014',
    mb_year: '2015',
    discogs_year: '',
    spotify_album_name: 'Dschungel Fieber 2014',
  }), {
    listenBrainz: lb({
      recording_name: 'Ab in den Süden - Neuaufnahme',
      release_name: 'Dschungel Fieber 2014',
    }),
    musicBrainzRecording: recording({
      title: 'Ab in den Süden - Neuaufnahme',
      artist_credit_name: 'Buddy',
      year: 2014,
    }),
    musicBrainzRelease: release({
      title: 'Dschungel Fieber 2014',
      artist_credit_name: 'Various Artists',
    }),
  });

  assert.match(result.listenbrainz_version_flags, /neuaufnahme/);
  assert.equal(result.listenbrainz_recommendation, 'manual_version_risk');
});

test('Lambada Original Version year hint is conflicting, not strong', async () => {
  const result = await analyzeWithMocks(row({
    title: 'Lambada - Original Version 1989',
    artist: 'Kaoma',
    estimated_year: '1989',
    mb_year: '2017',
    discogs_year: '',
    spotify_album_name: "Lambada - Les originaux No. 1 de l'été (Original 1989)",
  }), {
    listenBrainz: lb({
      recording_name: 'Lambada',
      release_name: "Lambada - Les originaux No. 1 de l'été (Original 1989)",
    }),
    musicBrainzRecording: recording({
      title: 'Lambada',
      artist_credit_name: 'Kaoma',
      year: 2017,
    }),
    musicBrainzRelease: release({
      title: "Lambada - Les originaux No. 1 de l'été (Original 1989)",
      artist_credit_name: 'Kaoma',
    }),
  });

  assert.match(result.listenbrainz_version_flags, /original_version_year_hint/);
  assert.equal(result.listenbrainz_year_signal, 'confirms_current_mb');
  assert.equal(result.listenbrainz_recommendation, 'manual_conflicting_years');
  assert.notEqual(result.listenbrainz_candidate_quality, 'strong_candidate');
});

test('Shape of You is not made noisy by the ÷ release', async () => {
  const result = await analyzeWithMocks(row({
    title: 'Shape of You',
    artist: 'Ed Sheeran',
    estimated_year: '2017',
    mb_year: '2017',
    discogs_year: '',
    spotify_album_name: '÷ (Deluxe)',
  }), {
    listenBrainz: lb({
      recording_name: 'Shape of You',
      release_name: '÷',
    }),
    musicBrainzRecording: recording({
      title: 'Shape of You',
      artist_credit_name: 'Ed Sheeran',
      year: 2017,
    }),
    musicBrainzRelease: release({
      title: '÷',
      artist_credit_name: 'Ed Sheeran',
    }),
  });

  assert.equal(result.listenbrainz_match_status, 'ok');
  assert.equal(result.listenbrainz_year_signal, 'confirms_current_mb_and_spotify');
  assert.ok(
    ['likely_accept_existing_mb', 'likely_accept_existing_mb_with_context_warning']
      .includes(result.listenbrainz_recommendation)
  );
});

test('CAN’T STOP THE FEELING keeps soundtrack as context warning', async () => {
  const result = await analyzeWithMocks(row({
    title: 'CAN\'T STOP THE FEELING! (from DreamWorks Animation\'s "TROLLS")',
    artist: 'Justin Timberlake',
    estimated_year: '2016',
    mb_year: '2016',
    discogs_year: '',
    spotify_album_name: 'TROLLS (Original Motion Picture Soundtrack)',
  }), {
    listenBrainz: lb({
      recording_name: 'CAN’T STOP THE FEELING!',
      release_name: 'CAN’T STOP THE FEELING!',
    }),
    musicBrainzRecording: recording({
      title: 'CAN’T STOP THE FEELING!',
      artist_credit_name: 'Justin Timberlake',
      year: 2016,
    }),
    musicBrainzRelease: release({
      title: 'CAN’T STOP THE FEELING!',
      artist_credit_name: 'Justin Timberlake',
    }),
  });

  assert.match(result.listenbrainz_context_flags, /soundtrack_context/);
  assert.equal(result.listenbrainz_recommendation, 'likely_accept_existing_mb_with_context_warning');
});

test('You Really Got Me deluxe context is warning, not unusable', async () => {
  const result = await analyzeWithMocks(row({
    title: 'You Really Got Me',
    artist: 'The Kinks',
    estimated_year: '1964',
    mb_year: '1964',
    discogs_year: '',
    spotify_album_name: 'Kinks (Deluxe)',
  }), {
    listenBrainz: lb({
      recording_name: 'You Really Got Me',
      release_name: 'Kinks (deluxe)',
    }),
    musicBrainzRecording: recording({
      title: 'You Really Got Me',
      artist_credit_name: 'The Kinks',
      year: 1964,
    }),
    musicBrainzRelease: release({
      title: 'Kinks (deluxe)',
      artist_credit_name: 'The Kinks',
    }),
  });

  assert.match(result.listenbrainz_context_flags, /deluxe_context/);
  assert.equal(result.listenbrainz_recommendation, 'likely_accept_existing_mb_with_context_warning');
  assert.notEqual(result.listenbrainz_recommendation, 'unusable');
});

test('missing ListenBrainz recording MBID becomes no_mbid and unusable', async () => {
  const result = await analyzeWithMocks(row(), {
    listenBrainz: lb({
      recording_mbid: '',
      release_mbid: RELEASE_MBID,
    }),
  });

  assert.equal(result.listenbrainz_match_status, 'no_mbid');
  assert.equal(result.listenbrainz_candidate_quality, 'no_match_or_error');
  assert.equal(result.listenbrainz_recommendation, 'unusable');
});

test('MusicBrainz error does not crash and remains analyzable', async () => {
  const result = await analyzeWithMocks(row(), {
    musicBrainzRecording: {
      status: 'error',
      error: 'http_503',
    },
  });

  assert.equal(result.listenbrainz_match_status, 'error');
  assert.equal(result.listenbrainz_recommendation, 'unusable');
  assert.equal(result.status, 'musicbrainz_recording_error');
  assert.equal(result.error, 'http_503');
});

test('MusicBrainz recording cache hit avoids repeated fetch', async () => {
  const cacheFile = tempCacheFile();
  let fetchCalls = 0;

  const fetchImpl = async () => {
    fetchCalls++;
    return {
      ok: true,
      status: 200,
      headers: {},
      json: async () => ({
        id: RECORDING_MBID,
        title: 'Boys (Summer Time Love)',
        'artist-credit': [{ name: 'Sabrina' }],
        'first-release-date': '1987-01-01',
        releases: [],
      }),
    };
  };

  const first = await fetchMusicBrainzRecordingByMbid(RECORDING_MBID, {
    cacheFile,
    fetchImpl,
    rateLimit: false,
  });
  const second = await fetchMusicBrainzRecordingByMbid(RECORDING_MBID, {
    cacheFile,
    fetchImpl: async () => {
      fetchCalls++;
      throw new Error('cache miss');
    },
    rateLimit: false,
  });

  assert.equal(first.status, 'ok');
  assert.equal(second.status, 'ok');
  assert.equal(second.cache_hit, true);
  assert.equal(second.year, 1987);
  assert.equal(fetchCalls, 1);
});

test('MusicBrainz release cache hit avoids repeated fetch', async () => {
  const cacheFile = tempCacheFile();
  let fetchCalls = 0;

  const fetchImpl = async () => {
    fetchCalls++;
    return {
      ok: true,
      status: 200,
      headers: {},
      json: async () => ({
        id: RELEASE_MBID,
        title: 'Sabrina',
        date: '1987-01-01',
        'artist-credit': [{ name: 'Sabrina' }],
        'release-group': {
          id: '33333333-3333-3333-3333-333333333333',
          title: 'Sabrina',
          'primary-type': 'Album',
          'first-release-date': '1987-01-01',
        },
      }),
    };
  };

  const first = await fetchMusicBrainzReleaseByMbid(RELEASE_MBID, {
    cacheFile,
    fetchImpl,
    rateLimit: false,
  });
  const second = await fetchMusicBrainzReleaseByMbid(RELEASE_MBID, {
    cacheFile,
    fetchImpl: async () => {
      fetchCalls++;
      throw new Error('cache miss');
    },
    rateLimit: false,
  });

  assert.equal(first.status, 'ok');
  assert.equal(second.status, 'ok');
  assert.equal(second.cache_hit, true);
  assert.equal(second.year, 1987);
  assert.equal(fetchCalls, 1);
});
