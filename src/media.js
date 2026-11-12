import { stat } from 'node:fs/promises';

import { mapLimit, runProcess, ToolError } from './process.js';

const round = (n, digits = 3) => Math.round(n * 10 ** digits) / 10 ** digits;
const num = (value) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
};

export function parseRate(rate) {
  if (typeof rate !== 'string') return undefined;
  const [a, b] = rate.split('/').map(Number);
  if (!Number.isFinite(a) || !Number.isFinite(b) || b === 0) return undefined;
  return round(a / b, 3);
}

export function parseSceneOutput(text, offset = 0) {
  const scenes = [];
  let time;
  for (const line of text.split(/\r?\n/)) {
    const t = /pts_time:([\d.]+)/.exec(line);
    if (t) time = Number(t[1]);
    const s = /lavfi\.scene_score=([\d.]+)/.exec(line);
    if (s && time != null) {
      scenes.push({ time: round(time + offset), score: round(Number(s[1]), 3) });
      time = undefined;
    }
  }
  return scenes;
}

export function parseIntervals(text, startKey, endKey, { offset = 0, rangeEnd } = {}) {
  const intervals = [];
  let open;
  const startRe = new RegExp(`${startKey}[:=]\\s*(-?[\\d.]+)`);
  const endRe = new RegExp(`${endKey}[:=]\\s*(-?[\\d.]+)`);
  for (const line of text.split(/\r?\n/)) {
    const s = startRe.exec(line);
    const e = endRe.exec(line);
    if (s && e) {
      intervals.push({ start: Number(s[1]), end: Number(e[1]) });
      open = undefined;
    } else if (s) {
      open = Number(s[1]);
    } else if (e && open != null) {
      intervals.push({ start: open, end: Number(e[1]) });
      open = undefined;
    }
  }
  if (open != null && rangeEnd != null) intervals.push({ start: open, end: rangeEnd - offset });
  return intervals
    .map(({ start, end }) => ({ start: round(Math.max(0, start) + offset), end: round(end + offset) }))
    .map((i) => ({ ...i, duration: round(i.end - i.start) }))
    .filter((i) => i.duration > 0);
}

export function invertIntervals(intervals, start, end) {
  const result = [];
  let cursor = start;
  for (const i of [...intervals].sort((a, b) => a.start - b.start)) {
    if (i.start > cursor) result.push({ start: round(cursor), end: round(i.start), duration: round(i.start - cursor) });
    cursor = Math.max(cursor, i.end);
  }
  if (end > cursor) result.push({ start: round(cursor), end: round(end), duration: round(end - cursor) });
  return result.filter((i) => i.duration > 0.01);
}

export function parseLoudness(text, offset = 0) {
  const frames = [];
  for (const line of text.split(/\r?\n/)) {
    const m = /\bt:\s*([\d.]+)\s.*?\bM:\s*(-?[\d.]+|-inf)/.exec(line);
    if (m) frames.push({ t: Number(m[1]) + offset, m: m[2] === '-inf' ? -120 : Number(m[2]) });
  }
  const integrated = /Integrated loudness:\s*I:\s*(-?[\d.]+)/.exec(text);
  const range = /Loudness range:\s*LRA:\s*(-?[\d.]+)/.exec(text);
  return { frames, integrated: integrated ? Number(integrated[1]) : undefined, lra: range ? Number(range[1]) : undefined };
}

export function bucketLoudness(frames, start, end, windowSeconds) {
  const count = Math.max(1, Math.ceil((end - start) / windowSeconds));
  const buckets = Array.from({ length: count }, (_, i) => ({ start: round(start + i * windowSeconds), max: -120 }));
  for (const f of frames) {
    const i = Math.min(count - 1, Math.max(0, Math.floor((f.t - start) / windowSeconds)));
    if (f.m > buckets[i].max) buckets[i].max = f.m;
  }
  return buckets.map((b) => ({ start: b.start, loudnessLufs: round(b.max, 1) }));
}

export function pickPeaks(buckets, top, minGap) {
  const peaks = [];
  for (const b of [...buckets].sort((a, c) => c.loudnessLufs - a.loudnessLufs)) {
    if (b.loudnessLufs <= -70) break;
    if (peaks.every((p) => Math.abs(p.start - b.start) >= minGap)) peaks.push(b);
    if (peaks.length >= top) break;
  }
  return peaks.sort((a, b) => a.start - b.start);
}

export function evenlySpacedTimes(start, end, count) {
  const span = end - start;
  return Array.from({ length: count }, (_, i) => round(start + ((i + 0.5) * span) / count));
}

export function createMedia({
  ffmpeg = process.env.LOSSLESSCUT_MCP_FFMPEG || 'ffmpeg',
  ffprobe = process.env.LOSSLESSCUT_MCP_FFPROBE || 'ffprobe',
  run = runProcess,
} = {}) {
  const probeCache = new Map();

  async function probe(file) {
    const info = await stat(file);
    const key = `${file}|${info.size}|${info.mtimeMs}`;
    if (probeCache.has(key)) return probeCache.get(key);
    const { stdout } = await run(ffprobe, ['-v', 'error', '-show_format', '-show_streams', '-show_chapters', '-of', 'json', file], { timeoutMs: 60_000 });
    let data;
    try {
      data = JSON.parse(stdout.toString('utf8'));
    } catch {
      throw new ToolError('ffprobe returned invalid data.', 'BAD_PROBE');
    }
    if (probeCache.size > 50) probeCache.clear();
    probeCache.set(key, data);
    return data;
  }

  async function duration(file) {
    const data = await probe(file);
    const d = num(data.format?.duration) ?? Math.max(0, ...(data.streams ?? []).map((s) => num(s.duration) ?? 0));
    if (!d) throw new ToolError('Could not read the duration of this file.', 'NO_DURATION');
    return d;
  }

  async function range(file, start, end) {
    const total = await duration(file);
    const s = start ?? 0;
    const e = Math.min(end ?? total, total);
    if (s >= total) throw new RangeError(`start is beyond the end of the file (${round(total)} s).`);
    if (e <= s) throw new RangeError('end must be after start.');
    return { start: s, end: e, total };
  }

  const rangeArgs = (r) => (r.start > 0 || r.end < r.total ? ['-ss', String(r.start), '-t', String(round(r.end - r.start, 6))] : []);

  async function info(file) {
    const data = await probe(file);
    const fmt = data.format ?? {};
    return {
      file,
      container: fmt.format_long_name ?? fmt.format_name,
      durationSeconds: round(num(fmt.duration) ?? 0),
      sizeBytes: num(fmt.size),
      bitRate: num(fmt.bit_rate),
      streams: (data.streams ?? []).map((s) => ({
        index: s.index,
        type: s.codec_type,
        codec: s.codec_name,
        ...(s.codec_type === 'video' ? { width: s.width, height: s.height, fps: parseRate(s.avg_frame_rate) ?? parseRate(s.r_frame_rate), pixelFormat: s.pix_fmt } : {}),
        ...(s.codec_type === 'audio' ? { sampleRate: num(s.sample_rate), channels: s.channels, channelLayout: s.channel_layout } : {}),
        ...(s.tags?.language ? { language: s.tags.language } : {}),
        ...(s.tags?.title ? { title: s.tags.title } : {}),
        ...(num(s.duration) ? { durationSeconds: round(num(s.duration)) } : {}),
      })),
      chapters: (data.chapters ?? []).map((c) => ({ start: round(num(c.start_time) ?? 0), end: round(num(c.end_time) ?? 0), title: c.tags?.title })),
    };
  }

  async function hasStream(file, type) {
    const data = await probe(file);
    return (data.streams ?? []).some((s) => s.codec_type === type && s.disposition?.attached_pic !== 1);
  }

  async function frameAt(file, time, width) {
    const { stdout } = await run(ffmpeg, [
      '-nostdin', '-hide_banner', '-loglevel', 'error', '-ss', String(time), '-i', file,
      '-frames:v', '1', '-vf', `scale=${width}:-2`, '-q:v', '4', '-f', 'image2pipe', '-c:v', 'mjpeg', '-',
    ], { timeoutMs: 60_000, maxBytes: 16 * 1024 * 1024 });
    if (stdout.length === 0) throw new ToolError(`No video frame at ${round(time)} s.`, 'NO_FRAME');
    return stdout;
  }

  async function frames(file, { times, count, start, end, width }) {
    if (!(await hasStream(file, 'video'))) throw new ToolError('This file has no video stream.', 'NO_VIDEO');
    let list = times;
    if (!list?.length) {
      const r = await range(file, start, end);
      list = evenlySpacedTimes(r.start, r.end, count);
    } else {
      const total = await duration(file);
      list = list.map((t) => Math.min(t, Math.max(0, total - 0.05)));
    }
    return mapLimit(list, 4, async (time) => ({ time: round(time), data: await frameAt(file, time, width) }));
  }

  async function contactSheet(file, { start, end, columns, rows, width }) {
    if (!(await hasStream(file, 'video'))) throw new ToolError('This file has no video stream.', 'NO_VIDEO');
    const r = await range(file, start, end);
    const times = evenlySpacedTimes(r.start, r.end, columns * rows);
    const tileWidth = Math.max(64, Math.floor(width / columns / 2) * 2);
    const images = await mapLimit(times, 4, (t) => frameAt(file, t, tileWidth));
    const { stdout } = await run(ffmpeg, [
      '-nostdin', '-hide_banner', '-loglevel', 'error', '-f', 'image2pipe', '-c:v', 'mjpeg', '-i', '-',
      '-vf', `tile=${columns}x${rows}:padding=4:color=black`, '-frames:v', '1', '-q:v', '4', '-f', 'image2pipe', '-c:v', 'mjpeg', '-',
    ], { input: Buffer.concat(images), timeoutMs: 60_000, maxBytes: 32 * 1024 * 1024 });
    return { image: stdout, times, columns, rows };
  }

  async function scenes(file, { threshold, start, end, limit }) {
    if (!(await hasStream(file, 'video'))) throw new ToolError('This file has no video stream.', 'NO_VIDEO');
    const r = await range(file, start, end);
    const { stdout } = await run(ffmpeg, [
      '-nostdin', '-hide_banner', '-nostats', '-loglevel', 'error', ...rangeArgs(r), '-i', file, '-an', '-sn', '-dn',
      '-vf', `scale=320:-2,select='gt(scene,${threshold})',metadata=print:file=-`, '-f', 'null', '-',
    ]);
    const all = parseSceneOutput(stdout.toString('utf8'), r.start);
    return { range: { start: round(r.start), end: round(r.end) }, count: all.length, scenes: all.slice(0, limit), truncated: all.length > limit };
  }

  async function silence(file, { noiseDb, minDuration, start, end }) {
    if (!(await hasStream(file, 'audio'))) throw new ToolError('This file has no audio stream.', 'NO_AUDIO');
    const r = await range(file, start, end);
    const { stderr } = await run(ffmpeg, [
      '-nostdin', '-hide_banner', '-nostats', ...rangeArgs(r), '-i', file, '-vn', '-sn', '-dn',
      '-af', `silencedetect=noise=${noiseDb}dB:duration=${minDuration}`, '-f', 'null', '-',
    ]);
    const silences = parseIntervals(stderr, 'silence_start', 'silence_end', { offset: r.start, rangeEnd: r.end });
    const sounds = invertIntervals(silences, r.start, r.end);
    return { range: { start: round(r.start), end: round(r.end) }, silences, nonSilent: sounds };
  }

  async function black(file, { minDuration, pictureThreshold, start, end }) {
    if (!(await hasStream(file, 'video'))) throw new ToolError('This file has no video stream.', 'NO_VIDEO');
    const r = await range(file, start, end);
    const { stderr } = await run(ffmpeg, [
      '-nostdin', '-hide_banner', '-nostats', ...rangeArgs(r), '-i', file, '-an', '-sn', '-dn',
      '-vf', `blackdetect=d=${minDuration}:pic_th=${pictureThreshold}`, '-f', 'null', '-',
    ]);
    return { range: { start: round(r.start), end: round(r.end) }, black: parseIntervals(stderr, 'black_start', 'black_end', { offset: r.start, rangeEnd: r.end }) };
  }

  async function loudness(file, { start, end, windowSeconds, top }) {
    if (!(await hasStream(file, 'audio'))) throw new ToolError('This file has no audio stream.', 'NO_AUDIO');
    const r = await range(file, start, end);
    const span = r.end - r.start;
    const window = windowSeconds ?? Math.max(1, Math.ceil(span / 150));
    const { stderr } = await run(ffmpeg, [
      '-nostdin', '-hide_banner', '-nostats', ...rangeArgs(r), '-i', file, '-vn', '-sn', '-dn',
      '-af', 'ebur128=framelog=32', '-f', 'null', '-',
    ]);
    const parsed = parseLoudness(stderr, r.start);
    const buckets = bucketLoudness(parsed.frames, r.start, r.end, window);
    return {
      range: { start: round(r.start), end: round(r.end) },
      integratedLufs: parsed.integrated,
      loudnessRangeLu: parsed.lra,
      windowSeconds: window,
      loudest: pickPeaks(buckets, top, window * 2),
      windows: buckets,
    };
  }

  async function keyframes(file, { start, end, near, limit }) {
    if (!(await hasStream(file, 'video'))) throw new ToolError('This file has no video stream.', 'NO_VIDEO');
    const r = await range(file, start, end);
    const { stdout } = await run(ffprobe, [
      '-v', 'error', '-select_streams', 'v:0', '-skip_frame', 'nokey', '-read_intervals', `${r.start}%${r.end}`,
      '-show_entries', 'frame=pts_time,best_effort_timestamp_time', '-of', 'csv=p=0', file,
    ], { timeoutMs: 300_000 });
    const times = [...new Set(stdout.toString('utf8').split(/\r?\n/)
      .map((line) => line.split(',').map(Number).find((n) => Number.isFinite(n)))
      .filter((t) => t != null && t >= r.start - 0.001 && t <= r.end + 0.001)
      .map((t) => round(t)))].sort((a, b) => a - b);
    const nearest = (near ?? []).map((t) => {
      let before;
      let after;
      for (const k of times) {
        if (k <= t) before = k;
        if (k >= t && after == null) after = k;
      }
      return { time: round(t), keyframeBefore: before ?? null, keyframeAfter: after ?? null };
    });
    return { range: { start: round(r.start), end: round(r.end) }, count: times.length, keyframes: times.slice(0, limit), truncated: times.length > limit, nearest };
  }

  async function version(bin) {
    const { stdout } = await run(bin, ['-hide_banner', '-version'], { timeoutMs: 15_000 });
    return stdout.toString('utf8').split(/\r?\n/)[0];
  }

  return { ffmpeg, ffprobe, run, probe, info, duration, range, rangeArgs, frames, contactSheet, scenes, silence, black, loudness, keyframes, version };
}
