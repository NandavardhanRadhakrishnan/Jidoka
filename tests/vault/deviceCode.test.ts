import { test, expect } from "bun:test";
import {
  startDeviceLogin,
  completeDeviceLogin,
  AuthPendingError,
  type DeviceCodeConfig,
  type HttpFetch,
} from "../../src/vault/deviceCode";

const config: DeviceCodeConfig = {
  deviceCodeUrl: "https://example.com/devicecode",
  tokenUrl: "https://example.com/token",
  clientId: "client-1",
  scopes: ["read", "write"],
};

test("startDeviceLogin posts client_id and scopes and maps the response", async () => {
  let capturedUrl = "";
  let capturedBody = "";
  const fakeFetch: HttpFetch = async (input, init) => {
    capturedUrl = String(input);
    capturedBody = String(init?.body);
    return new Response(
      JSON.stringify({
        user_code: "ABCD-EFGH",
        device_code: "device-code-value",
        verification_uri: "https://example.com/activate",
        expires_in: 900,
        interval: 5,
      }),
      { status: 200 },
    );
  };

  const login = await startDeviceLogin(config, { fetch: fakeFetch });

  expect(capturedUrl).toBe(config.deviceCodeUrl);
  const body = new URLSearchParams(capturedBody);
  expect(body.get("client_id")).toBe("client-1");
  expect(body.get("scope")).toBe("read write");
  expect(login).toEqual({
    userCode: "ABCD-EFGH",
    deviceCode: "device-code-value",
    verificationUri: "https://example.com/activate",
    expiresIn: 900,
    interval: 5,
  });
});

test("startDeviceLogin throws when the request is not ok", async () => {
  const fakeFetch: HttpFetch = async () => new Response("", { status: 500 });
  await expect(startDeviceLogin(config, { fetch: fakeFetch })).rejects.toThrow(/500/);
});

test("completeDeviceLogin returns tokens on success", async () => {
  const fakeFetch: HttpFetch = async (_input, init) => {
    const body = new URLSearchParams(String(init?.body));
    expect(body.get("grant_type")).toBe("urn:ietf:params:oauth:grant-type:device_code");
    expect(body.get("device_code")).toBe("device-code-value");
    return new Response(
      JSON.stringify({ access_token: "at-1", refresh_token: "rt-1", expires_in: 3600 }),
      { status: 200 },
    );
  };

  const tokens = await completeDeviceLogin(config, "device-code-value", {
    fetch: fakeFetch,
    now: () => 1_000_000,
  });

  expect(tokens).toEqual({
    accessToken: "at-1",
    refreshToken: "rt-1",
    expiresAt: 1_000_000 + 3600 * 1000,
  });
});

test("completeDeviceLogin throws AuthPendingError while the user hasn't finished", async () => {
  const fakeFetch: HttpFetch = async () =>
    new Response(JSON.stringify({ error: "authorization_pending" }), { status: 400 });

  await expect(completeDeviceLogin(config, "device-code-value", { fetch: fakeFetch })).rejects.toBeInstanceOf(
    AuthPendingError,
  );
});

test("completeDeviceLogin throws a descriptive error for any other failure", async () => {
  const fakeFetch: HttpFetch = async () =>
    new Response(JSON.stringify({ error: "expired_token", error_description: "device code expired" }), {
      status: 400,
    });

  await expect(completeDeviceLogin(config, "device-code-value", { fetch: fakeFetch })).rejects.toThrow(
    /device code expired/,
  );
});
