import test from 'node:test';
import assert from 'node:assert/strict';

import { parseTime, toTimecode } from '../src/timecode.js';
import { parsePort } from '../src/client.js';
import { isAllowedAction } from '../src/actions.js';

test('parses seconds and clock timecodes', () => {
  assert.equal(parseTime(75.5), 75.5);
  assert.equal(parseTime('75.5'), 75.5);
  assert.equal(parseTime('01:15.5'), 75.5);
  assert.equal(parseTime('1:00:00'), 3600);
  assert.equal(toTimecode(75.5), '00:01:15.500');
  assert.equal(toTimecode('2:03:04.0056'), '02:03:04.006');
  assert.equal(toTimecode(59.9999), '00:01:00.000');
});

test('rejects invalid times', () => {
  for (const bad of [-1, Number.NaN, Infinity, '', 'abc', '1:60', '61:00', '00:00:00:00', '1e3', '-5', '5;rm', 1e9]) {
    assert.throws(() => parseTime(bad), `${bad} should be rejected`);
  }
});

test('validates ports', () => {
  assert.equal(parsePort('8080'), 8080);
  for (const bad of ['0', '65536', 'abc', '', '80.5', undefined]) assert.throws(() => parsePort(bad));
});

test('allowlist blocks dangerous and argument actions', () => {
  assert.equal(isAllowedAction('splitCurrentSegment'), true);
  for (const name of ['quit', 'cleanupFilesDialog', 'openSendReportDialog', 'openFiles', 'goToTimecodeDirect', 'importEdlFile', 'exportEdlFile', 'promptDownloadMediaUrl', '../x', 'constructor', '__proto__']) {
    assert.equal(isAllowedAction(name), false, name);
  }
});
