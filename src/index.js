#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { createClient, DEFAULT_PORT, parsePort } from './client.js';
import { createLosslessCutServer, SERVER_VERSION } from './server.js';

const HELP = `losslesscut-mcp ${SERVER_VERSION}

MCP server (stdio) that controls LosslessCut through its local HTTP API.
Start LosslessCut with: LosslessCut --http-api [port]

Options:
  --port <n>   Port of the LosslessCut HTTP API (default ${DEFAULT_PORT}, or LOSSLESSCUT_PORT)
  --help       Show this help
  --version    Show the version
`;

function readPort(argv, env) {
  const index = argv.indexOf('--port');
  if (index !== -1) return parsePort(argv[index + 1]);
  const inline = argv.find((arg) => arg.startsWith('--port='));
  if (inline) return parsePort(inline.slice('--port='.length));
  if (env.LOSSLESSCUT_PORT) return parsePort(env.LOSSLESSCUT_PORT);
  return DEFAULT_PORT;
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(HELP);
    return;
  }
  if (argv.includes('--version')) {
    process.stdout.write(`${SERVER_VERSION}\n`);
    return;
  }
  const port = readPort(argv, process.env);
  const server = createLosslessCutServer({ client: createClient({ port }) });
  await server.connect(new StdioServerTransport());
  process.stderr.write(`losslesscut-mcp ${SERVER_VERSION} ready, LosslessCut API at http://127.0.0.1:${port}\n`);
}

main().catch((err) => {
  process.stderr.write(`losslesscut-mcp: ${err?.message ?? err}\n`);
  process.exit(1);
});
