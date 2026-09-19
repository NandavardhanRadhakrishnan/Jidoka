import { Hono } from "hono";
import type { Database } from "bun:sqlite";
import * as extensionsRepo from "../repo/extensions";
import { discoverExtensions } from "../extensions/discovery";
import { AuthPendingError, type Vault } from "../vault/vault";

export interface ExtensionRoutesDeps {
  db: Database;
  vault: Vault;
  extensionsDir: string;
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

export function createExtensionRoutes(deps: ExtensionRoutesDeps): Hono {
  const app = new Hono();

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
    const discovered = await discoverExtensions(deps.db, deps.extensionsDir);
    return c.json({ discovered });
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
