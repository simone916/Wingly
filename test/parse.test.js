import test from 'node:test';
import assert from 'node:assert/strict';
import { parseMedia } from '../server/parse.js';
import { srtToVtt, shiftVtt } from '../server/subtitles.js';

test('movies', () => {
  assert.deepEqual(parseMedia('/m/The.Matrix.1999.1080p.BluRay.x264-GRP.mkv'), {
    kind: 'movie', title: 'The Matrix', year: 1999,
  });
  assert.deepEqual(parseMedia('/m/Blade Runner 2049 (2017)/Blade Runner 2049 (2017).mp4'), {
    kind: 'movie', title: 'Blade Runner 2049', year: 2017,
  });
  assert.deepEqual(parseMedia('/m/1917.mkv'), { kind: 'movie', title: '1917', year: null });
  assert.deepEqual(parseMedia('/m/2001.A.Space.Odyssey.1968.REMASTERED.mkv'), {
    kind: 'movie', title: '2001 A Space Odyssey', year: 1968,
  });
  assert.deepEqual(parseMedia('/m/[Group] Spirited_Away_[720p].mkv'), {
    kind: 'movie', title: 'Spirited Away', year: null,
  });
  assert.deepEqual(parseMedia('/m/Heat (1995)/movie.mkv'), { kind: 'movie', title: 'Heat', year: 1995 });
});

test('episodes', () => {
  assert.deepEqual(parseMedia('/tv/Breaking.Bad.S01E02.Cat\'s.in.the.Bag.720p.HDTV.mkv', 'show'), {
    kind: 'episode', showTitle: 'Breaking Bad', season: 1, episode: 2, title: "Cat's in the Bag", year: null,
  });
  assert.deepEqual(parseMedia('/tv/The Office (2005)/Season 2/S02E03.mkv', 'show'), {
    kind: 'episode', showTitle: 'The Office', season: 2, episode: 3, title: 'Episode 3', year: 2005,
  });
  assert.deepEqual(parseMedia('/tv/Firefly/firefly 1x04 shindig.avi', 'show'), {
    kind: 'episode', showTitle: 'firefly', season: 1, episode: 4, title: 'shindig', year: null,
  });
  assert.deepEqual(parseMedia('/tv/Cosmos/Season 1/07 - The Backbone of Night.mp4', 'show'), {
    kind: 'episode', showTitle: 'Cosmos', season: 1, episode: 7, title: 'The Backbone of Night', year: null,
  });
});

test('subtitles', () => {
  const vtt = srtToVtt('1\r\n00:00:01,000 --> 00:00:02,500\r\nHello\r\n\r\n2\r\n00:01:00,000 --> 00:01:02,000\r\nBye\r\n');
  assert.match(vtt, /^WEBVTT\n\n/);
  assert.match(vtt, /00:00:01\.000 --> 00:00:02\.500\nHello/);
  const shifted = shiftVtt(vtt, 30);
  assert.doesNotMatch(shifted, /Hello/); // cue ended before the new start
  assert.match(shifted, /00:00:30\.000 --> 00:00:32\.000\nBye/);
});
