import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult, ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';

import type { ToolEnvelope } from '../types/errors.js';
import type { PermissionLevel, WorkspaceState } from '../types/workspace.js';
import type { SessionCapabilities } from '../security/permission.js';
import type { ServerContext } from './context.js';
import { errors } from '../errors/devpilot-error.js';
import { fail } from '../errors/envelope.js';
import { requireLevel } from '../security/permission.js';

/**
 * Tool layer (docs/ARCHITECTURE.md §2 L1, §5 request flow).
 * A tool declares its schema, its permission requirement and whether it needs an open
 * workspace; the registry validates, gates, resolves and wraps — the handler only talks
 * to domain services and returns an envelope.
 */

export type ZodRawShape = z.ZodRawShape;
export type ShapeOutput<Shape extends ZodRawShape> = z.infer<z.ZodObject<Shape>>;

export interface ToolCallContext {
  ctx: ServerContext;
  /** Present when the tool declared `requiresWorkspace`. */
  workspace?: WorkspaceState;
  /** Present when a workspace was resolved. */
  capabilities?: SessionCapabilities;
}

export interface ToolDefinition<Shape extends ZodRawShape = ZodRawShape> {
  name: string;
  title: string;
  description: string;
  /** Minimum permission level for the session. */
  permission: PermissionLevel;
  /** Resolve the active/requested workspace before the handler runs. */
  requiresWorkspace?: boolean;
  inputSchema: Shape;
  handler: (
    args: ShapeOutput<Shape>,
    context: ToolCallContext,
  ) => Promise<ToolEnvelope<unknown>>;
}

/* eslint-disable-next-line @typescript-eslint/no-explicit-any */
export type AnyToolDefinition = ToolDefinition<any>;

/** Identity helper that preserves the schema shape for type inference in handlers. */
export function defineTool<Shape extends ZodRawShape>(definition: ToolDefinition<Shape>): ToolDefinition<Shape> {
  return definition;
}

export function toAnnotations(definition: AnyToolDefinition): ToolAnnotations {
  const annotations: ToolAnnotations = {
    title: definition.title,
    readOnlyHint: definition.permission === 'READ_ONLY',
    destructiveHint: false,
    idempotentHint: definition.permission === 'READ_ONLY',
    openWorldHint: false,
  };
  return annotations;
}

/** Map an envelope onto an MCP tool result: JSON text for humans + structured content. */
export function toCallToolResult(envelope: ToolEnvelope<unknown>): CallToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(envelope, null, 2) }],
    structuredContent: envelope as unknown as Record<string, unknown>,
    isError: envelope.success !== true,
  };
}

/**
 * Validate, gate, resolve and execute one tool call. Exported so unit tests can exercise
 * the whole path without an MCP client.
 */
export async function invokeTool(
  context: ServerContext,
  definition: AnyToolDefinition,
  rawArgs: unknown,
  options: { workspaceTarget?: string } = {},
): Promise<CallToolResult> {
  try {
    const parsed = z.object(definition.inputSchema).safeParse(rawArgs ?? {});
    if (!parsed.success) {
      throw errors.invalidArgument(
        `Invalid arguments for ${definition.name}`,
        parsed.error.issues.map((issue) => ({
          path: issue.path.join('.'),
          message: issue.message,
          code: issue.code,
        })),
      );
    }

    const args = parsed.data as Record<string, unknown>;
    const callContext: ToolCallContext = { ctx: context };

    if (definition.requiresWorkspace) {
      const target =
        options.workspaceTarget ?? (typeof args['path'] === 'string' ? (args['path'] as string) : undefined);
      const entry = await context.workspaces.resolveEntry(target);
      callContext.workspace = entry.state;
      callContext.capabilities = context.workspaces.sessionCapabilities(entry.state);
      requireLevel(callContext.capabilities, definition.permission, definition.name);
    }

    const envelope = await definition.handler(parsed.data, callContext);
    return toCallToolResult(envelope);
  } catch (error) {
    return toCallToolResult(fail(error));
  }
}

export function registerTool(
  server: McpServer,
  context: ServerContext,
  definition: AnyToolDefinition,
): void {
  server.registerTool(
    definition.name,
    {
      title: definition.title,
      description: definition.description,
      inputSchema: definition.inputSchema,
      annotations: toAnnotations(definition),
    },
    async (args: unknown) => invokeTool(context, definition, args),
  );
}

export function registerTools(
  server: McpServer,
  context: ServerContext,
  definitions: readonly AnyToolDefinition[],
): void {
  for (const definition of definitions) registerTool(server, context, definition);
}
