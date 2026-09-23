import { useEffect, useState } from "react";
import { api, type EffectiveSettings, type SettingsPatch } from "./api";

interface McpServerRow {
  name: string;
  command: string;
  args: string;
}

function toRows(servers: EffectiveSettings["mcpServers"]): McpServerRow[] {
  return servers.map((s) => ({ name: s.name, command: s.command, args: s.args.join(" ") }));
}

function fromRows(rows: McpServerRow[]): { name: string; command: string; args: string[] }[] {
  return rows
    .filter((r) => r.name.trim() && r.command.trim())
    .map((r) => ({
      name: r.name.trim(),
      command: r.command.trim(),
      args: r.args.trim() ? r.args.trim().split(/\s+/) : [],
    }));
}

export function Settings() {
  const [effective, setEffective] = useState<EffectiveSettings | null>(null);
  const [aiProvider, setAiProvider] = useState("anthropic");
  const [aiApiKey, setAiApiKey] = useState("");
  const [aiModel, setAiModel] = useState("");
  const [aiBaseUrl, setAiBaseUrl] = useState("");
  const [agentRunner, setAgentRunner] = useState("in-process");
  const [agentModel, setAgentModel] = useState("");
  const [agentConcurrency, setAgentConcurrency] = useState(1);
  const [agentMaxBudget, setAgentMaxBudget] = useState("");
  const [mcpRows, setMcpRows] = useState<McpServerRow[]>([]);
  const [sampleDir, setSampleDir] = useState("");
  const [extensionsDir, setExtensionsDir] = useState("");
  const [pollIntervalMs, setPollIntervalMs] = useState(60000);
  const [terminalCommand, setTerminalCommand] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  async function load() {
    try {
      const { effective } = await api.settingsGet();
      setEffective(effective);
      setAiProvider(effective.ai.provider);
      setAiApiKey("");
      setAiModel(effective.ai.model ?? "");
      setAiBaseUrl(effective.ai.baseUrl ?? "");
      setAgentRunner(effective.agent.runner);
      setAgentModel(effective.agent.model ?? "");
      setAgentConcurrency(effective.agent.concurrency);
      setAgentMaxBudget(effective.agent.maxBudgetUsd?.toString() ?? "");
      setMcpRows(toRows(effective.mcpServers));
      setSampleDir(effective.sampleDir ?? "");
      setExtensionsDir(effective.extensionsDir);
      setPollIntervalMs(effective.pollIntervalMs);
      setTerminalCommand(effective.terminalCommand ?? "");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  useEffect(() => {
    void load();
  }, []);

  async function save() {
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      const patch: SettingsPatch = {
        ai: {
          provider: aiProvider,
          ...(aiApiKey.trim() ? { apiKey: aiApiKey.trim() } : {}),
          ...(aiModel.trim() ? { model: aiModel.trim() } : {}),
          ...(aiBaseUrl.trim() ? { baseUrl: aiBaseUrl.trim() } : {}),
        },
        agent: {
          runner: agentRunner,
          ...(agentModel.trim() ? { model: agentModel.trim() } : {}),
          concurrency: agentConcurrency,
          ...(agentMaxBudget.trim() ? { maxBudgetUsd: Number(agentMaxBudget) } : {}),
        },
        mcpServers: fromRows(mcpRows),
        ...(sampleDir.trim() ? { sampleDir: sampleDir.trim() } : {}),
        extensionsDir: extensionsDir.trim(),
        pollIntervalMs,
        ...(terminalCommand.trim() ? { terminalCommand: terminalCommand.trim() } : {}),
      };
      const nextEffective = await api.saveSettings(patch);
      setEffective(nextEffective);
      setAiApiKey("");
      setSaved(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  if (!effective) {
    return (
      <div className="settings-screen">
        <p className="text-muted">Loading…</p>
      </div>
    );
  }

  return (
    <div className="settings-screen">
      <section>
        <h6>AI provider</h6>
        <div className="settings-grid">
          <div className="field">
            <label>Provider</label>
            <select
              className="input"
              value={aiProvider}
              onChange={(e) => {
                setAiProvider(e.target.value);
                setAiModel("");
              }}
            >
              <option value="anthropic">anthropic</option>
              <option value="openai">openai</option>
              <option value="agent-sdk">agent-sdk</option>
            </select>
          </div>
          <div className="field">
            <label>Model</label>
            <input className="input" value={aiModel} onChange={(e) => setAiModel(e.target.value)} />
          </div>
          <div className="field" style={{ gridColumn: "1 / -1" }}>
            <label>API key {effective.ai.apiKeyConfigured ? "(configured — leave blank to keep it)" : ""}</label>
            <input className="input" type="password" value={aiApiKey} onChange={(e) => setAiApiKey(e.target.value)} />
          </div>
          <div className="field" style={{ gridColumn: "1 / -1" }}>
            <label>Base URL</label>
            <input className="input" value={aiBaseUrl} onChange={(e) => setAiBaseUrl(e.target.value)} />
          </div>
        </div>
      </section>
      <hr className="hr" />

      <section>
        <h6>Agent backend</h6>
        <div style={{ display: "flex", gap: 22, flexWrap: "wrap", alignItems: "flex-start" }}>
          <label className="radio">
            <input type="radio" name="runner" checked={agentRunner === "in-process"} onChange={() => setAgentRunner("in-process")} />
            <span className="dot" />
            <span>in-process — API key, parallel runs</span>
          </label>
          <label className="radio">
            <input type="radio" name="runner" checked={agentRunner === "agent-sdk"} onChange={() => setAgentRunner("agent-sdk")} />
            <span className="dot" />
            <span>agent-sdk — CLI subscription, 1 run</span>
          </label>
        </div>
        <div className="settings-grid" style={{ marginTop: 12 }}>
          <div className="field">
            <label>Model</label>
            <input className="input" value={agentModel} onChange={(e) => setAgentModel(e.target.value)} />
          </div>
          <div className="field">
            <label>Concurrency</label>
            <input className="input" type="number" min={1} value={agentConcurrency} onChange={(e) => setAgentConcurrency(Number(e.target.value))} />
          </div>
          <div className="field">
            <label>Max budget (USD)</label>
            <input className="input" value={agentMaxBudget} onChange={(e) => setAgentMaxBudget(e.target.value)} />
          </div>
        </div>
      </section>
      <hr className="hr" />

      <section>
        <h6>MCP servers</h6>
        <table className="table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Command</th>
              <th>Args</th>
              <th style={{ width: 90 }}></th>
            </tr>
          </thead>
          <tbody>
            {mcpRows.map((row, index) => (
              <tr key={index}>
                <td>
                  <input
                    className="input"
                    value={row.name}
                    onChange={(e) => setMcpRows(mcpRows.map((r, i) => (i === index ? { ...r, name: e.target.value } : r)))}
                  />
                </td>
                <td>
                  <input
                    className="input mono"
                    value={row.command}
                    onChange={(e) => setMcpRows(mcpRows.map((r, i) => (i === index ? { ...r, command: e.target.value } : r)))}
                  />
                </td>
                <td>
                  <input
                    className="input mono"
                    value={row.args}
                    onChange={(e) => setMcpRows(mcpRows.map((r, i) => (i === index ? { ...r, args: e.target.value } : r)))}
                  />
                </td>
                <td>
                  <button className="btn btn-ghost" style={{ fontSize: 12, padding: 0 }} onClick={() => setMcpRows(mcpRows.filter((_, i) => i !== index))}>
                    Remove
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <button className="btn btn-secondary" style={{ marginTop: 10 }} onClick={() => setMcpRows([...mcpRows, { name: "", command: "", args: "" }])}>
          Add server
        </button>
      </section>
      <hr className="hr" />

      <section>
        <h6>Ingestion</h6>
        <div className="settings-grid">
          <div className="field">
            <label>Sample folder</label>
            <input className="input mono" value={sampleDir} onChange={(e) => setSampleDir(e.target.value)} />
          </div>
          <div className="field">
            <label>Poll interval (ms)</label>
            <input className="input mono" type="number" min={1000} value={pollIntervalMs} onChange={(e) => setPollIntervalMs(Number(e.target.value))} />
          </div>
          <div className="field">
            <label>Extensions folder</label>
            <input className="input mono" value={extensionsDir} onChange={(e) => setExtensionsDir(e.target.value)} />
          </div>
          <div className="field">
            <label>Terminal launcher</label>
            <input className="input mono" value={terminalCommand} onChange={(e) => setTerminalCommand(e.target.value)} />
          </div>
        </div>
      </section>

      {error && <p className="error-text">{error}</p>}
      {saved && <p className="text-muted">Saved — restart the server for this to take effect.</p>}

      <button className="btn btn-primary" style={{ alignSelf: "flex-start", marginTop: 8 }} disabled={busy} onClick={() => void save()}>
        {busy ? "Saving…" : "Save"}
      </button>
    </div>
  );
}
