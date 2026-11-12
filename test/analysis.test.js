import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { readDisabledTools, FRAME_TOOLS } from '../src/config.js';
import { bucketLoudness, createMedia, evenlySpacedTimes, invertIntervals, parseIntervals, parseLoudness, parseSceneOutput, pickPeaks } from '../src/media.js';
import { buildProject } from '../src/project.js';
import { connect, startFakeLosslessCut, textOf } from './helpers.js';

const hasFfmpeg = (() => {
  try {
    execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
    execFileSync('ffprobe', ['-version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

test('parses ffmpeg analysis output', () => {
  assert.deepEqual(parseSceneOutput('frame:0 pts:90 pts_time:3\nlavfi.scene_score=0.912345\nframe:1 pts:300 pts_time:10.5\nlavfi.scene_score=0.4\n', 2), [
    { time: 5, score: 0.912 }, { time: 12.5, score: 0.4 },
  ]);
  const silence = parseIntervals('[silencedetect] silence_start: 1.5\n[silencedetect] silence_end: 2.75 | silence_duration: 1.25\n[silencedetect] silence_start: 9\n', 'silence_start', 'silence_end', { offset: 10, rangeEnd: 20 });
  assert.deepEqual(silence, [{ start: 11.5, end: 12.75, duration: 1.25 }, { start: 19, end: 20, duration: 1 }]);
  assert.deepEqual(parseIntervals('black_start:0 black_end:1.2 black_duration:1.2', 'black_start', 'black_end'), [{ start: 0, end: 1.2, duration: 1.2 }]);
  assert.deepEqual(invertIntervals([{ start: 2, end: 3 }], 0, 5), [{ start: 0, end: 2, duration: 2 }, { start: 3, end: 5, duration: 2 }]);
  const loud = parseLoudness('[Parsed_ebur128_0 @ 1] t: 0.1  TARGET:-23 LUFS M: -30.5 S:-120.7\n t: 1.6 TARGET:-23 LUFS M: -10.0 S: -9\n  Integrated loudness:\n    I:         -18.2 LUFS\n'.replace('Integrated loudness:\n    I:', 'Integrated loudness: I:'));
  assert.equal(loud.frames.length, 2);
  assert.equal(loud.integrated, -18.2);
  const buckets = bucketLoudness(loud.frames, 0, 2, 1);
  assert.deepEqual(buckets, [{ start: 0, loudnessLufs: -30.5 }, { start: 1, loudnessLufs: -10 }]);
  assert.deepEqual(pickPeaks(buckets, 1, 2), [{ start: 1, loudnessLufs: -10 }]);
  assert.deepEqual(evenlySpacedTimes(0, 8, 4), [1, 3, 5, 7]);
});

test('frame tools can be turned off', async () => {
  assert.deepEqual(readDisabledTools(['--no-frames'], {}), FRAME_TOOLS);
  assert.deepEqual(readDisabledTools([], { LOSSLESSCUT_MCP_FRAMES: 'off' }), FRAME_TOOLS);
  assert.deepEqual(readDisabledTools(['--disable-tools', 'detect_scenes, audio_levels'], {}), ['detect_scenes', 'audio_levels']);
  assert.deepEqual(readDisabledTools([], {}), []);
  const fake = await startFakeLosslessCut();
  const mcp = await connect({ port: fake.port, statFn: async () => ({ isFile: () => true }), disabledTools: readDisabledTools(['--no-frames'], {}) });
  const names = (await mcp.listTools()).tools.map((t) => t.name);
  assert.equal(names.includes('view_frames'), false);
  assert.equal(names.includes('contact_sheet'), false);
  assert.equal(names.includes('detect_scenes'), true);
  await mcp.close();
  await fake.close();
});

test('set_segments writes a project, keeps a backup and opens the media', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'llc-mcp-test-'));
  const media = path.join(dir, 'clip.mp4');
  await writeFile(media, 'x');
  await writeFile(path.join(dir, 'clip-proj.llc'), 'old');
  const fake = await startFakeLosslessCut();
  const mcp = await connect({ port: fake.port, media: { duration: async () => 10 } });
  const result = await mcp.call('set_segments', { path: media, segments: [{ start: 1, end: '00:03' }, { start: 5, end: 20, name: 'b\nc' }] });
  assert.equal(result.isError, undefined, textOf(result));
  const project = JSON.parse(await readFile(path.join(dir, 'clip-proj.llc'), 'utf8'));
  assert.deepEqual(project, buildProject(media, [{ start: 1, end: 3 }, { start: 5, end: 10, name: 'b c' }]));
  assert.ok((await readdir(dir)).some((f) => f.endsWith('.bak')));
  assert.deepEqual(fake.actions(), ['closeCurrentFile', 'openFiles']);
  assert.deepEqual(fake.requests.at(-1).body, [media]);
  const bad = await mcp.call('set_segments', { path: media, segments: [{ start: 11, end: 12 }] });
  assert.equal(bad.isError, true);
  await mcp.close();
  await fake.close();
  await rm(dir, { recursive: true, force: true });
});

test('media analysis with real ffmpeg', { skip: !hasFfmpeg && 'ffmpeg not installed' }, async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'llc-mcp-media-'));
  const file = path.join(dir, 'in.mp4');
  execFileSync('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'color=c=red:s=320x240:r=25:d=3',
    '-f', 'lavfi', '-i', 'color=c=blue:s=320x240:r=25:d=3',
    '-f', 'lavfi', '-i', 'sine=f=440:d=2',
    '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=mono:d=2',
    '-f', 'lavfi', '-i', 'sine=f=880:d=2',
    '-filter_complex', '[0:v][1:v]concat=n=2:v=1:a=0[v];[2:a][3:a][4:a]concat=n=3:v=0:a=1[a]',
    '-map', '[v]', '-map', '[a]', '-c:v', 'libx264', '-g', '25', '-pix_fmt', 'yuv420p', '-c:a', 'aac', file,
  ]);
  const media = createMedia();
  const info = await media.info(file);
  assert.equal(Math.round(info.durationSeconds), 6);
  assert.deepEqual(info.streams.map((s) => s.type).sort(), ['audio', 'video']);
  const frames = await media.frames(file, { times: [1, 4], width: 160 });
  assert.equal(frames.length, 2);
  assert.equal(frames[0].data[0], 0xff);
  const sheet = await media.contactSheet(file, { columns: 2, rows: 2, width: 320 });
  assert.equal(sheet.times.length, 4);
  assert.ok(sheet.image.length > 1000);
  const scenes = await media.scenes(file, { threshold: 0.3, limit: 10 });
  assert.ok(scenes.scenes.some((s) => Math.abs(s.time - 3) < 0.1), JSON.stringify(scenes));
  const silence = await media.silence(file, { noiseDb: -40, minDuration: 0.5 });
  assert.ok(silence.silences.some((s) => Math.abs(s.start - 2) < 0.2 && Math.abs(s.end - 4) < 0.2), JSON.stringify(silence));
  const loud = await media.loudness(file, { windowSeconds: 1, top: 2 });
  assert.equal(loud.windows.length, 6);
  assert.ok(loud.windows[2].loudnessLufs < loud.windows[0].loudnessLufs);
  const keys = await media.keyframes(file, { near: [2.5], limit: 50 });
  assert.ok(keys.keyframes.includes(0));
  assert.equal(keys.nearest[0].keyframeBefore, 2);
  const late = await media.scenes(file, { start: 2, end: 5, threshold: 0.3, limit: 10 });
  assert.ok(late.scenes.some((s) => Math.abs(s.time - 3) < 0.1), JSON.stringify(late));
  await rm(dir, { recursive: true, force: true });
});
