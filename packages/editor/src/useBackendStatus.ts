import { useState, useEffect, useCallback, useRef } from "react";

export interface BackendStatus {
  status: "checking" | "ready" | "degraded" | "offline";
  server: boolean;
  zyra_cli: boolean;
  llm_configured: boolean;
  zyra_version?: string;
  lastChecked: number;
}

const POLL_INTERVAL = 30_000;

const INITIAL: BackendStatus = {
  status: "checking",
  server: false,
  zyra_cli: false,
  llm_configured: false,
  lastChecked: 0,
};

export function useBackendStatus(): BackendStatus & { refresh: () => void } {
  const [state, setState] = useState<BackendStatus>(INITIAL);
  const timerRef = useRef<ReturnType<typeof setInterval>>();

  const check = useCallback(async () => {
    try {
      const resp = await fetch("/ready", { signal: AbortSignal.timeout(8000) });
      if (!resp.ok) {
        setState({
          status: "offline",
          server: false,
          zyra_cli: false,
          llm_configured: false,
          lastChecked: Date.now(),
        });
        return;
      }
      const data = await resp.json();

      // The /ready endpoint is provided by the zyra library.
      // Adapt to its response shape — look for common field names.
      const server = true; // If we got a 200, the server is up
      const zyra_cli = Boolean(
        data.zyra_cli ?? data.cli ?? data.zyra ?? true,
      );
      const llm_configured = Boolean(
        data.llm_configured ?? data.llm ?? data.planner ?? false,
      );
      // Version may be top-level or nested
      const zyra_version: string | undefined =
        data.zyra_version ?? data.version ?? data.cli_version ?? undefined;

      const allGood = server && zyra_cli && llm_configured;
      setState({
        status: allGood ? "ready" : "degraded",
        server,
        zyra_cli,
        llm_configured,
        zyra_version,
        lastChecked: Date.now(),
      });
    } catch {
      setState({
        status: "offline",
        server: false,
        zyra_cli: false,
        llm_configured: false,
        lastChecked: Date.now(),
      });
    }
  }, []);

  useEffect(() => {
    check();
    timerRef.current = setInterval(check, POLL_INTERVAL);
    return () => clearInterval(timerRef.current);
  }, [check]);

  return { ...state, refresh: check };
}
