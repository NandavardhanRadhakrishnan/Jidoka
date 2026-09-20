import { test, expect } from "bun:test";
import path from "node:path";
import { McpManager, type McpLike } from "../../src/mcp/manager";

function fakeClient(): McpLike & { calls: unknown[] } {
  return {
    calls: [],
    async listTools() {
      return {
        tools: [
          {
            name: "get_thread",
            description: "Fetch a mail thread",
            inputSchema: { type: "object", properties: { id: { type: "string" } } },
          },
        ],
      };
    },
    async callTool(args) {
      this.calls.push(args);
      if (args.name === "boom") {
        return { content: [{ type: "text", text: "tool exploded" }], isError: true };
      }
      return { content: [{ type: "text", text: "thread body" }] };
    },
    async close() {},
  };
}

test("listTools prefixes tool names with the server name", async () => {
  const manager = new McpManager();
  manager.addClient("outlook", fakeClient());

  const tools = await manager.refreshTools();

  expect(tools).toEqual([
    {
      name: "outlook__get_thread",
      description: "Fetch a mail thread",
      inputSchema: { type: "object", properties: { id: { type: "string" } } },
    },
  ]);
  expect(manager.listTools()).toEqual(tools);
});

test("callTool forwards arguments and returns the text content", async () => {
  const manager = new McpManager();
  const client = fakeClient();
  manager.addClient("outlook", client);

  const output = await manager.callTool("outlook", "get_thread", { id: "m1" });

  expect(output).toBe("thread body");
  expect(client.calls).toEqual([{ name: "get_thread", arguments: { id: "m1" } }]);
});

test("callPrefixed splits the server and tool name", async () => {
  const manager = new McpManager();
  manager.addClient("outlook", fakeClient());

  expect(await manager.callPrefixed("outlook__get_thread", { id: "m1" })).toBe("thread body");
});

test("an unknown server throws a clear error", async () => {
  const manager = new McpManager();

  await expect(manager.callTool("ghost", "x", {})).rejects.toThrow(/unknown MCP server: ghost/);
});

test("a tool error is surfaced as a thrown error", async () => {
  const manager = new McpManager();
  manager.addClient("outlook", fakeClient());

  await expect(manager.callTool("outlook", "boom", {})).rejects.toThrow(/tool exploded/);
});

test("connectAll does not reject when one server fails to connect, and still connects the others", async () => {
  const manager = new McpManager();
  const fixture = path.join(import.meta.dir, "fixtures", "fake-stdio-server.ts");
  const originalConsoleError = console.error;
  console.error = () => {};

  try {
    await manager.connectAll([
      { name: "bad", command: "this-command-does-not-exist-xyz", args: [] },
      { name: "good", command: process.execPath, args: ["run", fixture] },
    ]);
  } finally {
    console.error = originalConsoleError;
  }

  const tools = manager.listTools();
  expect(tools.some((t) => t.name === "good__ping")).toBe(true);
}, 15000);
