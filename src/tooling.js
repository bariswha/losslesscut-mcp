import { stat } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';

import { LosslessCutError } from './client.js';
import { ToolError } from './process.js';
import { SubtitleError } from './subtitle.js';

export const MAX_FILES = 100;
export const MAX_PATH_LENGTH = 4096;

export const timeSchema = z.union([
  z.number().min(0).describe('Seconds from the start of the file'),
  z.string().min(1).max(32).describe('Timecode like "75.5", "01:15.5" or "00:01:15.500"'),
]);

export const pathSchema = z.string().min(1).max(MAX_PATH_LENGTH).describe('Absolute path of a file the user gave you');

export const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

export const text = (message) => ({ content: [{ type: 'text', text: message }] });
export const json = (value) => ({ content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] });
export const failure = (message) => ({ content: [{ type: 'text', text: message }], isError: true });

export function errorMessage(err) {
  if (err instanceof LosslessCutError) {
    switch (err.code) {
      case 'NOT_RUNNING':
        return `${err.message} Make sure LosslessCut is open and was started with --http-api.`;
      case 'TIMEOUT':
        return `${err.message} LosslessCut may be waiting for you to answer a dialog — check the app window.`;
      case 'FORBIDDEN':
        return `${err.message} This can happen if the request was sent with an Origin header; that is a bug, please report it.`;
      default:
        return err.message;
    }
  }
  if (err instanceof ToolError) {
    switch (err.code) {
      case 'NOT_FOUND':
        return `${err.message} Check that ffmpeg and ffprobe are on your PATH, or set LOSSLESSCUT_MCP_FFMPEG / LOSSLESSCUT_MCP_FFPROBE.`;
      case 'SPAWN_FAILED':
        return `${err.message} Check that the binary path is correct and that you have permission to run it.`;
      case 'NO_FRAME':
        return `${err.message} Try a time slightly earlier, or check that the file has a video stream.`;
      case 'NO_VIDEO':
        return `${err.message} Use media_info to check what streams the file contains.`;
      case 'NO_AUDIO':
        return `${err.message} Use media_info to check what streams the file contains.`;
      case 'TIMEOUT':
        return `${err.message} The file may be very long or the system is under load; try a shorter range.`;
      default:
        return err.message;
    }
  }
  if (err instanceof SubtitleError) return err.message;
  if (err instanceof RangeError || err instanceof TypeError) return err.message;
  return `Unexpected error: ${err?.message ?? String(err)}`;
}

export function guarded(handler) {
  return async (args, extra) => {
    try {
      return await handler(args ?? {}, extra);
    } catch (err) {
      return failure(errorMessage(err));
    }
  };
}

export async function validateFilePaths(paths, { statFn = stat } = {}) {
  const resolved = [];
  for (const raw of paths) {
    if (typeof raw !== 'string' || raw.length === 0 || raw.length > MAX_PATH_LENGTH || /[\0\r\n]/.test(raw)) {
      throw new RangeError('Each path must be a non-empty string without control characters.');
    }
    if (!path.isAbsolute(raw)) {
      throw new RangeError(`"${raw}" is not an absolute path. Ask the user for the full path of the file instead of guessing it.`);
    }
    const normalized = path.normalize(raw);
    let info;
    try {
      info = await statFn(normalized);
    } catch {
      throw new RangeError(`File not found: ${normalized}. Ask the user for the correct path.`);
    }
    if (!info.isFile()) throw new RangeError(`Not a file: ${normalized}`);
    resolved.push(normalized);
  }
  return resolved;
}

export async function validateFilePath(p, options) {
  const [resolved] = await validateFilePaths([p], options);
  return resolved;
}
