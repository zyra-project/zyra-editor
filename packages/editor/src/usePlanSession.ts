import { useState, useRef, useCallback, useEffect } from "react";
import type { PlanResponse } from "./planToGraph";

export interface ChatEntry {
  role: "assistant" | "user" | "status";
  text: string;
  timestamp: number;
}

/** Structured clarification question from the server. */
export interface ClarificationItem {
  index: number;
  total: number;
  agent_id: string;
  arg_key: string;
  kind: "missing" | "confirm" | "unknown";
  label: string;
  description: string;
  arg_type: "string" | "number" | "boolean" | "filepath" | "enum";
  placeholder: string;
  default?: string | number | boolean | null;
  options?: string[] | null;
  current_value?: string | null;
  importance: string; // "required" | "recommended" | ""
}

export type PlanPhase = "idle" | "asking" | "clarifying" | "thinking" | "done" | "error";

export interface PlanSession {
  chat: ChatEntry[];
  plan: PlanResponse | null;
  phase: PlanPhase;
  error: string | null;
  /** Current clarification question (when phase === "clarifying"). */
  clarification: ClarificationItem | null;
  start: (intent: string, guardrails?: string) => void;
  answer: (text: string) => void;
  cancel: () => void;
  reset: () => void;
}

function connectPlanWs(): WebSocket {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  return new WebSocket(`${proto}//${location.host}/ws/plan`);
}

export function usePlanSession(): PlanSession {
  const [chat, setChat] = useState<ChatEntry[]>([]);
  const [plan, setPlan] = useState<PlanResponse | null>(null);
  const [phase, setPhase] = useState<PlanPhase>("idle");
  const [error, setError] = useState<string | null>(null);
  const [clarification, setClarification] = useState<ClarificationItem | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const phaseRef = useRef<PlanPhase>(phase);
  phaseRef.current = phase;

  const appendChat = useCallback((role: ChatEntry["role"], text: string) => {
    setChat((prev) => [...prev, { role, text, timestamp: Date.now() }]);
  }, []);

  const cleanup = useCallback(() => {
    if (wsRef.current) {
      try { wsRef.current.close(); } catch { /* ignore */ }
      wsRef.current = null;
    }
  }, []);

  // Close WebSocket on unmount to prevent leaked connections
  useEffect(() => cleanup, [cleanup]);

  const start = useCallback((intent: string, guardrails?: string) => {
    cleanup();
    setChat([]);
    setPlan(null);
    setError(null);
    setClarification(null);
    setPhase("thinking");

    const ws = connectPlanWs();
    wsRef.current = ws;

    ws.onopen = () => {
      ws.send(JSON.stringify({ type: "start", intent, guardrails: guardrails ?? "" }));
      appendChat("status", "Planning started...");
    };

    ws.onmessage = (ev) => {
      if (wsRef.current !== ws) return; // stale socket
      try {
        const msg = JSON.parse(ev.data);
        if (msg.keepalive) return;

        switch (msg.type) {
          case "question":
            setPhase("asking");
            appendChat("assistant", msg.text);
            break;
          case "clarification":
            setClarification(msg as ClarificationItem);
            setPhase("clarifying");
            break;
          case "plan":
            setClarification(null);
            setPlan(msg.data as PlanResponse);
            setPhase("done");
            appendChat("status", "Plan generated.");
            break;
          case "status":
            appendChat("status", msg.text);
            break;
          case "log":
            // Only show substantive log lines in chat
            if (msg.text && !msg.text.startsWith("listening")) {
              appendChat("status", msg.text);
            }
            break;
          case "error":
            setError(msg.text);
            setPhase("error");
            break;
        }
      } catch {
        // ignore malformed messages
      }
    };

    ws.onerror = () => {
      if (wsRef.current !== ws) return; // stale socket
      setError("WebSocket connection failed");
      setPhase("error");
      wsRef.current = null;
    };

    ws.onclose = () => {
      if (wsRef.current !== ws) return; // stale socket
      // If the socket closes while still in a non-terminal phase,
      // treat it as an error so the UI doesn't remain stuck.
      const p = phaseRef.current;
      if (p !== "done" && p !== "idle" && p !== "error") {
        setError("WebSocket connection closed unexpectedly");
        setPhase("error");
      }
      wsRef.current = null;
    };
  }, [cleanup, appendChat]);

  const answer = useCallback((text: string) => {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;
    wsRef.current.send(JSON.stringify({ type: "answer", text }));
    // If we were clarifying, log the answer with context
    if (clarification) {
      appendChat("user", `${clarification.label}: ${text}`);
    } else {
      appendChat("user", text);
    }
    setClarification(null);
    setPhase("thinking");
  }, [appendChat, clarification]);

  const cancel = useCallback(() => {
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: "cancel" }));
    }
    cleanup();
    setClarification(null);
    setPhase("idle");
    appendChat("status", "Cancelled.");
  }, [cleanup, appendChat]);

  const reset = useCallback(() => {
    cleanup();
    setChat([]);
    setPlan(null);
    setClarification(null);
    setPhase("idle");
    setError(null);
  }, [cleanup]);

  return { chat, plan, phase, error, clarification, start, answer, cancel, reset };
}
