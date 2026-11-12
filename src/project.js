import { rename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

export function projectPathFor(mediaPath) {
  const { dir, name } = path.parse(mediaPath);
  return path.join(dir, `${name}-proj.llc`);
}

export function buildProject(mediaPath, segments) {
  return {
    version: 2,
    mediaFileName: path.basename(mediaPath),
    cutSegments: segments.map((s) => ({
      start: s.start,
      end: s.end,
      name: s.name ?? '',
      selected: s.selected ?? true,
    })),
  };
}

export async function writeProject(mediaPath, segments, { now = Date.now } = {}) {
  const target = projectPathFor(mediaPath);
  let backup;
  try {
    await stat(target);
    backup = `${target}.${now()}.bak`;
    await rename(target, backup);
  } catch (err) {
    if (err?.code !== 'ENOENT') throw err;
  }
  await writeFile(target, `${JSON.stringify(buildProject(mediaPath, segments), null, 2)}\n`, { flag: 'wx' });
  return { path: target, backup };
}
