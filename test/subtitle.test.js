import test from 'node:test';
import assert from 'node:assert/strict';

import { detectFormat, loadSubtitles, matchSubtitles } from '../src/subtitle.js';

const SRT = `1
00:00:01,000 --> 00:00:03,500
Hello world

2
00:00:05,000 --> 00:00:07,000
foo bar baz

3
00:00:08,000 --> 00:00:10,000
Hello again
`;

const VTT = `WEBVTT

00:00:01.000 --> 00:00:03.500
Hello world

00:00:05.000 --> 00:00:07.000
foo bar baz

1:00:08.000 --> 1:00:10.000
Hello again
`;

const SRT_STYLED = `1
00:00:01,000 --> 00:00:02,000 position:50% align:center
<i>Styled</i> line
`;

test('detectFormat picks vtt for WEBVTT header', () => {
  assert.equal(detectFormat('a.txt', 'WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nhello'), 'vtt');
  assert.equal(detectFormat('a.vtt', '00:00:01.000 --> 00:00:02.000\nhello'), 'vtt');
  assert.equal(detectFormat('a.srt', 'WEBVTT\n'), 'srt');
  assert.equal(detectFormat('a.txt', '1\n00:00:01,000 --> 00:00:03,000\nhello'), 'srt');
});

test('parseSrt returns correct entries', async () => {
  const entries = await loadSubtitles('/fake/subs.srt', {
    readFileFn: async () => SRT,
  });
  assert.equal(entries.length, 3);
  assert.equal(entries[0].start, 1);
  assert.equal(entries[0].end, 3.5);
  assert.equal(entries[0].text, 'Hello world');
  assert.equal(entries[1].start, 5);
  assert.equal(entries[2].text, 'Hello again');
});

test('parseSrt strips HTML tags', async () => {
  const entries = await loadSubtitles('/fake/subs.srt', {
    readFileFn: async () => SRT_STYLED,
  });
  assert.equal(entries[0].text, 'Styled line');
});

test('parseVtt returns correct entries', async () => {
  const entries = await loadSubtitles('/fake/subs.vtt', {
    readFileFn: async () => VTT,
  });
  assert.equal(entries.length, 3);
  assert.equal(entries[0].start, 1);
  assert.equal(entries[0].end, 3.5);
  assert.equal(entries[2].start, 3608); // 1:00:08
  assert.equal(entries[2].end, 3610);
});

test('loadSubtitles throws on empty file', async () => {
  await assert.rejects(
    loadSubtitles('/fake/subs.srt', { readFileFn: async () => '' }),
    /No subtitle entries/,
  );
});

test('loadSubtitles throws on read error', async () => {
  await assert.rejects(
    loadSubtitles('/fake/missing.srt', { readFileFn: async () => { throw new Error('ENOENT'); } }),
    /Could not read/,
  );
});

test('matchSubtitles case-insensitive by default', async () => {
  const entries = await loadSubtitles('/fake/subs.srt', { readFileFn: async () => SRT });
  const matches = matchSubtitles(entries, { query: 'hello' });
  assert.equal(matches.length, 2);
  assert.equal(matches[0].text, 'Hello world');
});

test('matchSubtitles case-sensitive mode', async () => {
  const entries = await loadSubtitles('/fake/subs.srt', { readFileFn: async () => SRT });
  const matches = matchSubtitles(entries, { query: 'hello', caseSensitive: true });
  assert.equal(matches.length, 0);
  const exact = matchSubtitles(entries, { query: 'Hello', caseSensitive: true });
  assert.equal(exact.length, 2);
});

test('matchSubtitles applies pad', async () => {
  const entries = await loadSubtitles('/fake/subs.srt', { readFileFn: async () => SRT });
  const matches = matchSubtitles(entries, { query: 'foo', pad: 1 });
  assert.equal(matches.length, 1);
  assert.equal(matches[0].start, 4);   // 5 - 1
  assert.equal(matches[0].end, 8);     // 7 + 1
});

test('matchSubtitles pad does not go below zero', async () => {
  const entries = await loadSubtitles('/fake/subs.srt', { readFileFn: async () => SRT });
  const matches = matchSubtitles(entries, { query: 'Hello world', pad: 5 });
  assert.equal(matches[0].start, 0);   // max(0, 1 - 5)
});

test('matchSubtitles returns empty array when nothing matches', async () => {
  const entries = await loadSubtitles('/fake/subs.srt', { readFileFn: async () => SRT });
  assert.deepEqual(matchSubtitles(entries, { query: 'xyz' }), []);
});
