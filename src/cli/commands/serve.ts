import type { CliIo } from '../cli.js';
import { createMcpServer } from '../../server/mcp-server.js';
import { ServerContext } from '../../server/context.js';
import { serveStdio, waitForShutdown } from '../../server/stdio.js';
import { VERSION } from '../../version.js';

/** `devpilot serve` — the process an MCP client launches. stdout stays JSON-RPC-only. */
export async function serveCommand(io: CliIo): Promise<number> {
  const context = await ServerContext.create({ env: io.env });
  const server = createMcpServer(context);
  await serveStdio(server, context.logger);
  io.stderr(`devpilot ${VERSION} MCP server ready on stdio (home: ${context.home})\n`);
  await waitForShutdown(server, context.logger);
  await context.dispose();
  return 0;
}
