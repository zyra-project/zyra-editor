import type { RunStepRequest, RunStepResponse, JobStatus } from "@zyra/core";

const BASE = "/v1";

export async function postRun(req: RunStepRequest): Promise<RunStepResponse> {
  const res = await fetch(`${BASE}/cli/run`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(req),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`POST /cli/run failed (${res.status}): ${text}`);
  }
  return res.json();
}

export async function getJobStatus(jobId: string): Promise<JobStatus> {
  const res = await fetch(`${BASE}/jobs/${encodeURIComponent(jobId)}`);
  if (!res.ok) {
    throw new Error(`GET /jobs/${jobId} failed (${res.status})`);
  }
  return res.json();
}

export async function cancelJob(jobId: string): Promise<void> {
  const res = await fetch(`${BASE}/jobs/${encodeURIComponent(jobId)}`, {
    method: "DELETE",
  });
  if (!res.ok) {
    throw new Error(`DELETE /jobs/${jobId} failed (${res.status})`);
  }
}

/**
 * Open a WebSocket to stream job logs.
 * `streams` can include "stdout", "stderr", "progress".
 */
export function connectJobWs(
  jobId: string,
  streams?: string[],
): WebSocket {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  let url = `${proto}//${location.host}/ws/jobs/${encodeURIComponent(jobId)}`;
  if (streams?.length) {
    url += `?stream=${streams.join(",")}`;
  }
  return new WebSocket(url);
}
