import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import { connect, startFakeLosslessCut, textOf } from './helpers.js';

const fileStat = async () => ({ isFile: () => true });
const missingStat = async () => { throw new Error('ENOENT'); };
const absolute = path.resolve('/videos/clip.mp4');

test('lists all tools', async () => {
  const fake = await startFakeLosslessCut();
  const mcp = await connect({ port: fake.port, statFn: fileStat });
  const { tools } = await mcp.listTools();
  assert.deepEqual(tools.map((t) => t.name).sort(), [
    'add_segment', 'check_connection', 'close_file', 'export_file', 'jump_to_segment', 'list_actions',
    'open_files', 'run_action', 'seek', 'select_segments', 'set_cut_points', 'wait_for_export',
  ]);
  await mcp.close();
  await fake.close();
});

test('requests go to 127.0.0.1 without an Origin header', async () => {
  const fake = await startFakeLosslessCut();
  const mcp = await connect({ port: fake.port, statFn: fileStat });
  const ok = await mcp.call('check_connection');
  assert.equal(ok.isError, undefined);
  await mcp.call('seek', { time: '01:15.5' });
  for (const req of fake.requests) {
    assert.equal(req.headers.origin, undefined);
    assert.equal(req.headers.host, `127.0.0.1:${fake.port}`);
  }
  const seek = fake.requests.find((r) => r.url === '/api/action/goToTimecodeDirect');
  assert.deepEqual(seek.body, { time: '00:01:15.500' });
  await mcp.close();
  await fake.close();
});

test('clear error when LosslessCut is not running', async () => {
  const fake = await startFakeLosslessCut();
  const { port } = fake;
  await fake.close();
  const mcp = await connect({ port, statFn: fileStat });
  const result = await mcp.call('check_connection');
  assert.equal(result.isError, true);
  assert.match(textOf(result), /--http-api/);
  await mcp.close();
});

test('open_files validates paths', async () => {
  const fake = await startFakeLosslessCut();
  let mcp = await connect({ port: fake.port, statFn: fileStat });
  const relative = await mcp.call('open_files', { paths: ['clip.mp4'] });
  assert.equal(relative.isError, true);
  assert.match(textOf(relative), /absolute/);
  const control = await mcp.call('open_files', { paths: [`${absolute}\n`] });
  assert.equal(control.isError, true);
  const ok = await mcp.call('open_files', { paths: [absolute] });
  assert.equal(ok.isError, undefined);
  assert.deepEqual(fake.requests.at(-1).body, [path.normalize(absolute)]);
  await mcp.close();
  mcp = await connect({ port: fake.port, statFn: missingStat });
  const missing = await mcp.call('open_files', { paths: [absolute] });
  assert.equal(missing.isError, true);
  assert.match(textOf(missing), /not found/);
  assert.equal(fake.actions().filter((a) => a === 'openFiles').length, 1);
  await mcp.close();
  await fake.close();
});

test('segment tools send the expected action sequence', async () => {
  const fake = await startFakeLosslessCut();
  const mcp = await connect({ port: fake.port, statFn: fileStat });
  await mcp.call('add_segment', { start: 1, end: '00:03' });
  await mcp.call('set_cut_points', { start: 4, end: 6 });
  await mcp.call('select_segments', { mode: 'all' });
  await mcp.call('jump_to_segment', { target: 'next' });
  assert.deepEqual(fake.actions(), [
    'goToTimecodeDirect', 'addSegment', 'goToTimecodeDirect', 'setCutEnd',
    'goToTimecodeDirect', 'setCutStart', 'goToTimecodeDirect', 'setCutEnd',
    'selectAllSegments', 'jumpSeekNextSegment',
  ]);
  const bad = await mcp.call('add_segment', { start: 5, end: 2 });
  assert.equal(bad.isError, true);
  await mcp.close();
  await fake.close();
});

test('run_action enforces the allowlist', async () => {
  const fake = await startFakeLosslessCut();
  const mcp = await connect({ port: fake.port, statFn: fileStat });
  const ok = await mcp.call('run_action', { action: 'splitCurrentSegment' });
  assert.equal(ok.isError, undefined);
  for (const action of ['quit', 'cleanupFilesDialog', 'openFiles', '../../x', 'notAnAction']) {
    const res = await mcp.call('run_action', { action });
    assert.equal(res.isError, true, action);
  }
  assert.deepEqual(fake.actions(), ['splitCurrentSegment']);
  const list = JSON.parse(textOf(await mcp.call('list_actions', { group: 'selection' })));
  assert.ok(list.selection.actions.includes('selectAllSegments'));
  await mcp.close();
  await fake.close();
});

test('export confirms the dialog and returns output paths', async () => {
  const fake = await startFakeLosslessCut({ exportConfirm: true });
  const mcp = await connect({ port: fake.port, statFn: fileStat });
  const result = await mcp.call('export_file', {});
  assert.equal(result.isError, undefined, textOf(result));
  assert.deepEqual(JSON.parse(textOf(result)).paths, ['/out/clip-00.00.01.000-00.00.03.000.mp4']);
  assert.deepEqual(fake.actions(), ['export', 'export']);
  await mcp.close();
  await fake.close();
});

test('export without confirm dialog and wait_for_export later', async () => {
  const fake = await startFakeLosslessCut({ exportConfirm: false });
  const mcp = await connect({ port: fake.port, statFn: fileStat });
  const started = await mcp.call('export_file', { wait: false });
  assert.match(textOf(started), /started/);
  const done = await mcp.call('wait_for_export', { timeoutSeconds: 5 });
  assert.deepEqual(JSON.parse(textOf(done)).paths, ['/out/clip-00.00.01.000-00.00.03.000.mp4']);
  assert.deepEqual(fake.actions(), ['export']);
  await mcp.close();
  await fake.close();
});

test('export reports failure and non-start', async () => {
  let fake = await startFakeLosslessCut({ exportConfirm: false, exportPaths: null });
  let mcp = await connect({ port: fake.port, statFn: fileStat });
  const failed = await mcp.call('export_file', {});
  assert.equal(failed.isError, true);
  assert.match(textOf(failed), /without output files/);
  await mcp.close();
  await fake.close();

  fake = await startFakeLosslessCut({ exportStarts: false });
  mcp = await connect({ port: fake.port, statFn: fileStat });
  const notStarted = await mcp.call('export_file', {});
  assert.equal(notStarted.isError, true);
  assert.match(textOf(notStarted), /did not start/);
  await mcp.close();
  await fake.close();
});
