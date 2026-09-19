import { test, expect } from "bun:test";
import { ExtensionManifestSchema } from "../../src/domain/extension";

const base = {
  id: "notion",
  name: "Notion",
  version: "1.0.0",
  summary: "Reads pages from the databases you select.",
  readOnly: true,
};

test("a valid api-key manifest parses", () => {
  const result = ExtensionManifestSchema.safeParse({
    ...base,
    auth: { mode: "api-key", label: "Personal Access Token" },
  });
  expect(result.success).toBe(true);
});

test("a valid device-code manifest parses", () => {
  const result = ExtensionManifestSchema.safeParse({
    ...base,
    auth: {
      mode: "oauth2-device-code",
      deviceCodeUrl: "https://example.com/devicecode",
      tokenUrl: "https://example.com/token",
      clientId: "client-1",
      scopes: ["read"],
    },
  });
  expect(result.success).toBe(true);
});

test("a valid auth-code+PKCE manifest parses, and expectedMcpServer is optional", () => {
  const result = ExtensionManifestSchema.safeParse({
    ...base,
    auth: {
      mode: "oauth2-auth-code-pkce",
      authorizeUrl: "https://example.com/authorize",
      tokenUrl: "https://example.com/token",
      clientId: "client-1",
      scopes: ["read"],
    },
    expectedMcpServer: "notion",
  });
  expect(result.success).toBe(true);
  expect(result.data?.expectedMcpServer).toBe("notion");
});

test("a device-code auth block missing tokenUrl is rejected", () => {
  const result = ExtensionManifestSchema.safeParse({
    ...base,
    auth: {
      mode: "oauth2-device-code",
      deviceCodeUrl: "https://example.com/devicecode",
      clientId: "client-1",
      scopes: ["read"],
    },
  });
  expect(result.success).toBe(false);
});

test("an unknown auth mode is rejected", () => {
  const result = ExtensionManifestSchema.safeParse({
    ...base,
    auth: { mode: "basic-auth", username: "a", password: "b" },
  });
  expect(result.success).toBe(false);
});

test("readOnly and summary are required", () => {
  const { readOnly, ...withoutReadOnly } = base;
  const result = ExtensionManifestSchema.safeParse({
    ...withoutReadOnly,
    auth: { mode: "api-key", label: "Token" },
  });
  expect(result.success).toBe(false);
});
