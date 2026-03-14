/**
 * Unit tests for the resource resolution system.
 */
import { describe, it, expect } from "vitest";
import {
  findResourceRefs,
  resolveResourceRefs,
  resolveArgsResources,
  resolveRequestResources,
  validateResources,
  toResourceMap,
} from "../resources.js";
import type { PipelineResource } from "../resources.js";

const resources = { work_dir: "/data/output", s3_bucket: "s3://my-bucket", db: "postgres://localhost" };

describe("findResourceRefs", () => {
  it("finds a single reference", () => {
    expect(findResourceRefs("${res:work_dir}/raw")).toEqual(["work_dir"]);
  });

  it("finds multiple references", () => {
    expect(findResourceRefs("${res:s3_bucket}/${res:work_dir}")).toEqual(["s3_bucket", "work_dir"]);
  });

  it("returns empty array for no references", () => {
    expect(findResourceRefs("plain value")).toEqual([]);
  });

  it("ignores env var syntax without res: prefix", () => {
    expect(findResourceRefs("${MY_VAR}")).toEqual([]);
  });
});

describe("resolveResourceRefs", () => {
  it("resolves a single reference", () => {
    expect(resolveResourceRefs("${res:work_dir}/raw", resources)).toBe("/data/output/raw");
  });

  it("resolves multiple references in one string", () => {
    expect(resolveResourceRefs("${res:s3_bucket}/${res:work_dir}", resources)).toBe(
      "s3://my-bucket//data/output",
    );
  });

  it("leaves unresolved references as-is", () => {
    expect(resolveResourceRefs("${res:missing}/path", resources)).toBe("${res:missing}/path");
  });

  it("passes through numbers unchanged", () => {
    expect(resolveResourceRefs(42, resources)).toBe(42);
  });

  it("passes through booleans unchanged", () => {
    expect(resolveResourceRefs(true, resources)).toBe(true);
  });

  it("handles string with no references", () => {
    expect(resolveResourceRefs("plain", resources)).toBe("plain");
  });

  it("resolves a value that is entirely a reference", () => {
    expect(resolveResourceRefs("${res:db}", resources)).toBe("postgres://localhost");
  });
});

describe("resolveArgsResources", () => {
  it("resolves references across all string args", () => {
    const args = {
      output: "${res:work_dir}/files",
      bucket: "${res:s3_bucket}",
      count: 5,
      verbose: true,
    };
    const result = resolveArgsResources(args, resources);
    expect(result).toEqual({
      output: "/data/output/files",
      bucket: "s3://my-bucket",
      count: 5,
      verbose: true,
    });
  });
});

describe("resolveRequestResources", () => {
  it("resolves string values in a Record<string, unknown>", () => {
    const args: Record<string, unknown> = {
      path: "${res:work_dir}/data",
      limit: 100,
      flag: true,
    };
    const result = resolveRequestResources(args, resources);
    expect(result).toEqual({
      path: "/data/output/data",
      limit: 100,
      flag: true,
    });
  });
});

describe("validateResources", () => {
  it("accepts valid resources", () => {
    const res: PipelineResource[] = [
      { name: "work_dir", value: "/data" },
      { name: "s3Bucket", value: "s3://b" },
    ];
    expect(validateResources(res)).toEqual([]);
  });

  it("rejects invalid names", () => {
    const res: PipelineResource[] = [{ name: "123bad", value: "x" }];
    expect(validateResources(res)).toHaveLength(1);
    expect(validateResources(res)[0].message).toContain("Invalid name");
  });

  it("rejects duplicate names", () => {
    const res: PipelineResource[] = [
      { name: "dup", value: "a" },
      { name: "dup", value: "b" },
    ];
    const errors = validateResources(res);
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain("Duplicate");
  });

  it("rejects names with special characters", () => {
    const res: PipelineResource[] = [{ name: "my-resource", value: "x" }];
    expect(validateResources(res)).toHaveLength(1);
  });
});

describe("resolveRequestResources — edge cases", () => {
  it("resolves multiple references in a single arg value", () => {
    const args: Record<string, unknown> = {
      url: "${res:s3_bucket}/${res:work_dir}/file.csv",
    };
    const result = resolveRequestResources(args, resources);
    expect(result.url).toBe("s3://my-bucket//data/output/file.csv");
  });

  it("handles empty resource map (no-op)", () => {
    const args: Record<string, unknown> = { path: "${res:work_dir}" };
    const result = resolveRequestResources(args, {});
    expect(result.path).toBe("${res:work_dir}");
  });

  it("passes through null and undefined values", () => {
    const args: Record<string, unknown> = { a: null, b: undefined, c: "${res:work_dir}" };
    const result = resolveRequestResources(args, resources);
    expect(result.a).toBeNull();
    expect(result.b).toBeUndefined();
    expect(result.c).toBe("/data/output");
  });

  it("passes through nested objects unchanged", () => {
    const nested = { inner: "${res:work_dir}" };
    const args: Record<string, unknown> = { obj: nested };
    const result = resolveRequestResources(args, resources);
    expect(result.obj).toBe(nested); // not deeply resolved
  });
});

describe("toResourceMap", () => {
  it("converts array to map", () => {
    const res: PipelineResource[] = [
      { name: "a", value: "1" },
      { name: "b", value: "2" },
    ];
    expect(toResourceMap(res)).toEqual({ a: "1", b: "2" });
  });

  it("handles empty array", () => {
    expect(toResourceMap([])).toEqual({});
  });

  it("last value wins for duplicates", () => {
    const res: PipelineResource[] = [
      { name: "x", value: "first" },
      { name: "x", value: "second" },
    ];
    expect(toResourceMap(res)).toEqual({ x: "second" });
  });

  it("preserves description but map only contains values", () => {
    const res: PipelineResource[] = [
      { name: "dir", value: "/tmp", description: "Temp directory" },
    ];
    const map = toResourceMap(res);
    expect(map).toEqual({ dir: "/tmp" });
    expect(Object.keys(map)).toEqual(["dir"]);
  });
});
