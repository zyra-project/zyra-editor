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
      const resp = await fetch("/v1/ready", { signal: AbortSignal.timeout(8000) });
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
      const server = Boolean(data.server);
      const zyra_cli = Boolean(data.zyra_cli);
      const llm_configured = Boolean(data.llm_configured);
      const allGood = server && zyra_cli && llm_configured;
      setState({
        status: allGood ? "ready" : "degraded",
        server,
        zyra_cli,
        llm_configured,
        zyra_version: data.zyra_version ?? undefined,
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
