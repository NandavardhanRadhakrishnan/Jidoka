import { test, expect } from "bun:test";
import { openDb, migrate } from "../../src/db";
import { loadConfig } from "../../src/config";
import { createSettingsRoutes } from "../../src/api/settings";

function freshApp() {
  const db = openDb(":memory:");
  migrate(db);
  const baseConfig = loadConfig({});
  const server = createSettingsRoutes({ db, baseConfig });
  return { fetch: (req: Request) => server.fetch(req) };
}

test("GET /api/settings returns effective defaults with no api key leaked", async () => {
  const { fetch } = freshApp();

  const response = await fetch(new Request("http://localhost/api/settings"));
  const body = (await response.json()) as {
    effective: { ai: { provider: string; apiKeyConfigured: boolean } };
  };

  expect(response.status).toBe(200);
  expect(body.effective.ai.provider).toBe("anthropic");
  expect(body.effective.ai.apiKeyConfigured).toBe(false);
});

test("PATCH /api/settings persists and a later GET reflects it", async () => {
  const { fetch } = freshApp();

  const patchResponse = await fetch(
    new Request("http://localhost/api/settings", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sampleDir: "./samples", ai: { model: "claude-sonnet-5" } }),
    }),
  );
  const patched = (await patchResponse.json()) as {
    effective: { sampleDir?: string; ai: { model?: string } };
  };
  expect(patched.effective.sampleDir).toBe("./samples");
  expect(patched.effective.ai.model).toBe("claude-sonnet-5");

  const getResponse = await fetch(new Request("http://localhost/api/settings"));
  const body = (await getResponse.json()) as {
    settings: { sampleDir?: string };
    effective: { sampleDir?: string };
  };
  expect(body.settings.sampleDir).toBe("./samples");
  expect(body.effective.sampleDir).toBe("./samples");
});

test("an api key is never echoed back as plaintext, only as apiKeyConfigured", async () => {
  const { fetch } = freshApp();

  const response = await fetch(
    new Request("http://localhost/api/settings", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ai: { apiKey: "sk-super-secret" } }),
    }),
  );
  const raw = await response.text();
  const body = JSON.parse(raw) as {
    settings: { ai: { apiKeyConfigured: boolean } };
    effective: { ai: { apiKeyConfigured: boolean } };
  };

  expect(body.settings.ai.apiKeyConfigured).toBe(true);
  expect(body.effective.ai.apiKeyConfigured).toBe(true);
  expect(raw).not.toContain("sk-super-secret");
});

test("PATCH with an invalid JSON body is a 400, not a crash", async () => {
  const { fetch } = freshApp();

  const response = await fetch(
    new Request("http://localhost/api/settings", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: "not json",
    }),
  );

  expect(response.status).toBe(400);
});
