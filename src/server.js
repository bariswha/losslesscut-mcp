import { stat } from 'node:fs/promises';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import { ACTION_GROUPS, ACTION_GROUP_BY_NAME, GROUP_DESCRIPTIONS, isAllowedAction } from './actions.js';
import { registerAnalysisTools } from './analysisTools.js';
import { createClient } from './client.js';
import { createMedia } from './media.js';
import { writeProject } from './project.js';
import { parseTime, formatTimecode } from './timecode.js';
import { failure, guarded, json, MAX_FILES, MAX_PATH_LENGTH, pathSchema, sleep, text, timeSchema, validateFilePath, validateFilePaths } from './tooling.js';

export const SERVER_NAME = 'losslesscut-mcp';
export const SERVER_VERSION = '2.0.0';

const EVENT_LISTEN_DELAY_MS = 250;
const SETTLE_DELAY_MS = 150;

const NO_FEEDBACK_NOTE = 'LosslessCut does not report the result of actions over its HTTP API, so check the LosslessCut window if something looks wrong.';

function withTimeout(promise, ms) {
  let timer;
  return Promise.race([
    promise.then((value) => ({ done: true, value })),
    new Promise((resolve) => { timer = setTimeout(() => resolve({ done: false }), ms); }),
  ]).finally(() => clearTimeout(timer));
}

function describeExportResult(result) {
  if (Array.isArray(result?.paths) && result.paths.length > 0) {
    return json({ status: 'completed', paths: result.paths });
  }
  return failure('Export finished without output files. It failed or was cancelled; check the LosslessCut window for details.');
}

export function createLosslessCutServer({
  client = createClient(),
  statFn = stat,
  media: mediaTools = createMedia(),
  disabledTools = [],
  eventListenDelayMs = EVENT_LISTEN_DELAY_MS,
  settleDelayMs = SETTLE_DELAY_MS,
  exportStartTimeoutMs = 3000,
  projectLoadDelayMs = 1500,
} = {}) {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      instructions: 'Controls a running LosslessCut desktop app through its local HTTP API, and analyses media files locally with FFmpeg. '
        + 'LosslessCut must be started with --http-api. Only use file paths the user gave you. '
        + 'To find what to cut, look at the media first: media_info, contact_sheet or view_frames to see it, detect_scenes, detect_silence, detect_black, audio_levels and keyframes. '
        + 'Then cut: set_segments loads exact segments in one step (preferred), or use add_segment/set_cut_points. Then export_file. '
        + 'The LosslessCut API cannot read app state (open file, segments, playhead), so keep track of what you did.',
    },
  );

  const disabled = new Set(disabledTools);
  const tool = (name, config, handler) => {
    if (!disabled.has(name)) server.registerTool(name, config, handler);
  };

  const exportState = { pending: null, last: null };

  async function listen(eventName, { signal } = {}) {
    let sent;
    const sentPromise = new Promise((resolve) => { sent = resolve; });
    const promise = client.awaitEvent(eventName, { signal, onSent: sent });
    promise.catch(() => {});
    await withTimeout(Promise.race([sentPromise, promise.then(() => {}, () => {})]), 2000);
    await sleep(eventListenDelayMs);
    return { promise };
  }

  async function ensureExportListener() {
    if (exportState.pending) return exportState.pending;
    const controller = new AbortController();
    const { promise } = await listen('export-complete', { signal: controller.signal });
    const entry = { promise, controller };
    exportState.pending = entry;
    promise.then(
      (result) => { if (exportState.pending === entry) { exportState.pending = null; exportState.last = result; } },
      () => { if (exportState.pending === entry) exportState.pending = null; },
    );
    return entry;
  }

  function cancelExportListener() {
    if (!exportState.pending) return;
    exportState.pending.controller.abort();
    exportState.pending = null;
  }

  async function waitForExport(timeoutSeconds) {
    if (!exportState.pending && exportState.last) {
      const result = exportState.last;
      exportState.last = null;
      return describeExportResult(result);
    }
    const { promise } = await ensureExportListener();
    const outcome = await withTimeout(promise, timeoutSeconds * 1000);
    if (!outcome.done) {
      return text(`Export is still running after ${timeoutSeconds} s. Call wait_for_export again to keep waiting.`);
    }
    exportState.last = null;
    return describeExportResult(outcome.value);
  }

  async function seek(time) {
    const seconds = parseTime(time);
    await client.action('goToTimecodeDirect', { time: formatTimecode(seconds) });
    await sleep(settleDelayMs);
    return seconds;
  }

  async function runAction(name) {
    await client.action(name);
    await sleep(settleDelayMs);
  }

  tool('check_connection', {
    title: 'Check LosslessCut connection',
    description: 'Checks that LosslessCut is running with its HTTP API enabled and reachable on 127.0.0.1.',
    inputSchema: {},
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, guarded(async () => {
    const { url } = await client.ping();
    return text(`LosslessCut HTTP API is reachable at ${url}.`);
  }));

  tool('open_files', {
    title: 'Open files',
    description: 'Opens one or more media files (or a .llc project file) in LosslessCut. Paths must be absolute paths the user gave you; never invent or guess paths. '
      + 'Several files are loaded into the batch list. If a file is already open, LosslessCut asks the user what to do, so call close_file first.',
    inputSchema: {
      paths: z.array(z.string().min(1).max(MAX_PATH_LENGTH)).min(1).max(MAX_FILES).describe('Absolute file paths provided by the user'),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  }, guarded(async ({ paths }) => {
    const files = await validateFilePaths(paths, { statFn });
    await client.action('openFiles', files);
    await sleep(settleDelayMs);
    return text(`Asked LosslessCut to open ${files.length} file(s):\n${files.join('\n')}`);
  }));

  tool('seek', {
    title: 'Seek to time',
    description: 'Moves the playhead of the open file to a time. Works with the default "timecode with decimal fraction" timecode format in LosslessCut.',
    inputSchema: { time: timeSchema },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, guarded(async ({ time }) => {
    const seconds = await seek(time);
    return text(`Playhead moved to ${formatTimecode(seconds)}.`);
  }));

  tool('set_cut_points', {
    title: 'Set cut start/end',
    description: 'Sets the start and/or end of the current segment by seeking to each time and pressing "set cut start"/"set cut end". '
      + 'If the playhead is after the current segment, LosslessCut creates a new segment instead.',
    inputSchema: {
      start: timeSchema.optional(),
      end: timeSchema.optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  }, guarded(async ({ start, end }) => {
    if (start == null && end == null) throw new RangeError('Give start, end or both.');
    if (start != null && end != null && parseTime(end) <= parseTime(start)) throw new RangeError('end must be after start.');
    const done = [];
    if (start != null) {
      const s = await seek(start);
      await runAction('setCutStart');
      done.push(`start ${formatTimecode(s)}`);
    }
    if (end != null) {
      const e = await seek(end);
      await runAction('setCutEnd');
      done.push(`end ${formatTimecode(e)}`);
    }
    return text(`Set cut ${done.join(' and ')}. ${NO_FEEDBACK_NOTE}`);
  }));

  tool('add_segment', {
    title: 'Add segment',
    description: 'Adds a new segment from start to end. If the file only has its initial full-length segment, LosslessCut replaces it with this one. '
      + 'Call it several times to cut out several parts.',
    inputSchema: {
      start: timeSchema,
      end: timeSchema,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  }, guarded(async ({ start, end }) => {
    const s = parseTime(start);
    const e = parseTime(end);
    if (e <= s) throw new RangeError('end must be after start.');
    await seek(s);
    await runAction('addSegment');
    await seek(e);
    await runAction('setCutEnd');
    return text(`Added segment ${formatTimecode(s)} - ${formatTimecode(e)}. ${NO_FEEDBACK_NOTE}`);
  }));

  const selectModes = {
    all: 'selectAllSegments',
    none: 'deselectAllSegments',
    invert: 'invertSelectedSegments',
    only_current: 'selectOnlyCurrentSegment',
    toggle_current: 'toggleCurrentSegmentSelected',
    at_playhead: 'selectSegmentsAtCursor',
  };

  tool('select_segments', {
    title: 'Select segments',
    description: 'Changes which segments are selected. Only selected segments are exported.',
    inputSchema: { mode: z.enum(Object.keys(selectModes)) },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  }, guarded(async ({ mode }) => {
    await runAction(selectModes[mode]);
    return text(`Ran ${selectModes[mode]}.`);
  }));

  const jumpTargets = {
    first: 'jumpSeekFirstSegment',
    last: 'jumpSeekLastSegment',
    next: 'jumpSeekNextSegment',
    previous: 'jumpSeekPrevSegment',
  };

  tool('jump_to_segment', {
    title: 'Jump to segment',
    description: 'Makes another segment the current one and moves the playhead to its start.',
    inputSchema: { target: z.enum(Object.keys(jumpTargets)) },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  }, guarded(async ({ target }) => {
    await runAction(jumpTargets[target]);
    return text(`Ran ${jumpTargets[target]}.`);
  }));

  tool('export_file', {
    title: 'Export',
    description: 'Exports the selected segments of the open file with the current LosslessCut export settings. '
      + 'If the export options dialog is enabled, it is confirmed automatically. Returns the output paths when wait is true.',
    inputSchema: {
      wait: z.boolean().default(true).describe('Wait for the export to finish and return the output paths'),
      timeoutSeconds: z.number().int().min(1).max(3600).default(300).describe('How long to wait for the export to finish'),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  }, guarded(async ({ wait = true, timeoutSeconds = 300 }) => {
    exportState.last = null;
    await ensureExportListener();
    const startController = new AbortController();
    const { promise: started } = await listen('export-start', { signal: startController.signal });
    try {
      await client.action('export');
      let start = await withTimeout(started, exportStartTimeoutMs);
      if (!start.done) {
        await client.action('export');
        start = await withTimeout(started, exportStartTimeoutMs);
      }
      if (!start.done) {
        cancelExportListener();
        return failure('Export did not start. Make sure a file is open in LosslessCut, that no other dialog is open, and that at least one segment is selected.');
      }
    } finally {
      startController.abort();
    }
    if (!wait) return text('Export started. Call wait_for_export to get the output paths.');
    return waitForExport(timeoutSeconds);
  }));

  tool('wait_for_export', {
    title: 'Wait for export',
    description: 'Waits until the current or next export finishes and returns the exported file paths.',
    inputSchema: {
      timeoutSeconds: z.number().int().min(1).max(3600).default(300),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, guarded(async ({ timeoutSeconds = 300 }) => waitForExport(timeoutSeconds)));

  tool('close_file', {
    title: 'Close file',
    description: 'Closes the current file in LosslessCut. If "ask before closing" is enabled in its settings, the user has to confirm in the app.',
    inputSchema: {},
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  }, guarded(async () => {
    await runAction('closeCurrentFile');
    return text('Asked LosslessCut to close the current file.');
  }));

  tool('list_actions', {
    title: 'List actions',
    description: 'Lists the LosslessCut keyboard actions that run_action accepts, grouped by category.',
    inputSchema: {
      group: z.enum(Object.keys(ACTION_GROUPS)).optional(),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, guarded(async ({ group }) => {
    const groups = group ? [group] : Object.keys(ACTION_GROUPS);
    return json(Object.fromEntries(groups.map((g) => [g, { description: GROUP_DESCRIPTIONS[g], actions: ACTION_GROUPS[g] }])));
  }));

  tool('run_action', {
    title: 'Run action',
    description: 'Runs one LosslessCut keyboard action by name, for example "togglePlayResetSpeed", "splitCurrentSegment" or "toggleStripAudio". '
      + 'Only actions from list_actions are allowed. Actions in the "dialog" group open a dialog the user must complete in the app.',
    inputSchema: {
      action: z.string().min(1).max(64),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
  }, guarded(async ({ action }) => {
    if (!isAllowedAction(action)) {
      throw new RangeError(`"${action}" is not an allowed action. Call list_actions to see the allowed names.`);
    }
    await runAction(action);
    const note = ACTION_GROUP_BY_NAME.get(action) === 'dialog' ? ' It opens a dialog in LosslessCut that the user has to complete.' : '';
    return text(`Ran ${action}.${note} ${NO_FEEDBACK_NOTE}`);
  }));

  tool('set_segments', {
    title: 'Set segments',
    description: 'Loads an exact list of segments for a media file in one step and opens it in LosslessCut. It writes the LosslessCut project file next to the media ("<name>-proj.llc"); '
      + 'an existing project file is first renamed to a .bak backup. The currently open file is closed first. Prefer this over add_segment for precise cuts.',
    inputSchema: {
      path: pathSchema,
      segments: z.array(z.object({
        start: timeSchema,
        end: timeSchema,
        name: z.string().max(200).optional(),
        selected: z.boolean().optional(),
      })).min(1).max(1000),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  }, guarded(async ({ path: file, segments }) => {
    const media = await validateFilePath(file, { statFn });
    const parsed = segments.map((s, i) => {
      const start = parseTime(s.start);
      const end = parseTime(s.end);
      if (end <= start) throw new RangeError(`Segment ${i + 1}: end must be after start.`);
      return { start, end, name: s.name?.replace(/[\u0000-\u001f]/g, ' '), selected: s.selected };
    });
    let total;
    try {
      total = await mediaTools.duration(media);
    } catch {}
    if (total != null) {
      const bad = parsed.findIndex((s) => s.start >= total);
      if (bad !== -1) throw new RangeError(`Segment ${bad + 1} starts after the end of the file (${total.toFixed(3)} s).`);
      for (const s of parsed) s.end = Math.min(s.end, total);
    }
    await runAction('closeCurrentFile');
    await sleep(Math.max(settleDelayMs, 300));
    const project = await writeProject(media, parsed);
    await client.action('openFiles', [media]);
    await sleep(projectLoadDelayMs);
    return json({
      status: 'loaded',
      segments: parsed.length,
      projectFile: project.path,
      ...(project.backup ? { previousProjectBackup: project.backup } : {}),
      note: NO_FEEDBACK_NOTE,
    });
  }));

  registerAnalysisTools({ tool, media: mediaTools, statFn });

  return server;
}
