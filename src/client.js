import http from 'node:http';

export const HOST = '127.0.0.1';
export const DEFAULT_PORT = 8080;

const MAX_RESPONSE_BYTES = 1_000_000;
const CONNECTION_ERRORS = new Set(['ECONNREFUSED', 'ECONNRESET', 'EHOSTUNREACH', 'ENETUNREACH', 'EPIPE']);

export class LosslessCutError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'LosslessCutError';
    this.code = code;
  }
}

export function parsePort(value) {
  const text = String(value ?? '').trim();
  if (!/^\d{1,5}$/.test(text)) throw new RangeError(`Invalid port "${value}". Use a number from 1 to 65535.`);
  const port = Number(text);
  if (port < 1 || port > 65535) throw new RangeError(`Invalid port "${value}". Use a number from 1 to 65535.`);
  return port;
}

export function createClient({ port = DEFAULT_PORT, actionTimeoutMs = 120_000, request = http.request } = {}) {
  const baseUrl = `http://${HOST}:${port}`;

  const notReachable = () => new LosslessCutError(
    `LosslessCut is not reachable at ${baseUrl}. Start LosslessCut with the HTTP API enabled, for example "LosslessCut --http-api ${port}". `
      + 'If it uses another port, set LOSSLESSCUT_PORT or pass --port to losslesscut-mcp.',
    'NOT_RUNNING',
  );

  function send(method, path, { body, timeoutMs, signal, onSent } = {}) {
    return new Promise((resolve, reject) => {
      const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body), 'utf8');
      const headers = payload
        ? { 'Content-Type': 'application/json', 'Content-Length': payload.length }
        : { 'Content-Length': 0 };
      let settled = false;
      let timer;
      let req;

      const onAbort = () => {
        req?.destroy();
        finish(reject, new LosslessCutError('Request was cancelled.', 'ABORTED'));
      };

      function finish(fn, value) {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        fn(value);
      }

      if (signal?.aborted) {
        finish(reject, new LosslessCutError('Request was cancelled.', 'ABORTED'));
        return;
      }

      req = request({ host: HOST, port, method, path, headers, agent: false }, (res) => {
        const chunks = [];
        let size = 0;
        res.on('data', (chunk) => {
          size += chunk.length;
          if (size <= MAX_RESPONSE_BYTES) chunks.push(chunk);
        });
        res.on('error', () => finish(reject, notReachable()));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          const status = res.statusCode ?? 0;
          if (status === 403) {
            finish(reject, new LosslessCutError(`LosslessCut refused the request (403): ${text.slice(0, 300)}`, 'FORBIDDEN'));
          } else if (status === 404) {
            finish(reject, new LosslessCutError(`LosslessCut does not know ${method} ${path} (404). Update LosslessCut to a version with this HTTP API endpoint.`, 'NOT_FOUND'));
          } else if (status < 200 || status >= 300) {
            finish(reject, new LosslessCutError(`LosslessCut returned HTTP ${status}: ${text.slice(0, 300)}`, 'HTTP_ERROR'));
          } else {
            finish(resolve, text);
          }
        });
      });

      req.on('error', (err) => {
        finish(reject, CONNECTION_ERRORS.has(err?.code) ? notReachable() : new LosslessCutError(`Request to LosslessCut failed: ${err?.message ?? err}`, 'REQUEST_FAILED'));
      });

      if (timeoutMs) {
        timer = setTimeout(() => {
          req.destroy();
          finish(reject, new LosslessCutError(`LosslessCut did not respond within ${Math.round(timeoutMs / 1000)} s.`, 'TIMEOUT'));
        }, timeoutMs);
      }

      signal?.addEventListener('abort', onAbort, { once: true });
      if (onSent) req.on('finish', onSent);
      req.end(payload);
    });
  }

  async function ping() {
    await send('GET', '/', { timeoutMs: 5000 });
    return { url: baseUrl };
  }

  async function action(name, body) {
    if (!/^[A-Za-z][A-Za-z0-9]{0,63}$/.test(name)) throw new LosslessCutError(`Invalid action name "${name}".`, 'INVALID_ACTION');
    await send('POST', `/api/action/${name}`, { body, timeoutMs: actionTimeoutMs });
  }

  async function awaitEvent(eventName, { timeoutMs, signal, onSent } = {}) {
    if (!/^[a-z][a-z-]{0,63}$/.test(eventName)) throw new LosslessCutError(`Invalid event name "${eventName}".`, 'INVALID_EVENT');
    const text = await send('POST', `/api/await-event/${eventName}`, { timeoutMs, signal, onSent });
    try {
      return text ? JSON.parse(text) : {};
    } catch {
      throw new LosslessCutError(`LosslessCut sent an invalid response for event ${eventName}.`, 'BAD_RESPONSE');
    }
  }

  return { port, baseUrl, send, ping, action, awaitEvent };
}
