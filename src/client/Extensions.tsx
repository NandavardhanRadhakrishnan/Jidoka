import { useCallback, useEffect, useRef, useState } from "react";
import { api, type ExtensionListItem, type GenerationDraft } from "./api";
import { Icon } from "./icons";

interface DeviceSession {
  id: string;
  userCode: string;
  verificationUri: string;
  deviceCode: string;
  deadline: number;
}

function extensionIcon(name: string): string {
  const n = name.toLowerCase();
  if (n.includes("github")) return "github";
  if (n.includes("outlook") || n.includes("mail")) return "mail";
  if (n.includes("sample") || n.includes("folder")) return "folder";
  return "server";
}

export function Extensions() {
  const [extensions, setExtensions] = useState<ExtensionListItem[]>([]);
  const [connectingId, setConnectingId] = useState<string | null>(null);
  const [apiKeyValue, setApiKeyValue] = useState("");
  const [device, setDevice] = useState<DeviceSession | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState<GenerationDraft | null>(null);
  const [description, setDescription] = useState("");
  const [generating, setGenerating] = useState(false);
  const [testResults, setTestResults] = useState<
    Record<string, { itemCount: number } | { error: string } | undefined>
  >({});
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
    void refresh();
  }, [refresh]);

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

  async function generate() {
    setError(null);
    setGenerating(true);
    if (draft) {
      try {
        await api.discardGeneration(draft.generationId);
      } catch {
        // best-effort cleanup of the draft being replaced
      }
    }
    try {
      const result = await api.generateExtension(description);
      setDraft(result);
      setDescription("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setGenerating(false);
    }
  }

  async function approveDraft() {
    if (!draft) return;
    setError(null);
    try {
      await api.approveGeneration(draft.generationId);
      setDraft(null);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function discardDraft() {
    if (!draft) return;
    setError(null);
    try {
      await api.discardGeneration(draft.generationId);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setDraft(null);
    }
  }

  async function testPoll(id: string) {
    try {
      const result = await api.testPoll(id);
      setTestResults((prev) => ({ ...prev, [id]: { itemCount: result.itemCount } }));
    } catch (e) {
      setTestResults((prev) => ({
        ...prev,
        [id]: { error: e instanceof Error ? e.message : String(e) },
      }));
    }
  }

  async function fix(id: string) {
    const result = testResults[id];
    if (!result || !("error" in result)) return;
    setError(null);
    if (draft) {
      try {
        await api.discardGeneration(draft.generationId);
      } catch {
        // best-effort cleanup of the draft being replaced
      }
    }
    try {
      const draftResult = await api.fixExtension(id, result.error);
      setDraft(draftResult);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function deleteExtension(id: string) {
    if (!window.confirm(`Delete "${id}"? This removes it and its credentials permanently.`)) return;
    setError(null);
    try {
      await api.deleteExtension(id);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  function testResultView(id: string) {
    const result = testResults[id];
    if (!result) return null;
    if ("error" in result) {
      return (
        <>
          <p className="error-text">✗ {result.error}</p>
          <button className="btn btn-ghost" style={{ alignSelf: "flex-start", padding: 0, fontSize: 12 }} onClick={() => fix(id)}>
            Fix
          </button>
        </>
      );
    }
    return (
      <p className="mono" style={{ fontSize: 11, color: "var(--color-neutral-700)" }}>
        ✓ {result.itemCount} item(s) found
      </p>
    );
  }

  function toneOf(status: ExtensionListItem["status"], enabled: boolean): string {
    if (status === "needs_reauth") return "var(--color-accent)";
    if (status === "connected" && enabled) return "var(--color-neutral-800)";
    return "var(--color-neutral-500)";
  }

  return (
    <div style={{ padding: "18px 20px 48px", maxWidth: 980 }}>
      <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 8 }}>
        <button className="btn btn-secondary" onClick={rescan}>
          Rescan
        </button>
      </div>

      {error && <p className="error-text">{error}</p>}

      {extensions.length === 0 && <p className="text-muted">No extensions discovered.</p>}

      <div className="extension-list">
        {extensions.map((ext) => (
          <div key={ext.id} className="ext-row">
            <div className="tone-bar" style={{ background: toneOf(ext.status, ext.enabled) }} />
            <div className="body">
              <div className="head">
                <Icon name={extensionIcon(ext.name)} />
                <span className="name">{ext.name}</span>
                <span className="mono status" style={{ color: toneOf(ext.status, ext.enabled) }}>
                  {ext.status.replace(/_/g, " ")}
                </span>
              </div>
              <span className="desc">{ext.summary}</span>

              {!ext.valid && <p className="error-text">{ext.error}</p>}

              {ext.valid && (ext.status === "not_connected" || ext.status === "needs_reauth") && connectingId !== ext.id && (
                <button className="btn btn-primary" style={{ alignSelf: "flex-start", padding: "6px 12px", fontSize: 12 }} onClick={() => setConnectingId(ext.id)}>
                  {ext.status === "needs_reauth" ? "Reconnect" : "Connect"}
                </button>
              )}

              {connectingId === ext.id && ext.auth && ext.auth.mode === "api-key" && (
                <div style={{ display: "flex", gap: 8, alignItems: "flex-end", flexWrap: "wrap" }}>
                  <div className="field" style={{ minWidth: 220 }}>
                    <label>{ext.auth.label}</label>
                    <input className="input" type="password" value={apiKeyValue} onChange={(e) => setApiKeyValue(e.target.value)} />
                  </div>
                  <button className="btn btn-primary" onClick={() => saveApiKey(ext.id)}>
                    Save
                  </button>
                </div>
              )}

              {connectingId === ext.id && ext.auth && ext.auth.mode === "oauth2-auth-code-pkce" && (
                <a className="btn btn-primary" style={{ alignSelf: "flex-start" }} href={`/api/extensions/${ext.id}/connect/pkce/start`}>
                  Continue in browser
                </a>
              )}

              {connectingId === ext.id && ext.auth && ext.auth.mode === "oauth2-device-code" && !device && (
                <button className="btn btn-primary" style={{ alignSelf: "flex-start" }} onClick={() => startDevice(ext.id)}>
                  Connect
                </button>
              )}

              {device?.id === ext.id && (
                <p className="mono" style={{ fontSize: 12.5 }}>
                  Go to{" "}
                  <a href={device.verificationUri} target="_blank" rel="noreferrer">
                    {device.verificationUri}
                  </a>{" "}
                  and enter code <strong>{device.userCode}</strong>
                </p>
              )}

              {testResultView(ext.id)}

              <span className="mono meta">{ext.readOnly ? "read-only" : "can write"}</span>
            </div>
            <div className="actions">
              {ext.status === "connected" && !ext.enabled && (
                <button className="btn btn-primary" style={{ padding: "6px 12px", fontSize: 12 }} onClick={() => activate(ext.id)}>
                  Activate
                </button>
              )}
              {ext.status === "connected" && (
                <button className="btn btn-secondary" style={{ padding: "6px 12px", fontSize: 12 }} onClick={() => testPoll(ext.id)}>
                  Test
                </button>
              )}
              {ext.enabled && (
                <button className="btn btn-secondary" style={{ padding: "6px 12px", fontSize: 12 }} onClick={() => disable(ext.id)}>
                  Disable
                </button>
              )}
              {ext.enabled && (
                <button className="btn btn-secondary" style={{ padding: "6px 12px", fontSize: 12 }} onClick={() => disconnect(ext.id)}>
                  Disconnect
                </button>
              )}
              <button className="btn btn-ghost btn-danger" style={{ padding: "6px 12px", fontSize: 12 }} onClick={() => deleteExtension(ext.id)}>
                Delete
              </button>
            </div>
          </div>
        ))}
      </div>

      <hr className="hr" />

      <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) 280px", gap: 24, marginTop: 6 }}>
        <div>
          <h5 style={{ marginBottom: 6 }}>Describe a source you don't have</h5>
          <p className="text-muted" style={{ maxWidth: "58ch", fontSize: 12.5 }}>
            An agent writes the connector, then shows you its manifest and the calls it makes. It stays sandboxed
            with no credentials until you approve it.
          </p>
          <textarea
            className="input"
            style={{ minHeight: 76, fontSize: 13 }}
            placeholder="e.g. poll the Zendesk views I own every 5 minutes and make a task per unassigned ticket"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
          <button className="btn btn-primary" style={{ marginTop: 8 }} disabled={generating || !description.trim()} onClick={generate}>
            {generating ? "Generating…" : "Generate connector"}
          </button>

          {draft && (
            <div className="ext-row" style={{ marginTop: 12 }}>
              <div className="tone-bar" style={{ background: "var(--color-accent)" }} />
              <div className="body">
                <span className="name">{draft.manifest.name}</span>
                <span className="desc">{draft.manifest.summary}</span>
                <span className="mono meta">
                  {draft.manifest.readOnly ? "Read-only" : "Can write"} · {draft.manifest.auth.mode}
                </span>
              </div>
              <div className="actions">
                <button className="btn btn-primary" style={{ padding: "6px 12px", fontSize: 12 }} onClick={approveDraft}>
                  Approve
                </button>
                <button className="btn btn-secondary" style={{ padding: "6px 12px", fontSize: 12 }} onClick={discardDraft}>
                  Discard
                </button>
              </div>
            </div>
          )}
        </div>
        <div style={{ borderLeft: "2px solid var(--color-divider)", paddingLeft: 16 }}>
          <h6 style={{ marginBottom: 8 }}>Review gate</h6>
          <ol style={{ margin: 0, paddingLeft: 16, fontSize: 12, color: "var(--color-neutral-800)", lineHeight: 1.7 }}>
            <li>read the manifest</li>
            <li>see every endpoint it calls</li>
            <li>then hand it credentials</li>
          </ol>
        </div>
      </div>
    </div>
  );
}
