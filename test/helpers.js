import http from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { createClient } from '../src/client.js';
import { createLosslessCutServer } from '../src/server.js';

export async function startFakeLosslessCut({ exportConfirm = true, exportPaths = ['/out/clip-00.00.01.000-00.00.03.000.mp4'], exportStarts = true } = {}) {
  const requests = [];
  const waiters = new Map();
  let confirmOpen = false;

  const emit = (eventName, payload) => {
    const list = waiters.get(eventName) ?? [];
    waiters.delete(eventName);
    for (const res of list) res.end(JSON.stringify({ eventName, ...payload }));
  };

  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      requests.push({ method: req.method, url: req.url, headers: req.headers, body: body ? JSON.parse(body) : undefined });
      if (req.headers.origin != null) {
        res.statusCode = 403;
        res.end('Forbidden');
        return;
      }
      if (req.method === 'GET' && req.url === '/') {
        res.end('See homepage');
        return;
      }
      const event = /^\/api\/await-event\/([a-z-]+)$/.exec(req.url);
      if (req.method === 'POST' && event) {
        const list = waiters.get(event[1]) ?? [];
        list.push(res);
        waiters.set(event[1], list);
        return;
      }
      const action = /^\/api\/action\/([A-Za-z0-9]+)$/.exec(req.url);
      if (req.method === 'POST' && action) {
        res.end();
        if (action[1] === 'export' && exportStarts) {
          if (exportConfirm && !confirmOpen) {
            confirmOpen = true;
          } else {
            confirmOpen = false;
            setTimeout(() => {
              emit('export-start', { path: '/in/clip.mp4' });
              setTimeout(() => emit('export-complete', exportPaths ? { paths: exportPaths } : {}), 50);
            }, 10);
          }
        }
        return;
      }
      res.statusCode = 404;
      res.end();
    });
  });

  await new Promise((resolve) => { server.listen(0, '127.0.0.1', resolve); });
  const { port } = server.address();
  return {
    port,
    requests,
    actions: () => requests.filter((r) => r.url.startsWith('/api/action/')).map((r) => r.url.slice('/api/action/'.length)),
    close: () => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }),
  };
}

export async function connect({ port, statFn }) {
  const server = createLosslessCutServer({
    client: createClient({ port, actionTimeoutMs: 5000 }),
    statFn,
    eventListenDelayMs: 20,
    settleDelayMs: 0,
    exportStartTimeoutMs: 500,
  });
  const client = new Client({ name: 'test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return {
    call: (name, args = {}) => client.callTool({ name, arguments: args }),
    listTools: () => client.listTools(),
    close: async () => { await client.close(); await server.close(); },
  };
}

export const textOf = (result) => result.content.map((c) => c.text).join('\n');
