import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import type { Manifest } from "@zyra/core";
import { MOCK_MANIFEST } from "./mock-manifest";

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
      .then(setManifest)
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
