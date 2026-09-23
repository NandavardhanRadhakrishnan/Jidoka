import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { McpServerConfig } from "../config";
import type { ToolSpec } from "../ai/provider";
import { TOOL_SEPARATOR, splitToolName } from "./names";

export interface McpLike {
  listTools(): Promise<{
    tools: {
      name: string;
      description?: string;
      inputSchema: unknown;
      annotations?: { readOnlyHint?: boolean };
    }[];
  }>;
  callTool(args: {
    name: string;
    arguments: Record<string, unknown>;
  }): Promise<{ content: { type: string; text?: string }[]; isError?: boolean }>;
  close(): Promise<void>;
}

export class McpManager {
  private clients = new Map<string, McpLike>();
  private tools: ToolSpec[] = [];

  addClient(name: string, client: McpLike): void {
    this.clients.set(name, client);
  }

  async connectAll(configs: McpServerConfig[]): Promise<void> {
    for (const config of configs) {
      try {
        const client = new Client({ name: "jidoka", version: "0.1.0" });
        await client.connect(
          new StdioClientTransport({ command: config.command, args: config.args }),
        );
        this.addClient(config.name, client as unknown as McpLike);
      } catch (error) {
        console.error(
          `[mcp] failed to connect to "${config.name}" (${config.command}):`,
          error instanceof Error ? error.message : String(error),
        );
      }
    }
    await this.refreshTools();
  }

  async refreshTools(): Promise<ToolSpec[]> {
    const specs: ToolSpec[] = [];
    for (const [server, client] of this.clients) {
      const { tools } = await client.listTools();
      for (const tool of tools) {
        specs.push({
          name: `${server}${TOOL_SEPARATOR}${tool.name}`,
          description: tool.description ?? "",
          inputSchema: (tool.inputSchema ?? { type: "object" }) as Record<string, unknown>,
          ...(tool.annotations ? { annotations: tool.annotations } : {}),
        });
      }
    }
    this.tools = specs;
    return specs;
  }

  listTools(): ToolSpec[] {
    return this.tools;
  }

  async callTool(
    server: string,
    tool: string,
    input: Record<string, unknown>,
  ): Promise<string> {
    const client = this.clients.get(server);
    if (!client) throw new Error(`unknown MCP server: ${server}`);

    const result = await client.callTool({ name: tool, arguments: input });
    const text = result.content
      .filter((block) => block.type === "text")
      .map((block) => block.text ?? "")
      .join("\n");

    if (result.isError) throw new Error(`MCP tool ${server}/${tool} failed: ${text}`);
    return text;
  }

  async callPrefixed(name: string, input: Record<string, unknown>): Promise<string> {
    const { server, tool } = splitToolName(name);
    return this.callTool(server, tool, input);
  }

  async close(): Promise<void> {
    for (const client of this.clients.values()) await client.close();
    this.clients.clear();
    this.tools = [];
  }
}
