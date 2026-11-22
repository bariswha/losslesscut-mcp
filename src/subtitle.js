import { readFile } from 'node:fs/promises';
import path from 'node:path';

export class SubtitleError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'SubtitleError';
    this.code = code;
  }
}

// hh:mm:ss,mmm  or  hh:mm:ss.mmm
function parseSrtTime(raw) {
  const m = /^(\d{1,3}):(\d{2}):(\d{2})[,.](\d{3})$/.exec(raw.trim());
  if (!m) throw new SubtitleError(`Cannot parse SRT timestamp: "${raw}"`, 'BAD_TIMESTAMP');
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(m[4]) / 1000;
}

// hh:mm:ss.mmm
function parseVttTime(raw) {
  const m = /^(?:(\d{1,3}):)?(\d{2}):(\d{2})\.(\d{3})$/.exec(raw.trim());
  if (!m) throw new SubtitleError(`Cannot parse WebVTT timestamp: "${raw}"`, 'BAD_TIMESTAMP');
  const hours = m[1] == null ? 0 : Number(m[1]);
  return hours * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(m[4]) / 1000;
}

function parseSrt(text) {
  const entries = [];
  const blocks = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split(/\n{2,}/);
  for (const block of blocks) {
    const lines = block.trim().split('\n');
    if (lines.length < 2) continue;
    // first non-empty line may be a sequence number; skip it
    let i = 0;
    if (/^\d+$/.test(lines[i].trim())) i += 1;
    if (i >= lines.length) continue;
    const arrow = lines[i].split('-->');
    if (arrow.length !== 2) continue;
    let start, end;
    try {
      start = parseSrtTime(arrow[0]);
      end = parseSrtTime(arrow[1].split(/\s+/).filter(Boolean)[0] ?? ''); // strip position tags
    } catch {
      continue;
    }
    const textLines = lines.slice(i + 1).map((l) => l.replace(/<[^>]+>/g, '').trim()).filter(Boolean);
    if (textLines.length === 0) continue;
    entries.push({ start, end, text: textLines.join(' ') });
  }
  return entries;
}

function parseVtt(text) {
  const entries = [];
  const lines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  let i = 0;
  // skip WEBVTT header and NOTE/STYLE blocks
  while (i < lines.length && !lines[i].includes('-->')) i += 1;
  while (i < lines.length) {
    const arrow = lines[i].split('-->');
    if (arrow.length === 2) {
      let start, end;
      try {
        start = parseVttTime(arrow[0]);
        end = parseVttTime(arrow[1].split(/\s+/).filter(Boolean)[0] ?? '');
      } catch {
        i += 1;
        continue;
      }
      i += 1;
      const textLines = [];
      while (i < lines.length && lines[i].trim() !== '') {
        const clean = lines[i].replace(/<[^>]+>/g, '').trim();
        if (clean) textLines.push(clean);
        i += 1;
      }
      if (textLines.length > 0) entries.push({ start, end, text: textLines.join(' ') });
    } else {
      i += 1;
    }
  }
  return entries;
}

export function detectFormat(filePath, text) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.vtt') return 'vtt';
  if (ext === '.srt') return 'srt';
  // sniff: WebVTT files start with "WEBVTT"
  if (/^WEBVTT\b/.test(text.trim())) return 'vtt';
  return 'srt';
}

export async function loadSubtitles(filePath, { readFileFn = readFile } = {}) {
  let raw;
  try {
    raw = await readFileFn(filePath, 'utf8');
  } catch (err) {
    throw new SubtitleError(`Could not read subtitle file: ${err.message}`, 'READ_ERROR');
  }
  const fmt = detectFormat(filePath, raw);
  const entries = fmt === 'vtt' ? parseVtt(raw) : parseSrt(raw);
  if (entries.length === 0) throw new SubtitleError('No subtitle entries found in the file.', 'EMPTY');
  return entries;
}

export function matchSubtitles(entries, { query, caseSensitive = false, pad = 0 }) {
  const needle = caseSensitive ? query : query.toLowerCase();
  const matches = entries.filter((e) => {
    const hay = caseSensitive ? e.text : e.text.toLowerCase();
    return hay.includes(needle);
  });
  if (pad === 0) return matches;
  return matches.map((m) => ({
    ...m,
    start: Math.max(0, m.start - pad),
    end: m.end + pad,
  }));
}
