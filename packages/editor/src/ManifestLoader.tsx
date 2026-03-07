import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import type { Manifest } from "@zyra/core";
import { MOCK_MANIFEST } from "./mock-manifest";

/** Editor-only stages (controls + planned) that should always appear in the palette. */
const BUILTIN_STAGES = MOCK_MANIFEST.stages.filter(
  (s) => s.stage === "control" || s.stage === "verify",
);

/** Merge editor-only stages into a server-provided manifest (avoids duplicates). */
function withBuiltinStages(manifest: Manifest): Manifest {
  const existing = new Set(
    manifest.stages.map((s) => `${s.stage}/${s.command}`),
  );
  const toAdd = BUILTIN_STAGES.filter((s) => !existing.has(`${s.stage}/${s.command}`));
  if (toAdd.length === 0) return manifest;
  return { ...manifest, stages: [...manifest.stages, ...toAdd] };
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
      .then((m) => setManifest(withBuiltinStages(m)))
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
