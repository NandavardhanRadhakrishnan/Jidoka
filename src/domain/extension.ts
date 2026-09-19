import { z } from "zod";

const DeviceCodeAuthSchema = z.object({
  mode: z.literal("oauth2-device-code"),
  deviceCodeUrl: z.string().min(1),
  tokenUrl: z.string().min(1),
  clientId: z.string().min(1),
  scopes: z.array(z.string()),
});

const AuthCodePkceAuthSchema = z.object({
  mode: z.literal("oauth2-auth-code-pkce"),
  authorizeUrl: z.string().min(1),
  tokenUrl: z.string().min(1),
  clientId: z.string().min(1),
  scopes: z.array(z.string()),
});

const ApiKeyAuthSchema = z.object({
  mode: z.literal("api-key"),
  label: z.string().min(1),
});

export const ExtensionAuthSchema = z.discriminatedUnion("mode", [
  DeviceCodeAuthSchema,
  AuthCodePkceAuthSchema,
  ApiKeyAuthSchema,
]);

export type ExtensionAuth = z.infer<typeof ExtensionAuthSchema>;
export type AuthMode = ExtensionAuth["mode"];

export const ExtensionManifestSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  version: z.string().min(1),
  /** Plain-language capability summary, shown in the onboarding wizard's review step. */
  summary: z.string().min(1),
  readOnly: z.boolean(),
  auth: ExtensionAuthSchema,
  /** Name Jidoka tries to match against a configured MCP server. */
  expectedMcpServer: z.string().optional(),
  /** Schema for non-secret settings; values are collected by the wizard's Config step (not built yet). */
  config: z.record(z.string(), z.unknown()).optional(),
});

export type ExtensionManifest = z.infer<typeof ExtensionManifestSchema>;
