import { z } from 'zod';

import { parseTime, formatTimecode } from './timecode.js';
import { guarded, json, pathSchema, timeSchema, validateFilePath } from './tooling.js';

const rangeShape = {
  start: timeSchema.optional().describe('Start of the part to analyse (default: start of file)'),
  end: timeSchema.optional().describe('End of the part to analyse (default: end of file)'),
};

const optTime = (t) => (t == null ? undefined : parseTime(t));

export function registerAnalysisTools({ tool, media, statFn }) {
  const file = (p) => validateFilePath(p, { statFn });

  tool('check_tools', {
    title: 'Check analysis tools',
    description: 'Reports whether FFmpeg and FFprobe, which the analysis tools use, are available.',
    inputSchema: {},
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, guarded(async () => {
    const safe = async (fn) => {
      try {
        return await fn();
      } catch (err) {
        return `unavailable: ${err.message}`;
      }
    };
    return json({ ffmpeg: await safe(() => media.version(media.ffmpeg)), ffprobe: await safe(() => media.version(media.ffprobe)) });
  }));

  tool('media_info', {
    title: 'Media info',
    description: 'Duration, container, streams (codecs, resolution, fps, audio channels, languages) and chapters of a media file.',
    inputSchema: { path: pathSchema },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, guarded(async ({ path: p }) => json(await media.info(await file(p)))));

  tool('view_frames', {
    title: 'View frames',
    description: 'Returns video frames as images so you can see the content. Give exact times, or a count of evenly spaced frames within start/end.',
    inputSchema: {
      path: pathSchema,
      times: z.array(timeSchema).min(1).max(16).optional(),
      count: z.number().int().min(1).max(16).default(4),
      ...rangeShape,
      width: z.number().int().min(160).max(1280).default(640),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, guarded(async ({ path: p, times, count = 4, start, end, width = 640 }) => {
    const frames = await media.frames(await file(p), { times: times?.map(parseTime), count, start: optTime(start), end: optTime(end), width });
    return {
      content: frames.flatMap((f) => [
        { type: 'text', text: `Frame at ${formatTimecode(f.time)} (${f.time} s)` },
        { type: 'image', data: f.data.toString('base64'), mimeType: 'image/jpeg' },
      ]),
    };
  }));

  tool('contact_sheet', {
    title: 'Contact sheet',
    description: 'One image with a grid of evenly spaced frames, to scan a whole video (or a part) cheaply. Returns the time of each tile, left to right, top to bottom. Zoom in later with a smaller start/end or view_frames.',
    inputSchema: {
      path: pathSchema,
      ...rangeShape,
      columns: z.number().int().min(2).max(8).default(4),
      rows: z.number().int().min(1).max(8).default(4),
      width: z.number().int().min(320).max(1920).default(1280),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, guarded(async ({ path: p, start, end, columns = 4, rows = 4, width = 1280 }) => {
    const sheet = await media.contactSheet(await file(p), { start: optTime(start), end: optTime(end), columns, rows, width });
    const legend = sheet.times.map((t, i) => `${i + 1}: ${formatTimecode(t)}`).join(', ');
    return {
      content: [
        { type: 'text', text: `${columns}x${rows} grid, tiles left to right, top to bottom. Tile times: ${legend}` },
        { type: 'image', data: sheet.image.toString('base64'), mimeType: 'image/jpeg' },
      ],
    };
  }));

  tool('detect_scenes', {
    title: 'Detect scene changes',
    description: 'Finds cuts and scene changes in the video with FFmpeg. Lower threshold finds more changes.',
    inputSchema: {
      path: pathSchema,
      ...rangeShape,
      threshold: z.number().min(0.05).max(0.9).default(0.3),
      limit: z.number().int().min(1).max(2000).default(300),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, guarded(async ({ path: p, start, end, threshold = 0.3, limit = 300 }) => json(await media.scenes(await file(p), { start: optTime(start), end: optTime(end), threshold, limit }))));

  tool('detect_silence', {
    title: 'Detect silence',
    description: 'Finds silent parts and the parts with sound (speech, music) between them. Useful to remove pauses or split at gaps.',
    inputSchema: {
      path: pathSchema,
      ...rangeShape,
      noiseDb: z.number().min(-90).max(-10).default(-35).describe('Anything quieter than this counts as silence'),
      minDuration: z.number().min(0.05).max(60).default(0.5).describe('Shortest silence to report, in seconds'),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, guarded(async ({ path: p, start, end, noiseDb = -35, minDuration = 0.5 }) => json(await media.silence(await file(p), { start: optTime(start), end: optTime(end), noiseDb, minDuration }))));

  tool('detect_black', {
    title: 'Detect black frames',
    description: 'Finds black parts of the video, such as fades, breaks between programmes or ad breaks.',
    inputSchema: {
      path: pathSchema,
      ...rangeShape,
      minDuration: z.number().min(0.04).max(60).default(0.5),
      pictureThreshold: z.number().min(0.5).max(1).default(0.98),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, guarded(async ({ path: p, start, end, minDuration = 0.5, pictureThreshold = 0.98 }) => json(await media.black(await file(p), { start: optTime(start), end: optTime(end), minDuration, pictureThreshold }))));

  tool('audio_levels', {
    title: 'Audio levels',
    description: 'Loudness over time (EBU R128, LUFS) in windows, the loudest moments (laughter, applause, shouting, drops) and the overall loudness.',
    inputSchema: {
      path: pathSchema,
      ...rangeShape,
      windowSeconds: z.number().min(0.5).max(600).optional(),
      top: z.number().int().min(1).max(50).default(10),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, guarded(async ({ path: p, start, end, windowSeconds, top = 10 }) => json(await media.loudness(await file(p), { start: optTime(start), end: optTime(end), windowSeconds, top }))));

  tool('keyframes', {
    title: 'Keyframes',
    description: 'Lists video keyframes. Lossless cuts start cleanly at keyframes, so use this to choose cut points or to see where a cut will snap. Pass "near" to get the keyframes around given times.',
    inputSchema: {
      path: pathSchema,
      ...rangeShape,
      near: z.array(timeSchema).max(100).optional(),
      limit: z.number().int().min(1).max(5000).default(500),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, guarded(async ({ path: p, start, end, near, limit = 500 }) => json(await media.keyframes(await file(p), { start: optTime(start), end: optTime(end), near: near?.map(parseTime), limit }))));
}
