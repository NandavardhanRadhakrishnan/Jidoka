// Minimal stdio MCP server used only by manager.test.ts to prove that
// McpManager.connectAll can connect to a real server over a real subprocess.
// It exposes a single "ping" tool and nothing else.
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const server = new Server({ name: "fixture", version: "0.1.0" }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [{ name: "ping", description: "ping", inputSchema: { type: "object" } }],
}));

server.setRequestHandler(CallToolRequestSchema, async () => ({
  content: [{ type: "text", text: "pong" }],
}));

await server.connect(new StdioServerTransport());
