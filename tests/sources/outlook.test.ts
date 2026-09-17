import { test, expect } from "bun:test";
import { openDb, migrate } from "../../src/db";
import { getAccessToken, saveTokens } from "../../src/sources/outlook/auth";
import { createOutlookSource } from "../../src/sources/outlook/source";

function freshDb() {
  const db = openDb(":memory:");
  migrate(db);
  return db;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

test("getAccessToken returns a stored token that has not expired", async () => {
  const db = freshDb();
  saveTokens(db, { accessToken: "at-1", refreshToken: "rt-1", expiresAt: 2_000_000 });

  const token = await getAccessToken({
    db,
    clientId: "client",
    tenant: "common",
    now: () => 1_000_000,
    fetch: async () => {
      throw new Error("should not refresh");
    },
  });

  expect(token).toBe("at-1");
});

test("getAccessToken refreshes an expired token and stores the new one", async () => {
  const db = freshDb();
  saveTokens(db, { accessToken: "at-1", refreshToken: "rt-1", expiresAt: 1_000 });
  const calls: string[] = [];

  const token = await getAccessToken({
    db,
    clientId: "client",
    tenant: "common",
    now: () => 1_000_000,
    fetch: async (input, init) => {
      calls.push(String(input));
      expect(String(init?.body)).toContain("grant_type=refresh_token");
      return jsonResponse({ access_token: "at-2", refresh_token: "rt-2", expires_in: 3600 });
    },
  });

  expect(token).toBe("at-2");
  expect(calls[0]).toContain("/common/oauth2/v2.0/token");

  const again = await getAccessToken({
    db,
    clientId: "client",
    tenant: "common",
    now: () => 1_000_001,
    fetch: async () => {
      throw new Error("should not refresh twice");
    },
  });
  expect(again).toBe("at-2");
});

test("the Outlook source maps Graph messages to raw items and advances the cursor", async () => {
  const db = freshDb();
  saveTokens(db, { accessToken: "at-1", refreshToken: "rt-1", expiresAt: 9_000_000 });
  let requestedUrl = "";

  const source = createOutlookSource({
    db,
    clientId: "client",
    tenant: "common",
    now: () => 1_000_000,
    fetch: async (input) => {
      requestedUrl = String(input);
      return jsonResponse({
        value: [
          {
            id: "AAM=1",
            subject: "Where is my order?",
            body: { content: "<p>It has not arrived</p>", contentType: "html" },
            bodyPreview: "It has not arrived",
            from: { emailAddress: { address: "customer@example.com", name: "A Customer" } },
            receivedDateTime: "2026-01-02T09:30:00Z",
            webLink: "https://outlook.office.com/mail/id/AAM%3D1",
            conversationId: "conv-1",
          },
        ],
      });
    },
  });

  const result = await source.poll("2026-01-01T00:00:00Z");

  expect(source.id).toBe("outlook");
  expect(requestedUrl).toContain("receivedDateTime%20gt%202026-01-01T00%3A00%3A00Z");
  expect(result.items).toEqual([
    {
      externalId: "AAM=1",
      title: "Where is my order?",
      body: "It has not arrived",
      url: "https://outlook.office.com/mail/id/AAM%3D1",
      metadata: {
        from: "customer@example.com",
        fromName: "A Customer",
        receivedAt: "2026-01-02T09:30:00Z",
        conversationId: "conv-1",
      },
    },
  ]);
  expect(result.cursor).toBe("2026-01-02T09:30:00Z");
});

test("an empty Graph page keeps the previous cursor", async () => {
  const db = freshDb();
  saveTokens(db, { accessToken: "at-1", refreshToken: "rt-1", expiresAt: 9_000_000 });

  const source = createOutlookSource({
    db,
    clientId: "client",
    tenant: "common",
    now: () => 1_000_000,
    fetch: async () => jsonResponse({ value: [] }),
  });

  const result = await source.poll("2026-01-01T00:00:00Z");

  expect(result.items).toEqual([]);
  expect(result.cursor).toBe("2026-01-01T00:00:00Z");
});
