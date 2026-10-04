import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import type { Logger } from '../log/logger.js';

/**
 * stdio transport bootstrap (docs/ARCHITECTURE.md §2 L0).
 * stdout carries JSON-RPC only — every log line goes to stderr and/or the log file.
 */
export async function serveStdio(server: McpServer, logger?: Logger): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  logger?.info('stdio transport connected', { pid: process.pid });
}

/** Resolve when the client disconnects or the process is asked to stop. */
export function waitForShutdown(server: McpServer, logger?: Logger): Promise<void> {
  return new Promise<void>((resolve) => {
    let settled = false;
    const finish = (reason: string): void => {
      if (settled) return;
      settled = true;
      logger?.info('shutting down', { reason });
      resolve();
    };

    server.server.onclose = () => finish('client disconnected');
    process.stdin.on('close', () => finish('stdin closed'));
    process.on('SIGINT', () => finish('SIGINT'));
    process.on('SIGTERM', () => finish('SIGTERM'));
  });
}
