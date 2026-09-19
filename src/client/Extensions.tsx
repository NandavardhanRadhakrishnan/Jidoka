import { useCallback, useEffect, useRef, useState } from "react";
import { api, type ExtensionListItem } from "./api";

interface DeviceSession {
  id: string;
  userCode: string;
  verificationUri: string;
  deviceCode: string;
  deadline: number;
}

export function Extensions() {
  const [open, setOpen] = useState(false);
  const [extensions, setExtensions] = useState<ExtensionListItem[]>([]);
  const [connectingId, setConnectingId] = useState<string | null>(null);
  const [apiKeyValue, setApiKeyValue] = useState("");
  const [device, setDevice] = useState<DeviceSession | null>(null);
  const [error, setError] = useState<string | null>(null);
  const pollTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  const refresh = useCallback(async () => {
    setConnectingId(null);
    setDevice(null);
    setApiKeyValue("");
    try {
      setExtensions(await api.extensions());
    } catch {
      setExtensions([]);
    }
  }, []);

  useEffect(() => {
    if (open) void refresh();
  }, [open, refresh]);

  useEffect(() => {
    return () => {
      if (pollTimer.current) clearInterval(pollTimer.current);
    };
  }, []);

  function stopPolling() {
    if (pollTimer.current) {
      clearInterval(pollTimer.current);
      pollTimer.current = null;
    }
  }

  async function rescan() {
    setError(null);
    try {
      await api.rescanExtensions();
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function saveApiKey(id: string) {
    setError(null);
    try {
      await api.connectApiKey(id, apiKeyValue);
      setConnectingId(null);
      setApiKeyValue("");
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  function startDevice(id: string) {
    setError(null);
    api
      .startDeviceConnect(id)
      .then((login) => {
        const deadline = Date.now() + login.expiresIn * 1000;
        setDevice({
          id,
          userCode: login.userCode,
          verificationUri: login.verificationUri,
          deviceCode: login.deviceCode,
          deadline,
        });
        stopPolling();
        pollTimer.current = setInterval(async () => {
          if (Date.now() > deadline) {
            stopPolling();
            setDevice(null);
            setError("Device code expired — try connecting again.");
            return;
          }
          try {
            const result = await api.completeDeviceConnect(id, login.deviceCode);
            if (result.connected) {
              stopPolling();
              setDevice(null);
              setConnectingId(null);
              await refresh();
            }
          } catch (e) {
            stopPolling();
            setDevice(null);
            setError(e instanceof Error ? e.message : String(e));
          }
        }, login.interval * 1000);
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }

  async function activate(id: string) {
    setError(null);
    try {
      await api.enableExtension(id);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function disable(id: string) {
    setError(null);
    try {
      await api.disableExtension(id);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function disconnect(id: string) {
    setError(null);
    try {
      await api.disconnectExtension(id);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  function dotClass(status: ExtensionListItem["status"]): string {
    if (status === "connected") return "dot on";
    if (status === "needs_reauth") return "dot warn";
    return "dot off";
  }

  return (
    <>
      <button className="link" onClick={() => setOpen(true)}>
        Extensions
      </button>

      {open && (
        <div className="dialog extensions">
          <h2>Extensions</h2>
          <button onClick={rescan}>Rescan</button>
          {error && <p className="error">{error}</p>}

          {extensions.length === 0 && <p className="meta">No extensions discovered.</p>}

          {extensions.map((ext) => (
            <div key={ext.id} className="extension-row">
              <span className={dotClass(ext.status)} /> <strong>{ext.name}</strong>
              <p>{ext.summary}</p>

              {!ext.valid && <p className="error">{ext.error}</p>}

              {ext.valid && (ext.status === "not_connected" || ext.status === "needs_reauth") &&
                connectingId !== ext.id && (
                  <button className="link" onClick={() => setConnectingId(ext.id)}>
                    {ext.status === "needs_reauth" ? "Reconnect" : "Connect"}
                  </button>
                )}

              {connectingId === ext.id && ext.auth && ext.auth.mode === "api-key" && (
                <div className="connect-form">
                  <label>
                    {ext.auth.label}
                    <input value={apiKeyValue} onChange={(e) => setApiKeyValue(e.target.value)} />
                  </label>
                  <button onClick={() => saveApiKey(ext.id)}>Save</button>
                </div>
              )}

              {connectingId === ext.id && ext.auth && ext.auth.mode === "oauth2-auth-code-pkce" && (
                <a className="link" href={`/api/extensions/${ext.id}/connect/pkce/start`}>
                  Continue in browser
                </a>
              )}

              {connectingId === ext.id && ext.auth && ext.auth.mode === "oauth2-device-code" && !device && (
                <button onClick={() => startDevice(ext.id)}>Connect</button>
              )}

              {device?.id === ext.id && (
                <div className="device-code">
                  <p>
                    Go to{" "}
                    <a href={device.verificationUri} target="_blank" rel="noreferrer">
                      {device.verificationUri}
                    </a>{" "}
                    and enter code <strong>{device.userCode}</strong>
                  </p>
                </div>
              )}

              {ext.status === "connected" && !ext.enabled && (
                <button className="link" onClick={() => activate(ext.id)}>
                  Activate
                </button>
              )}

              {ext.enabled && (
                <>
                  <button className="link" onClick={() => disable(ext.id)}>
                    Disable
                  </button>
                  <button className="link" onClick={() => disconnect(ext.id)}>
                    Disconnect
                  </button>
                </>
              )}
            </div>
          ))}

          <button
            className="secondary"
            onClick={() => {
              stopPolling();
              setDevice(null);
              setConnectingId(null);
              setOpen(false);
            }}
          >
            Close
          </button>
        </div>
      )}
    </>
  );
}
