import { useCallback, useEffect, useState } from "react";
import { api, type AuthProviderStatus } from "./api";

/**
 * Connect-an-account dialog. "Sign in" is a plain link, not a fetch: the server
 * answers with a redirect to the provider's own login page, and the provider
 * redirects back to the board when it is done.
 */
export function SignIn({ onClose }: { onClose: () => void }) {
  const [providers, setProviders] = useState<AuthProviderStatus[]>([]);

  const refresh = useCallback(async () => {
    try {
      setProviders(await api.auth());
    } catch {
      setProviders([]);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return (
    <div className="dialog-backdrop">
      <div className="dialog" style={{ width: "min(460px, 100%)" }}>
        <span className="dialog-title">Connect an account</span>
        <p className="dialog-body">Authorization code + PKCE. Tokens stay in this machine's database and refresh themselves.</p>
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {providers.length === 0 && <p className="text-muted">No providers configured.</p>}
          {providers.map((provider) => (
            <div key={provider.id} style={{ display: "flex", alignItems: "center", gap: 10, border: "1px solid var(--color-divider)", padding: "10px 12px", background: "var(--color-bg)" }}>
              <span style={{ display: "flex", flexDirection: "column", gap: 2, flex: 1, minWidth: 0 }}>
                <span style={{ fontFamily: "var(--font-heading)", fontWeight: 800, fontSize: 14 }}>{provider.id}</span>
                <span className="mono" style={{ fontSize: 10.5, color: provider.connected && !provider.expired ? "var(--color-neutral-700)" : "var(--color-accent)" }}>
                  {provider.connected ? (provider.expired ? "expired" : "connected") : "not connected"}
                </span>
              </span>
              {provider.connected ? (
                <button
                  className="btn btn-secondary"
                  style={{ padding: "5px 11px", fontSize: 12 }}
                  onClick={async () => {
                    await api.signOut(provider.id);
                    await refresh();
                  }}
                >
                  Sign out
                </button>
              ) : (
                <a className="btn btn-primary" style={{ padding: "5px 11px", fontSize: 12 }} href={`/api/auth/${provider.id}/start`}>
                  Sign in
                </a>
              )}
            </div>
          ))}
        </div>
        <div className="dialog-actions">
          <button className="btn btn-secondary" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
