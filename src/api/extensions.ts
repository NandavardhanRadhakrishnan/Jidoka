import { Hono } from "hono";
import type { Database } from "bun:sqlite";
import { mkdtemp, mkdir, copyFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as extensionsRepo from "../repo/extensions";
import { discoverExtensions } from "../extensions/discovery";
import { generateExtension, type GeneratedExtension } from "../extensions/generator";
import { AuthPendingError, type Vault } from "../vault/vault";
import type { AgentRunner } from "../agent/runner";
import type { ToolSpec } from "../ai/provider";
import type { ExtensionManifest } from "../domain/extension";

export interface ExtensionRoutesDeps {
  db: Database;
  vault: Vault;
  extensionsDir: string;
  runAgent: AgentRunner;
  listTools: () => ToolSpec[];
}

function escapeHtml(value: string): string {
  return value.replace(/[<>&"]/g, (ch) =>
    ch === "<" ? "&lt;" : ch === ">" ? "&gt;" : ch === "&" ? "&amp;" : "&quot;",
  );
}

function callbackUrl(requestUrl: string, id: string): string {
  return new URL(`/api/extensions/${id}/connect/pkce/callback`, requestUrl).toString();
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

interface PendingGeneration {
  tempDir: string;
  manifest: ExtensionManifest;
  mode: "create" | "fix";
  targetId: string;
}

export function createExtensionRoutes(deps: ExtensionRoutesDeps): Hono {
  const app = new Hono();

  const pending = new Map<string, PendingGeneration>();

  function uniqueId(baseId: string): string {
    const taken = new Set([
      ...extensionsRepo.list(deps.db).map((r) => r.id),
      ...[...pending.values()].map((p) => p.targetId),
    ]);
    if (!taken.has(baseId)) return baseId;
    let n = 2;
    while (taken.has(`${baseId}-${n}`)) n++;
    return `${baseId}-${n}`;
  }

  async function stageDraft(
    generated: GeneratedExtension,
    mode: "create" | "fix",
    targetId: string,
  ): Promise<string> {
    const tempDir = await mkdtemp(join(tmpdir(), "jidoka-ext-draft-"));
    await writeFile(join(tempDir, "manifest.json"), JSON.stringify(generated.manifest, null, 2));
    await writeFile(join(tempDir, "source.ts"), generated.source);
    const generationId = crypto.randomUUID();
    pending.set(generationId, { tempDir, manifest: generated.manifest, mode, targetId });
    return generationId;
  }

  function list() {
    return extensionsRepo.list(deps.db).map((record) => ({
      id: record.id,
      name: record.name,
      summary: record.summary,
      readOnly: record.readOnly,
      auth: record.auth,
      enabled: record.enabled,
      valid: record.valid,
      error: record.error,
      status: deps.vault.status(record.id),
    }));
  }

  app.get("/api/extensions", (c) => c.json({ extensions: list() }));

  app.post("/api/extensions/rescan", async (c) => {
    try {
      const discovered = await discoverExtensions(deps.db, deps.extensionsDir);
      return c.json({ discovered });
    } catch (error) {
      return c.json({ error: errorMessage(error) }, 500);
    }
  });

  app.post("/api/extensions/generate", async (c) => {
    let body: { description?: string } | null;
    try {
      body = (await c.req.json()) as { description?: string };
    } catch {
      body = null;
    }
    if (!body?.description?.trim()) return c.json({ error: "description is required" }, 400);

    try {
      const allowedTools = deps.listTools().map((t) => t.name);
      const generated = await generateExtension(
        deps.runAgent,
        { kind: "create", description: body.description },
        allowedTools,
      );
      const targetId = uniqueId(generated.manifest.id);
      const manifest = { ...generated.manifest, id: targetId };
      const generationId = await stageDraft({ manifest, source: generated.source }, "create", targetId);

      return c.json({ generationId, manifest });
    } catch (error) {
      return c.json({ error: errorMessage(error) }, 502);
    }
  });

  app.post("/api/extensions/generate/:id/approve", async (c) => {
    const generationId = c.req.param("id");
    const entry = pending.get(generationId);
    if (!entry) return c.json({ error: "unknown or expired generation" }, 404);

    const targetDir = join(deps.extensionsDir, entry.targetId);

    if (entry.mode === "create") {
      const exists = await stat(targetDir)
        .then(() => true)
        .catch(() => false);
      if (exists) {
        return c.json({ error: `an extension named "${entry.targetId}" already exists` }, 409);
      }
    }

    try {
      await mkdir(targetDir, { recursive: true });
      await copyFile(join(entry.tempDir, "manifest.json"), join(targetDir, "manifest.json"));
      await copyFile(join(entry.tempDir, "source.ts"), join(targetDir, "source.ts"));
    } catch (error) {
      await rm(targetDir, { recursive: true, force: true });
      return c.json({ error: errorMessage(error) }, 500);
    }

    await rm(entry.tempDir, { recursive: true, force: true });
    pending.delete(generationId);
    await discoverExtensions(deps.db, deps.extensionsDir);

    return c.json({ extensionId: entry.targetId });
  });

  app.post("/api/extensions/generate/:id/discard", async (c) => {
    const generationId = c.req.param("id");
    const entry = pending.get(generationId);
    if (!entry) return c.json({ error: "unknown or expired generation" }, 404);

    await rm(entry.tempDir, { recursive: true, force: true });
    pending.delete(generationId);

    return c.json({ discarded: true });
  });

  app.post("/api/extensions/:id/connect/api-key", async (c) => {
    const id = c.req.param("id");
    if (!extensionsRepo.get(deps.db, id)) return c.json({ error: "unknown extension" }, 404);
    let body: { apiKey?: string } | null;
    try {
      body = (await c.req.json()) as { apiKey?: string };
    } catch {
      body = null;
    }
    if (!body?.apiKey?.trim()) return c.json({ error: "apiKey is required" }, 400);
    try {
      deps.vault.saveApiKey(id, body.apiKey);
      return c.json({ connected: true });
    } catch (error) {
      return c.json({ error: errorMessage(error) }, 400);
    }
  });

  app.post("/api/extensions/:id/connect/device/start", async (c) => {
    const id = c.req.param("id");
    if (!extensionsRepo.get(deps.db, id)) return c.json({ error: "unknown extension" }, 404);
    try {
      return c.json(await deps.vault.startDeviceConnect(id));
    } catch (error) {
      return c.json({ error: errorMessage(error) }, 400);
    }
  });

  app.post("/api/extensions/:id/connect/device/complete", async (c) => {
    const id = c.req.param("id");
    if (!extensionsRepo.get(deps.db, id)) return c.json({ error: "unknown extension" }, 404);
    let body: { deviceCode?: string } | null;
    try {
      body = (await c.req.json()) as { deviceCode?: string };
    } catch {
      body = null;
    }
    if (!body?.deviceCode) return c.json({ error: "deviceCode is required" }, 400);
    try {
      await deps.vault.completeDeviceConnect(id, body.deviceCode);
      return c.json({ connected: true });
    } catch (error) {
      if (error instanceof AuthPendingError) return c.json({ pending: true }, 202);
      return c.json({ error: errorMessage(error) }, 400);
    }
  });

  app.get("/api/extensions/:id/connect/pkce/start", async (c) => {
    const id = c.req.param("id");
    if (!extensionsRepo.get(deps.db, id)) return c.json({ error: "unknown extension" }, 404);
    try {
      const { url } = await deps.vault.startAuthCodeConnect(id, callbackUrl(c.req.url, id));
      return c.redirect(url, 302);
    } catch (error) {
      return c.json({ error: errorMessage(error) }, 400);
    }
  });

  app.get("/api/extensions/:id/connect/pkce/callback", async (c) => {
    const id = c.req.param("id");
    if (!extensionsRepo.get(deps.db, id)) return c.json({ error: "unknown extension" }, 404);

    const error = c.req.query("error");
    if (error) {
      const description = c.req.query("error_description") ?? "";
      return c.html(
        `<h1>Connection failed</h1><p>${escapeHtml(error)} ${escapeHtml(description)}</p><p><a href="/">Back to the board</a></p>`,
        400,
      );
    }

    const code = c.req.query("code");
    const state = c.req.query("state");
    if (!code || !state) return c.json({ error: "code and state are required" }, 400);

    try {
      await deps.vault.completeAuthCodeConnect(id, code, state);
    } catch (e) {
      return c.html(
        `<h1>Connection failed</h1><p>${escapeHtml(errorMessage(e))}</p><p><a href="/">Back to the board</a></p>`,
        400,
      );
    }

    return c.redirect("/", 302);
  });

  app.post("/api/extensions/:id/disconnect", (c) => {
    const id = c.req.param("id");
    if (!extensionsRepo.get(deps.db, id)) return c.json({ error: "unknown extension" }, 404);
    deps.vault.disconnect(id);
    extensionsRepo.setEnabled(deps.db, id, false);
    return c.json({ disconnected: true });
  });

  app.post("/api/extensions/:id/enable", (c) => {
    const id = c.req.param("id");
    if (!extensionsRepo.get(deps.db, id)) return c.json({ error: "unknown extension" }, 404);
    if (deps.vault.status(id) !== "connected") {
      return c.json({ error: `extension "${id}" is not connected` }, 400);
    }
    extensionsRepo.setEnabled(deps.db, id, true);
    return c.json({ enabled: true });
  });

  app.post("/api/extensions/:id/disable", (c) => {
    const id = c.req.param("id");
    if (!extensionsRepo.get(deps.db, id)) return c.json({ error: "unknown extension" }, 404);
    extensionsRepo.setEnabled(deps.db, id, false);
    return c.json({ enabled: false });
  });

  return app;
}
