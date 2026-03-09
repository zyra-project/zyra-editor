/**
 * Unit tests for the pure utility exports from ZyraNode.
 *
 * The React component itself (ZyraNode) depends on @xyflow/react internals
 * (useReactFlow, useUpdateNodeInternals) that require a full React Flow
 * provider context.  Those rendering tests are kept in a separate integration
 * suite.  Here we validate the logic-only helpers that can run without DOM.
 */
import { describe, it, expect } from "vitest";
import { isSensitive, SENSITIVE_PATTERNS } from "../ZyraNode.js";
import type { ArgDef } from "@zyra/core";

function makeArg(key: string, label: string, type: ArgDef["type"] = "string"): ArgDef {
  return { key, label, type, required: false };
}

describe("SENSITIVE_PATTERNS regex", () => {
  it("matches 'password' (case-insensitive)", () => {
    expect(SENSITIVE_PATTERNS.test("password")).toBe(true);
    expect(SENSITIVE_PATTERNS.test("PASSWORD")).toBe(true);
  });

  it("matches 'secret'", () => {
    expect(SENSITIVE_PATTERNS.test("secret")).toBe(true);
    expect(SENSITIVE_PATTERNS.test("my_secret_value")).toBe(true);
  });

  it("matches 'token'", () => {
    expect(SENSITIVE_PATTERNS.test("api_token")).toBe(true);
    expect(SENSITIVE_PATTERNS.test("Token")).toBe(true);
  });

  it("matches 'credential' and 'credentials'", () => {
    expect(SENSITIVE_PATTERNS.test("credential")).toBe(true);
    expect(SENSITIVE_PATTERNS.test("credentials")).toBe(true);
  });

  it("matches 'auth'", () => {
    expect(SENSITIVE_PATTERNS.test("auth")).toBe(true);
    expect(SENSITIVE_PATTERNS.test("oauth_token")).toBe(true);
  });

  it("matches 'api_key' and 'apikey' (dot between 'api' and 'key')", () => {
    expect(SENSITIVE_PATTERNS.test("api_key")).toBe(true);
    expect(SENSITIVE_PATTERNS.test("apikey")).toBe(true);
    expect(SENSITIVE_PATTERNS.test("api-key")).toBe(true);
  });

  it("does NOT match innocuous field names", () => {
    expect(SENSITIVE_PATTERNS.test("url")).toBe(false);
    expect(SENSITIVE_PATTERNS.test("format")).toBe(false);
    expect(SENSITIVE_PATTERNS.test("output_file")).toBe(false);
    expect(SENSITIVE_PATTERNS.test("retries")).toBe(false);
    expect(SENSITIVE_PATTERNS.test("start_date")).toBe(false);
  });
});

describe("isSensitive", () => {
  it("returns true when the arg key matches a sensitive pattern", () => {
    expect(isSensitive(makeArg("api_key", "API Key"))).toBe(true);
  });

  it("returns true when the arg label matches a sensitive pattern", () => {
    expect(isSensitive(makeArg("access", "Access Token"))).toBe(true);
  });

  it("returns true when key matches even if label does not", () => {
    expect(isSensitive(makeArg("password", "Pass"))).toBe(true);
  });

  it("returns true when label matches even if key does not", () => {
    expect(isSensitive(makeArg("creds", "Your Credentials Here"))).toBe(true);
  });

  it("returns false for non-sensitive fields", () => {
    expect(isSensitive(makeArg("output_path", "Output Path"))).toBe(false);
    expect(isSensitive(makeArg("format", "Output Format"))).toBe(false);
    expect(isSensitive(makeArg("retries", "Retry Count"))).toBe(false);
  });

  it("is case-insensitive for both key and label", () => {
    expect(isSensitive(makeArg("PASSWORD", "PASSWORD"))).toBe(true);
    expect(isSensitive(makeArg("Secret_Key", "Secret Key"))).toBe(true);
  });
});
