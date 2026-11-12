import { spawn } from 'node:child_process';
import path from 'node:path';

export class ToolError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'ToolError';
    this.code = code;
  }
}

const tail = (text, max = 600) => (text.length > max ? `...${text.slice(-max)}` : text).trim();

export function runProcess(command, args, { timeoutMs = 600_000, input, maxBytes = 64 * 1024 * 1024, cwd } = {}) {
  const name = path.basename(String(command));
  return new Promise((resolve, reject) => {
    let settled = false;
    let stopReason;
    const out = [];
    const err = [];
    let outBytes = 0;
    let errBytes = 0;

    const done = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(value);
    };

    let child;
    try {
      child = spawn(command, args, { cwd, windowsHide: true, stdio: [input ? 'pipe' : 'ignore', 'pipe', 'pipe'] });
    } catch (error) {
      reject(new ToolError(`Could not start ${name}: ${error.message}`, 'SPAWN_FAILED'));
      return;
    }

    const timer = setTimeout(() => {
      stopReason = 'timeout';
      child.kill();
    }, timeoutMs);

    child.stdout.on('data', (chunk) => {
      outBytes += chunk.length;
      if (outBytes > maxBytes) {
        stopReason = 'size';
        child.kill();
      } else {
        out.push(chunk);
      }
    });
    child.stderr.on('data', (chunk) => {
      errBytes += chunk.length;
      if (errBytes <= maxBytes) err.push(chunk);
    });
    child.on('error', (error) => {
      if (error.code === 'ENOENT') {
        done(reject, new ToolError(`${name} was not found. Install it or set its path (see the README).`, 'NOT_FOUND'));
      } else {
        done(reject, new ToolError(`${name} failed to start: ${error.message}`, 'SPAWN_FAILED'));
      }
    });
    child.on('close', (code) => {
      const stdout = Buffer.concat(out);
      const stderr = Buffer.concat(err).toString('utf8');
      if (stopReason === 'timeout') done(reject, new ToolError(`${name} did not finish within ${Math.round(timeoutMs / 1000)} s.`, 'TIMEOUT'));
      else if (stopReason === 'size') done(reject, new ToolError(`${name} produced more output than allowed.`, 'TOO_LARGE'));
      else if (code !== 0) done(reject, new ToolError(`${name} failed (exit code ${code}): ${tail(stderr)}`, 'FAILED'));
      else done(resolve, { stdout, stderr });
    });

    if (input) {
      child.stdin.on('error', () => {});
      child.stdin.end(input);
    }
  });
}

export async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await fn(items[index], index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}
