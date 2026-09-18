import { useCallback, useEffect, useState } from "react";
import { api, type AuthProviderStatus } from "./api";

/**
 * Sign-in status per configured provider. "Sign in" is a plain link, not a fetch:
 * the server answers with a redirect to the provider's own login page, and the
 * provider redirects back to the board when it is done.
 */
export function SignIn() {
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

  if (!providers.length) return null;

  return (
    <div className="signin">
      {providers.map((provider) => (
        <span key={provider.id} className="provider">
          <span className={provider.connected && !provider.expired ? "dot on" : "dot off"} />
          {provider.id}
          {provider.connected ? (
            <button
              className="link"
              onClick={async () => {
                await api.signOut(provider.id);
                await refresh();
              }}
            >
              sign out
            </button>
          ) : (
            <a className="link" href={`/api/auth/${provider.id}/start`}>
              sign in
            </a>
          )}
        </span>
      ))}
    </div>
  );
}
