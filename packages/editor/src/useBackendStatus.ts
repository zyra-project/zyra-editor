import { useState, useEffect, useCallback, useRef } from "react";

export interface BackendStatus {
  status: "checking" | "ready" | "degraded" | "offline";
  server: boolean;
  zyra_cli: boolean;
  llm_configured: boolean;
  zyra_version?: string;
  llm_provider?: string;
  llm_model?: string;
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

/**
 * Polls the zyra library's `/ready` endpoint.
 *
 * Example response:
 * ```json
 * {
 *   "status": "ok",
 *   "version": "0.1.45",
 *   "checks": {
 *     "llm": { "provider": "openai", "model": "gpt-4o-mini" },
 *     ...
 *   }
 * }
 * ```
 */
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
      const checks = data.checks ?? {};

      const server = data.status === "ok";
      const zyra_cli = Boolean(data.version);
      const zyra_version: string | undefined = data.version ?? undefined;

      // LLM is configured if checks.llm exists with a provider
      const llmCheck = checks.llm ?? {};
      const llm_configured = Boolean(llmCheck.provider);
      const llm_provider: string | undefined = llmCheck.provider ?? undefined;
      const llm_model: string | undefined = llmCheck.model ?? undefined;

      const allGood = server && zyra_cli && llm_configured;
      setState({
        status: allGood ? "ready" : "degraded",
        server,
        zyra_cli,
        llm_configured,
        zyra_version,
        llm_provider,
        llm_model,
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
