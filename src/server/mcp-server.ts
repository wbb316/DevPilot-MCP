import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { ALL_TOOLS } from '../tools/index.js';
import { SERVER_NAME, VERSION } from '../version.js';
import type { ServerContext } from './context.js';
import { registerTools } from './tool-registry.js';

/** Sent to the client during initialize: tells the agent how to use this server. */
export const SERVER_INSTRUCTIONS = [
  'DevPilot is a local software engineering runtime for AI coding agents.',
  'Call open_workspace with an absolute project path before touching anything else: every',
  'other tool resolves paths, commands and caches through that workspace, which is also the',
  'security boundary. Tool replies are structured envelopes ({success, summary, data,',
  'artifacts?, warnings?} or {success:false, error:{code,...}}); read `error.code` to decide',
  'the next step, and read `artifacts.log` in the workspace when you need raw output.',
].join(' ');

export function createMcpServer(context: ServerContext): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: VERSION },
    { capabilities: { tools: {} }, instructions: SERVER_INSTRUCTIONS },
  );
  registerTools(server, context, ALL_TOOLS);
  context.logger.info('mcp server assembled', {
    version: VERSION,
    tools: ALL_TOOLS.map((tool) => tool.name),
  });
  return server;
}

export function listToolNames(): string[] {
  return ALL_TOOLS.map((tool) => tool.name);
}
