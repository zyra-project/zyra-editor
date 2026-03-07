import { useState, useRef, useCallback } from "react";
import type { PlanResponse } from "./planToGraph";

export interface ChatEntry {
  role: "assistant" | "user" | "status";
  text: string;
  timestamp: number;
}

export type PlanPhase = "idle" | "asking" | "thinking" | "done" | "error";

export interface PlanSession {
  chat: ChatEntry[];
  plan: PlanResponse | null;
  phase: PlanPhase;
  error: string | null;
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
  const wsRef = useRef<WebSocket | null>(null);

  const appendChat = useCallback((role: ChatEntry["role"], text: string) => {
    setChat((prev) => [...prev, { role, text, timestamp: Date.now() }]);
  }, []);

  const cleanup = useCallback(() => {
    if (wsRef.current) {
      try { wsRef.current.close(); } catch { /* ignore */ }
      wsRef.current = null;
    }
  }, []);

  const start = useCallback((intent: string, guardrails?: string) => {
    cleanup();
    setChat([]);
    setPlan(null);
    setError(null);
    setPhase("thinking");

    const ws = connectPlanWs();
    wsRef.current = ws;

    ws.onopen = () => {
      ws.send(JSON.stringify({ type: "start", intent, guardrails: guardrails ?? "" }));
      appendChat("status", "Planning started...");
    };

    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data);
        if (msg.keepalive) return;

        switch (msg.type) {
          case "question":
            setPhase("asking");
            appendChat("assistant", msg.text);
            break;
          case "plan":
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
      setError("WebSocket connection failed");
      setPhase("error");
      wsRef.current = null;
    };

    ws.onclose = () => {
      wsRef.current = null;
    };
  }, [cleanup, appendChat]);

  const answer = useCallback((text: string) => {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;
    wsRef.current.send(JSON.stringify({ type: "answer", text }));
    appendChat("user", text);
    setPhase("thinking");
  }, [appendChat]);

  const cancel = useCallback(() => {
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: "cancel" }));
    }
    cleanup();
    setPhase("idle");
    appendChat("status", "Cancelled.");
  }, [cleanup, appendChat]);

  const reset = useCallback(() => {
    cleanup();
    setChat([]);
    setPlan(null);
    setPhase("idle");
    setError(null);
  }, [cleanup]);

  return { chat, plan, phase, error, start, answer, cancel, reset };
}
