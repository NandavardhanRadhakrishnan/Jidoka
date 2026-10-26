import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import {
  api,
  ApiError,
  type ExtensionListItem,
  type GenerationDraft,
  type PollRecord,
  type SourceItemRow,
  type TestPollResult,
} from "./api";
import { Icon } from "./icons";
import {
  absTime,
  barTone,
  groupPreview,
  lastOkPoll,
  plural,
  pollCounts,
  pollSummary,
  previewSummary,
  relTime,
  rescanMessage,
  sinceLabel,
  splitKey,
  toneOf,
  unkeyedToShow,
} from "./pollStatus";

interface DeviceSession {
  id: string;
  userCode: string;
  verificationUri: string;
  deviceCode: string;
  deadline: number;
}

/** How often the list (and the relative times on it) refresh while the screen is open. */
const LIST_REFRESH_MS = 30_000;

function extensionIcon(name: string): string {
  const n = name.toLowerCase();
  if (n.includes("github")) return "github";
  if (n.includes("outlook") || n.includes("mail")) return "mail";
  if (n.includes("sample") || n.includes("folder")) return "folder";
  return "server";
}

type LoadState = "loading" | "ok" | "error";
type TestState = { result: TestPollResult } | { error: string } | null;
type Note = { error: boolean; text: string } | null;

const PREVIEW_LIMIT = 5;
const HISTORY_LIMIT = 50;

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function copyText(text: string): Promise<void> {
  const fallback = () => {
    const t = document.createElement("textarea");
    t.value = text;
    document.body.appendChild(t);
    t.select();
    try {
      document.execCommand("copy");
    } finally {
      t.remove();
    }
  };
  try {
    return navigator.clipboard.writeText(text).catch(fallback);
  } catch {
    fallback();
    return Promise.resolve();
  }
}

function KeyTrunc({ value }: { value: string }) {
  const [head, tail] = splitKey(value);
  return (
    <span className="key-trunc" title={value}>
      <span className="head">{head}</span>
      {tail && <span className="tail">{tail}</span>}
    </span>
  );
}

interface CardHandlers {
  onActivate: () => Promise<void>;
  onDisable: () => Promise<void>;
  onDisconnect: () => Promise<void>;
  onDelete: () => Promise<void>;
  onFix: (error: string) => Promise<void>;
}

/** One extension card. Holds the card's polling state (polls, failures, load states, busy
 *  flags, history, rescan note, test result) so it lives and dies with the card; the
 *  connect flow is rendered by `Extensions` and passed in as `connect`. */
function ExtensionPolling({
  ext,
  now,
  onListChanged,
  connect,
  handlers,
}: {
  ext: ExtensionListItem;
  now: number;
  onListChanged: () => Promise<void>;
  connect: ReactNode;
  handlers: CardHandlers;
}) {
  const connected = ext.status === "connected";
  const lastPollId = ext.lastPoll?.id ?? null;
  const hasFailed = ext.failedCount > 0;

  const [polls, setPolls] = useState<PollRecord[] | null>(null);
  const [pollsState, setPollsState] = useState<LoadState>("loading");
  const [failures, setFailures] = useState<SourceItemRow[] | null>(null);
  const [failState, setFailState] = useState<LoadState>("loading");
  const [failError, setFailError] = useState("");
  const [rowBusy, setRowBusy] = useState<Record<string, "retry" | "dismiss">>({});
  const [rowError, setRowError] = useState<Record<string, string>>({});
  const [copied, setCopied] = useState<string | null>(null);
  const [histOpen, setHistOpen] = useState(false);
  const [note, setNote] = useState<Note>(null);
  const [test, setTest] = useState<TestState>(null);
  const [testBusy, setTestBusy] = useState(false);
  const [testMore, setTestMore] = useState(false);
  const [rescanBusy, setRescanBusy] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const moreRef = useRef<HTMLDivElement | null>(null);
  const moreButton = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);

  const loadPolls = useCallback(async () => {
    setPollsState((s) => (s === "ok" ? s : "loading"));
    try {
      setPolls(await api.polls(ext.id));
      setPollsState("ok");
    } catch {
      setPollsState("error");
    }
  }, [ext.id]);

  const loadFailures = useCallback(async () => {
    setFailState((s) => (s === "ok" ? s : "loading"));
    try {
      setFailures(await api.failures(ext.id));
      setFailState("ok");
    } catch (e) {
      setFailError(messageOf(e));
      setFailState("error");
    }
  }, [ext.id]);

  // Fetch on mount (not on expand) and again whenever a new regular poll lands.
  // Nothing is requested for a card that isn't connected: those routes answer 400.
  useEffect(() => {
    if (!connected) return;
    void loadPolls();
  }, [connected, lastPollId, loadPolls]);

  useEffect(() => {
    if (!connected) return;
    if (hasFailed) void loadFailures();
    else {
      setFailures([]);
      setFailState("ok");
    }
  }, [connected, lastPollId, hasFailed, loadFailures]);

  // Disconnect drops the card's polling state.
  useEffect(() => {
    if (connected) return;
    setPolls(null);
    setPollsState("loading");
    setFailures(null);
    setFailState("loading");
    setRowBusy({});
    setRowError({});
    setHistOpen(false);
    setNote(null);
    setTest(null);
    setTestMore(false);
  }, [connected]);

  useEffect(() => () => {
    if (copyTimer.current) clearTimeout(copyTimer.current);
  }, []);

  // The ⋯ menu: focus the first item on open; close on outside click.
  useEffect(() => {
    if (!menuOpen) return;
    menuRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')?.focus();
    const onDown = (ev: MouseEvent) => {
      if (moreRef.current && !moreRef.current.contains(ev.target as Node)) setMenuOpen(false);
    };
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key !== "Escape") return;
      setMenuOpen(false);
      moreButton.current?.focus();
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [menuOpen]);

  function closeMenu() {
    setMenuOpen(false);
    moreButton.current?.focus();
  }

  function onMenuKey(ev: React.KeyboardEvent<HTMLDivElement>) {
    if (ev.key !== "ArrowDown" && ev.key !== "ArrowUp" && ev.key !== "Home" && ev.key !== "End") return;
    ev.preventDefault();
    const items = Array.from(
      menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)') ?? [],
    );
    if (items.length === 0) return;
    const at = items.indexOf(document.activeElement as HTMLButtonElement);
    const next =
      ev.key === "Home"
        ? 0
        : ev.key === "End"
          ? items.length - 1
          : ev.key === "ArrowDown"
            ? (at + 1) % items.length
            : (at - 1 + items.length) % items.length;
    items[next]?.focus();
  }

  function dropRow(key: string) {
    setFailures((list) => (list ? list.filter((f) => f.key !== key) : list));
  }

  function setBusy(key: string, kind: "retry" | "dismiss" | null) {
    setRowBusy((b) => {
      const next = { ...b };
      if (kind) next[key] = kind;
      else delete next[key];
      return next;
    });
  }

  function setErrorFor(key: string, message: string | null) {
    setRowError((r) => {
      const next = { ...r };
      if (message) next[key] = message;
      else delete next[key];
      return next;
    });
  }

  async function retry(key: string) {
    setNote(null);
    setErrorFor(key, null);
    setBusy(key, "retry");
    try {
      const poll = await api.retryFailure(ext.id, key);
      // The server's failures list is the truth: still failing keeps the row with its fresh
      // error and lastSeenAt; recovered drops it.
      try {
        setFailures(await api.failures(ext.id));
        setFailState("ok");
      } catch {
        if (poll.failed === 0 && poll.outcome === "ok") dropRow(key);
      }
      if (poll.outcome === "error") setErrorFor(key, poll.error ?? "retry failed");
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) dropRow(key);
      else setErrorFor(key, messageOf(e));
    } finally {
      setBusy(key, null);
      void loadPolls();
      void onListChanged();
    }
  }

  async function dismiss(key: string) {
    setNote(null);
    setErrorFor(key, null);
    setBusy(key, "dismiss");
    try {
      await api.dismissFailure(ext.id, key);
      dropRow(key);
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) dropRow(key);
      else setErrorFor(key, messageOf(e));
    } finally {
      setBusy(key, null);
      void onListChanged();
    }
  }

  async function copyKey(key: string) {
    await copyText(key);
    setCopied(key);
    if (copyTimer.current) clearTimeout(copyTimer.current);
    copyTimer.current = setTimeout(() => setCopied(null), 1500);
  }

  async function rescanSource() {
    setNote(null);
    setRescanBusy(true);
    try {
      const { recovered, poll } = await api.rescanSource(ext.id);
      setNote(
        poll.outcome === "error"
          ? { error: true, text: `Rescan failed: ${poll.error ?? "unknown error"}` }
          : { error: false, text: rescanMessage(recovered) },
      );
    } catch (e) {
      setNote({ error: true, text: `Rescan failed: ${messageOf(e)}` });
    } finally {
      setRescanBusy(false);
      void loadPolls();
      void loadFailures();
      void onListChanged();
    }
  }

  async function runTest() {
    setMenuOpen(false);
    setNote(null);
    setTest(null);
    setTestMore(false);
    setTestBusy(true);
    try {
      setTest({ result: await api.testPoll(ext.id) });
    } catch (e) {
      setTest({ error: messageOf(e) });
    } finally {
      setTestBusy(false);
    }
  }

  function withNoteCleared(fn: () => Promise<void>) {
    return () => {
      setMenuOpen(false);
      setNote(null);
      void fn();
    };
  }

  const historyLoaded = pollsState === "ok" ? polls : null;
  const unkeyed = connected ? unkeyedToShow(ext.lastPoll, historyLoaded) : [];
  const unkeyedFrom = lastOkPoll(ext.lastPoll, historyLoaded);
  const tone = barTone(ext, unkeyed.length > 0);
  const status = pollSummary(ext.lastPoll, now);
  const statusError = ext.lastPoll?.outcome === "error";

  const failLoad: LoadState = hasFailed ? failState : "ok";
  const keyed = failLoad === "ok" ? (failures ?? []) : [];
  const rowCount = keyed.length + unkeyed.length;
  const showFailures = connected && (hasFailed || unkeyed.length > 0) && !(failLoad === "ok" && rowCount === 0);

  const showHistory = connected && (pollsState !== "ok" || (polls?.length ?? 0) > 0);
  const historyOpen = histOpen && pollsState === "ok";
  const historyId = `poll-history-${ext.id}`;
  const historyCount =
    pollsState === "loading" ? "loading…" : pollsState === "error" ? "couldn't load" : plural(polls?.length ?? 0, "poll");

  const preview = test && "result" in test ? test.result : null;
  const testError = test && "error" in test ? test.error : null;
  const grouped = preview ? groupPreview(preview.items, testMore ? Infinity : PREVIEW_LIMIT) : null;

  const canDisconnect = connected || ext.status === "needs_reauth";

  return (
    <div className="ext-row">
      <div className={`tone-bar ${tone}`} />
      <div className="body">
        <div className="head">
          <Icon name={extensionIcon(ext.name)} />
          <span className="name">{ext.name}</span>
          <span className={`mono status ${toneOf(ext)}`}>{ext.status.replace(/_/g, " ")}</span>
        </div>
        <span className="desc">{ext.summary}</span>

        <span
          className={`poll-status${statusError ? " is-error" : ""}${historyOpen ? " wrap" : ""}`}
          title={status}
          aria-label={`Polling status: ${status}`}
        >
          {status}
        </span>

        {note && (
          <span role="status" className={note.error ? "error-text" : "poll-note"}>
            {note.text}
          </span>
        )}

        {!ext.valid && <p className="error-text">{ext.error}</p>}

        {connect}

        {connected && testError && (
          <>
            <p className="error-text">✗ {testError}</p>
            <button className="btn btn-ghost ext-fix" onClick={() => void handlers.onFix(testError)}>
              Fix
            </button>
          </>
        )}

        <span className="mono meta">{ext.readOnly ? "read-only" : "can write"}</span>

        {showFailures && (
          <section className="poll-section" aria-label="Failures">
            <div className="drawer-section-head">
              <h6>Failures</h6>
              <span className="mono count">{failLoad === "ok" ? rowCount : ""}</span>
            </div>
            <div className="out-list">
              {failLoad === "loading" && (
                <span className="poll-loading" role="status">
                  Loading failures…
                </span>
              )}
              {failLoad === "error" && (
                <div className="poll-load-error">
                  <span className="error-text">Couldn't load failures: {failError}</span>
                  <button className="btn btn-ghost btn-quiet btn-sm" onClick={() => void loadFailures()}>
                    Try again
                  </button>
                </div>
              )}
              {keyed.map((f) => {
                const busy = rowBusy[f.key];
                const isCopied = copied === f.key;
                return (
                  <div key={f.key} className="failure-row" aria-busy={busy ? "true" : "false"}>
                    <div className="line">
                      <div className="key-cell">
                        <KeyTrunc value={f.key} />
                        <button
                          className="icon-btn"
                          aria-label={isCopied ? "Key copied" : `Copy key ${f.key}`}
                          onClick={() => void copyKey(f.key)}
                        >
                          {isCopied ? (
                            <>
                              <Icon name="check" size={13} />
                              <span>Copied</span>
                            </>
                          ) : (
                            <Icon name="copy" size={13} />
                          )}
                        </button>
                      </div>
                      <span className="when" title={absTime(f.lastSeenAt)}>
                        {busy === "retry" ? "retrying…" : relTime(f.lastSeenAt, now)}
                      </span>
                      <div className="row-actions">
                        <button className="btn btn-secondary btn-sm" disabled={!!busy} onClick={() => void retry(f.key)}>
                          {busy === "retry" ? "Retrying…" : "Retry"}
                        </button>
                        <button
                          className="btn btn-ghost btn-quiet btn-sm"
                          disabled={!!busy}
                          onClick={() => void dismiss(f.key)}
                        >
                          {busy === "dismiss" ? "Dismissing…" : "Dismiss"}
                        </button>
                      </div>
                    </div>
                    <span className="error-text">{rowError[f.key] ?? f.error ?? "unknown error"}</span>
                  </div>
                );
              })}
              {failLoad === "ok" &&
                unkeyed.map((u, i) => (
                  <div key={`unkeyed-${i}`} className="failure-row">
                    <div className="line">
                      <div className="key-cell">
                        <span className="no-key">no key</span>
                      </div>
                      <span
                        className="when"
                        title={unkeyedFrom?.finishedAt ? absTime(unkeyedFrom.finishedAt) : undefined}
                      >
                        from the last poll
                      </span>
                    </div>
                    <span className="error-text">{u.error}</span>
                  </div>
                ))}
            </div>
          </section>
        )}

        {connected && preview && grouped && (
          <section className="test-preview" aria-label="Test poll preview">
            <div className="test-preview-head">
              <h6>Test poll</h6>
              <span className="summary">{previewSummary(preview)}</span>
              <span className="note">Preview only. Nothing was written.</span>
              <button className="icon-btn" aria-label="Clear test preview" onClick={() => setTest(null)}>
                <Icon name="x" size={14} />
              </button>
            </div>
            {preview.items.length > 0 && (
              <div className="test-group">
                <span className="test-group-label">
                  Items<span className="sub">becomes {plural(grouped.tasks, "task")}</span>
                </span>
                {grouped.groups.map((g) => (
                  <div key={g.label} className="test-task">
                    <div className="test-task-head">
                      <span className="task-badge">{g.label}</span>
                      <span className="label">{plural(g.count, "item")}</span>
                      {g.threadKey ? (
                        <>
                          <span className="label">thread</span>
                          <KeyTrunc value={g.threadKey} />
                        </>
                      ) : (
                        <span className="label">no thread · its own task</span>
                      )}
                    </div>
                    <div className="test-task-items">
                      {g.items.map(({ item, first }) => (
                        <div key={item.key} className="test-item">
                          <div className="title-line">
                            <span className={`title${first ? "" : " is-follow"}`}>{item.title}</span>
                            <span className="role">{first ? "creates task" : "adds to task"}</span>
                          </div>
                          <div className="test-kv">
                            <span className="k">key</span>
                            <KeyTrunc value={item.key} />
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
                {grouped.hidden > 0 && (
                  <button className="btn btn-ghost btn-quiet btn-sm" onClick={() => setTestMore(true)}>
                    +{grouped.hidden} more
                  </button>
                )}
              </div>
            )}
            {(
              [
                ["Failures · from the extension's list()", preview.failures],
                ["Check failures · Jidoka's item checks", preview.checkFailures],
              ] as const
            )
              .filter(([, rows]) => rows.length > 0)
              .map(([label, rows]) => (
                <div key={label} className="test-group">
                  <span className="test-group-label">{label}</span>
                  {rows.map((r, i) => (
                    <div key={`${r.key ?? ""}-${i}`} className="test-fail-row">
                      {r.key ? <KeyTrunc value={r.key} /> : <span className="no-key">no key</span>}
                      <span className="error-text">{r.error}</span>
                    </div>
                  ))}
                </div>
              ))}
          </section>
        )}

        {showHistory && (
          <div className="poll-history">
            <div className="poll-history-head">
              <button
                className="poll-toggle"
                disabled={pollsState !== "ok"}
                aria-expanded={historyOpen}
                aria-controls={historyId}
                onClick={() => setHistOpen((v) => !v)}
              >
                <Icon name={historyOpen ? "chevron-down" : "chevron-right"} size={14} />
                <span>History</span>
                <span className="count">· {historyCount}</span>
              </button>
              {pollsState === "error" && (
                <button className="btn btn-ghost btn-quiet btn-sm" onClick={() => void loadPolls()}>
                  Try again
                </button>
              )}
            </div>
            {historyOpen && (
              <div className="out-list" id={historyId}>
                {(polls ?? []).slice(0, HISTORY_LIMIT).map((p) => {
                  const running = !p.finishedAt;
                  const failed = !running && p.outcome === "error";
                  return (
                    <div key={p.id} className="poll-row">
                      <span className="kind-cell">
                        <span className={`poll-kind kind-${p.kind}`}>{p.kind}</span>
                      </span>
                      <span className="when" title={absTime(p.startedAt)}>
                        {relTime(p.startedAt, now)}
                      </span>
                      <span className="since" title={p.since ? absTime(p.since) : undefined}>
                        {sinceLabel(p)}
                      </span>
                      <span className="counts">{pollCounts(p)}</span>
                      <span className={`outcome${failed ? " is-error" : running ? " is-running" : ""}`}>
                        {running ? "running" : failed ? "error" : "ok"}
                      </span>
                      {failed && <span className="error-text">{p.error ?? "unknown error"}</span>}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}
      </div>

      <div className="actions">
        {connected && (
          <button
            className="btn btn-secondary btn-sm"
            disabled={rescanBusy}
            aria-busy={rescanBusy}
            onClick={() => void rescanSource()}
          >
            {rescanBusy ? "Rescanning…" : "Rescan source"}
          </button>
        )}
        {connected && !ext.enabled && (
          <button className="btn btn-primary btn-sm" onClick={withNoteCleared(handlers.onActivate)}>
            Activate
          </button>
        )}
        {ext.enabled && (
          <button className="btn btn-secondary btn-sm" onClick={withNoteCleared(handlers.onDisable)}>
            Disable
          </button>
        )}
        <div className="ext-more" ref={moreRef}>
          <button
            ref={moreButton}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            aria-label={`More actions for ${ext.name}`}
            onClick={() => setMenuOpen((v) => !v)}
          >
            <Icon name="ellipsis" size={17} />
          </button>
          {menuOpen && (
            <div className="ext-menu" role="menu" aria-label={`More actions for ${ext.name}`} ref={menuRef} onKeyDown={onMenuKey}>
              {connected && (
                <button role="menuitem" disabled={testBusy} aria-busy={testBusy} onClick={() => void runTest()}>
                  {testBusy ? "Testing…" : "Test"}
                </button>
              )}
              {canDisconnect && (
                <button
                  role="menuitem"
                  onClick={() => {
                    moreButton.current?.focus();
                    withNoteCleared(handlers.onDisconnect)();
                  }}
                >
                  Disconnect
                </button>
              )}
              {(connected || canDisconnect) && <div role="separator" />}
              <button
                role="menuitem"
                className="danger"
                onClick={() => {
                  closeMenu();
                  void handlers.onDelete();
                }}
              >
                Delete
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export function Extensions({ onFailedTotalChange }: { onFailedTotalChange?: (total: number) => void }) {
  const [extensions, setExtensions] = useState<ExtensionListItem[]>([]);
  const [connectingId, setConnectingId] = useState<string | null>(null);
  const [apiKeyValue, setApiKeyValue] = useState("");
  const [device, setDevice] = useState<DeviceSession | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState<GenerationDraft | null>(null);
  const [description, setDescription] = useState("");
  const [generating, setGenerating] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const pollTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  /** Re-fetches the list only, so a connect in progress on another card isn't cancelled. */
  const reloadList = useCallback(async () => {
    const list = await api.extensions();
    setExtensions(list);
    setNow(Date.now());
    onFailedTotalChange?.(list.reduce((sum, e) => sum + e.failedCount, 0));
  }, [onFailedTotalChange]);

  const refresh = useCallback(async () => {
    setConnectingId(null);
    setDevice(null);
    setApiKeyValue("");
    try {
      await reloadList();
    } catch {
      setExtensions([]);
    }
  }, [reloadList]);

  const reloadQuietly = useCallback(async () => {
    try {
      await reloadList();
    } catch {
      // keep the list we have; the next reload will try again
    }
  }, [reloadList]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    const timer = setInterval(() => void reloadQuietly(), LIST_REFRESH_MS);
    return () => clearInterval(timer);
  }, [reloadQuietly]);

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

  async function fix(id: string, testError: string) {
    setError(null);
    if (draft) {
      try {
        await api.discardGeneration(draft.generationId);
      } catch {
        // best-effort cleanup of the draft being replaced
      }
    }
    try {
      const draftResult = await api.fixExtension(id, testError);
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

  function connectFlow(ext: ExtensionListItem): ReactNode {
    return (
      <>
        {ext.valid && (ext.status === "not_connected" || ext.status === "needs_reauth") && connectingId !== ext.id && (
          <button className="btn btn-primary btn-sm" onClick={() => setConnectingId(ext.id)}>
            {ext.status === "needs_reauth" ? "Reconnect" : "Connect"}
          </button>
        )}

        {connectingId === ext.id && ext.auth && ext.auth.mode === "api-key" && (
          <div className="ext-connect-form">
            <div className="field">
              <label>{ext.auth.label}</label>
              <input className="input" type="password" value={apiKeyValue} onChange={(e) => setApiKeyValue(e.target.value)} />
            </div>
            <button className="btn btn-primary" onClick={() => saveApiKey(ext.id)}>
              Save
            </button>
          </div>
        )}

        {connectingId === ext.id && ext.auth && ext.auth.mode === "oauth2-auth-code-pkce" && (
          <a className="btn btn-primary" href={`/api/extensions/${ext.id}/connect/pkce/start`}>
            Continue in browser
          </a>
        )}

        {connectingId === ext.id && ext.auth && ext.auth.mode === "oauth2-device-code" && !device && (
          <button className="btn btn-primary" onClick={() => startDevice(ext.id)}>
            Connect
          </button>
        )}

        {device?.id === ext.id && (
          <p className="mono ext-device-code">
            Go to{" "}
            <a href={device.verificationUri} target="_blank" rel="noreferrer">
              {device.verificationUri}
            </a>{" "}
            and enter code <strong>{device.userCode}</strong>
          </p>
        )}
      </>
    );
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
          <ExtensionPolling
            key={ext.id}
            ext={ext}
            now={now}
            onListChanged={reloadQuietly}
            connect={connectFlow(ext)}
            handlers={{
              onActivate: () => activate(ext.id),
              onDisable: () => disable(ext.id),
              onDisconnect: () => disconnect(ext.id),
              onDelete: () => deleteExtension(ext.id),
              onFix: (testError) => fix(ext.id, testError),
            }}
          />
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
            <div className="ext-row ext-draft">
              <div className="tone-bar tone-warn" />
              <div className="body">
                <span className="name">{draft.manifest.name}</span>
                <span className="desc">{draft.manifest.summary}</span>
                <span className="mono meta">
                  {draft.manifest.readOnly ? "Read-only" : "Can write"} · {draft.manifest.auth.mode}
                </span>
              </div>
              <div className="actions">
                <button className="btn btn-primary btn-sm" onClick={approveDraft}>
                  Approve
                </button>
                <button className="btn btn-secondary btn-sm" onClick={discardDraft}>
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
