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
  const [open, setOpen] = useState(false);
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
  }

  useEffect(() => {
    if (open) void load();
  }, [open]);

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

  return (
    <>
      <button className="link" onClick={() => setOpen(true)}>
        Settings
      </button>

      {open && (
        <div className="dialog extensions">
          <h2>Settings</h2>

          {!effective ? (
            <p className="meta">Loading…</p>
          ) : (
            <>
              <h3>AI provider</h3>
              <label>
                Provider
                <select value={aiProvider} onChange={(e) => setAiProvider(e.target.value)}>
                  <option value="anthropic">anthropic</option>
                  <option value="openai">openai</option>
                  <option value="agent-sdk">agent-sdk</option>
                </select>
              </label>
              <label>
                API key {effective.ai.apiKeyConfigured ? "(configured — leave blank to keep it)" : ""}
                <input type="password" value={aiApiKey} onChange={(e) => setAiApiKey(e.target.value)} />
              </label>
              <label>
                Model
                <input value={aiModel} onChange={(e) => setAiModel(e.target.value)} />
              </label>
              <label>
                Base URL
                <input value={aiBaseUrl} onChange={(e) => setAiBaseUrl(e.target.value)} />
              </label>

              <h3>Agent runner</h3>
              <label>
                Runner
                <select value={agentRunner} onChange={(e) => setAgentRunner(e.target.value)}>
                  <option value="in-process">in-process</option>
                  <option value="agent-sdk">agent-sdk</option>
                </select>
              </label>
              <label>
                Model
                <input value={agentModel} onChange={(e) => setAgentModel(e.target.value)} />
              </label>
              <label>
                Concurrency
                <input
                  type="number"
                  min={1}
                  value={agentConcurrency}
                  onChange={(e) => setAgentConcurrency(Number(e.target.value))}
                />
              </label>
              <label>
                Max budget (USD)
                <input value={agentMaxBudget} onChange={(e) => setAgentMaxBudget(e.target.value)} />
              </label>

              <h3>MCP servers</h3>
              {mcpRows.map((row, index) => (
                <div key={index} className="extension-row">
                  <label>
                    Name
                    <input
                      value={row.name}
                      onChange={(e) =>
                        setMcpRows(mcpRows.map((r, i) => (i === index ? { ...r, name: e.target.value } : r)))
                      }
                    />
                  </label>
                  <label>
                    Command
                    <input
                      value={row.command}
                      onChange={(e) =>
                        setMcpRows(mcpRows.map((r, i) => (i === index ? { ...r, command: e.target.value } : r)))
                      }
                    />
                  </label>
                  <label>
                    Args (space-separated)
                    <input
                      value={row.args}
                      onChange={(e) =>
                        setMcpRows(mcpRows.map((r, i) => (i === index ? { ...r, args: e.target.value } : r)))
                      }
                    />
                  </label>
                  <button className="link" onClick={() => setMcpRows(mcpRows.filter((_, i) => i !== index))}>
                    Remove
                  </button>
                </div>
              ))}
              <button className="link" onClick={() => setMcpRows([...mcpRows, { name: "", command: "", args: "" }])}>
                Add server
              </button>

              <h3>Sources</h3>
              <label>
                Sample folder
                <input value={sampleDir} onChange={(e) => setSampleDir(e.target.value)} />
              </label>
              <label>
                Extensions folder
                <input value={extensionsDir} onChange={(e) => setExtensionsDir(e.target.value)} />
              </label>
              <label>
                Poll interval (ms)
                <input
                  type="number"
                  min={1000}
                  value={pollIntervalMs}
                  onChange={(e) => setPollIntervalMs(Number(e.target.value))}
                />
              </label>

              <h3>Handoff</h3>
              <label>
                Terminal launcher
                <input value={terminalCommand} onChange={(e) => setTerminalCommand(e.target.value)} />
              </label>

              {error && <p className="error">{error}</p>}
              {saved && <p className="meta">Saved — restart the server for this to take effect.</p>}

              <button disabled={busy} onClick={() => void save()}>
                {busy ? "Saving…" : "Save"}
              </button>
            </>
          )}

          <button className="secondary" onClick={() => setOpen(false)}>
            Close
          </button>
        </div>
      )}
    </>
  );
}
