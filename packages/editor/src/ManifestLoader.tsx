import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import type { Manifest } from "@zyra/core";
import { MOCK_MANIFEST } from "./mock-manifest";

/** Control nodes defined in the mock manifest that should always be available. */
const BUILTIN_CONTROL_STAGES = MOCK_MANIFEST.stages.filter((s) => s.stage === "control");

/** Merge built-in control nodes into a server-provided manifest (avoids duplicates). */
function withBuiltinControls(manifest: Manifest): Manifest {
  const existing = new Set(
    manifest.stages
      .filter((s) => s.stage === "control")
      .map((s) => s.command),
  );
  const toAdd = BUILTIN_CONTROL_STAGES.filter((s) => !existing.has(s.command));
  if (toAdd.length === 0) return manifest;
  return { ...manifest, stages: [...toAdd, ...manifest.stages] };
}

const ManifestCtx = createContext<Manifest | null>(null);

export function useManifest(): Manifest {
  const m = useContext(ManifestCtx);
  if (!m) throw new Error("useManifest must be used inside <ManifestProvider>");
  return m;
}

export function ManifestProvider({ children }: { children: ReactNode }) {
  const [manifest, setManifest] = useState<Manifest | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/v1/manifest")
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((m) => setManifest(withBuiltinControls(m)))
      .catch(() => {
        // Fall back to mock manifest in dev mode
        console.warn("Could not fetch /v1/manifest — using mock manifest");
        setManifest(MOCK_MANIFEST);
        setError(null);
      });
  }, []);

  if (error) return <div style={{ padding: 24, color: "#f44" }}>{error}</div>;
  if (!manifest) return <div style={{ padding: 24 }}>Loading manifest...</div>;

  return <ManifestCtx.Provider value={manifest}>{children}</ManifestCtx.Provider>;
}
