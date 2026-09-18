import { Hono } from "hono";
import type { Database } from "bun:sqlite";
import {
  buildAuthorizeUrl,
  createPkcePair,
  exchangeCode,
  refreshTokens,
  type OAuthProviderConfig,
} from "../auth/oauth";
import { loadTokens, saveTokens, deleteTokens } from "../repo/oauthTokens";

/** How long a started sign-in may sit unfinished before its state is dropped. */
const PENDING_TTL_MS = 10 * 60_000;

interface Pending {
  providerId: string;
  verifier: string;
  redirectUri: string;
  startedAt: number;
}

export interface AuthDeps {
  db: Database;
  providers: Record<string, OAuthProviderConfig>;
  now?: () => number;
}

function callbackUrl(requestUrl: string, providerId: string): string {
  return new URL(`/api/auth/${providerId}/callback`, requestUrl).toString();
}

function escapeHtml(value: string): string {
  return value.replace(/[<>&"]/g, (ch) =>
    ch === "<" ? "&lt;" : ch === ">" ? "&gt;" : ch === "&" ? "&amp;" : "&quot;",
  );
}

/**
 * Browser sign-in: /api/auth/:id/start sends the user to the provider, and the
 * provider sends them back to /api/auth/:id/callback with a code we exchange for
 * tokens. PKCE state lives in memory — a restart mid-sign-in just means starting
 * again, and nothing secret is written to disk before the exchange succeeds.
 */
export function createAuthRoutes(deps: AuthDeps): Hono {
  const app = new Hono();
  const pending = new Map<string, Pending>();
  const clock = deps.now ?? Date.now;

  function sweep(): void {
    const cutoff = clock() - PENDING_TTL_MS;
    for (const [state, entry] of pending) {
      if (entry.startedAt < cutoff) pending.delete(state);
    }
  }

  app.get("/api/auth", (c) => {
    const now = clock();
    return c.json({
      providers: Object.values(deps.providers).map((provider) => {
        const stored = loadTokens(deps.db, provider.id);
        return {
          id: provider.id,
          connected: stored !== null,
          expiresAt: stored ? new Date(stored.expiresAt).toISOString() : null,
          expired: stored ? stored.expiresAt <= now : false,
          canRefresh: stored?.refreshToken !== null && stored !== null,
        };
      }),
    });
  });

  app.get("/api/auth/:id/start", async (c) => {
    const provider = deps.providers[c.req.param("id")];
    if (!provider) return c.json({ error: "unknown provider" }, 404);

    sweep();
    const { verifier, challenge } = await createPkcePair();
    const state = crypto.randomUUID();
    const redirectUri = callbackUrl(c.req.url, provider.id);
    pending.set(state, { providerId: provider.id, verifier, redirectUri, startedAt: clock() });

    return c.redirect(buildAuthorizeUrl(provider, { redirectUri, state, challenge }), 302);
  });

  app.get("/api/auth/:id/callback", async (c) => {
    const provider = deps.providers[c.req.param("id")];
    if (!provider) return c.json({ error: "unknown provider" }, 404);

    const error = c.req.query("error");
    if (error) {
      const description = c.req.query("error_description") ?? "";
      return c.html(
        `<h1>Sign-in failed</h1><p>${escapeHtml(error)} ${escapeHtml(description)}</p><p><a href="/">Back to the board</a></p>`,
        400,
      );
    }

    const code = c.req.query("code");
    const state = c.req.query("state");
    if (!code || !state) return c.json({ error: "code and state are required" }, 400);

    sweep();
    const entry = pending.get(state);
    // One-time use: a replayed callback must not mint a second token.
    pending.delete(state);
    if (!entry || entry.providerId !== provider.id) {
      return c.json({ error: "unknown or expired sign-in state" }, 400);
    }

    try {
      const tokens = await exchangeCode(provider, {
        code,
        verifier: entry.verifier,
        redirectUri: entry.redirectUri,
      });
      saveTokens(deps.db, provider.id, tokens);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return c.html(
        `<h1>Sign-in failed</h1><p>${escapeHtml(message)}</p><p><a href="/">Back to the board</a></p>`,
        502,
      );
    }

    return c.redirect(`/?signed-in=${encodeURIComponent(provider.id)}`, 302);
  });

  app.post("/api/auth/:id/signout", (c) => {
    const provider = deps.providers[c.req.param("id")];
    if (!provider) return c.json({ error: "unknown provider" }, 404);
    deleteTokens(deps.db, provider.id);
    return c.json({ signedOut: true });
  });

  return app;
}

/**
 * A valid access token for `providerId`, refreshing it when it is close to
 * expiry. Returns null when nobody has signed in for that provider.
 */
export async function getValidAccessToken(
  deps: AuthDeps,
  providerId: string,
): Promise<string | null> {
  const provider = deps.providers[providerId];
  if (!provider) return null;

  const stored = loadTokens(deps.db, providerId);
  if (!stored) return null;

  const now = (deps.now ?? Date.now)();
  if (stored.expiresAt - 60_000 > now) return stored.accessToken;
  if (!stored.refreshToken) return null;

  const refreshed = await refreshTokens(provider, { refreshToken: stored.refreshToken });
  const tokens = {
    accessToken: refreshed.accessToken,
    refreshToken: refreshed.refreshToken ?? stored.refreshToken,
    expiresAt: refreshed.expiresAt,
  };
  saveTokens(deps.db, providerId, tokens);
  return tokens.accessToken;
}
