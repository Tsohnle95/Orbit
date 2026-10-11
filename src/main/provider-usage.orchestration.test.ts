import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { promises as fsp } from "node:fs";
import { fetchProviderUsage } from "./provider-usage";
import { readOAuthEntries, type OAuthEntry } from "./provider-credentials";
import type { ProviderUsageResult } from "@shared/types";

vi.mock("node:fs", () => {
  const promises = { readFile: vi.fn() };
  return { promises, default: { promises } };
});
vi.mock("./provider-credentials", () => ({ readOAuthEntries: vi.fn() }));

const credentials = vi.mocked(readOAuthEntries);
const files = vi.mocked(fsp.readFile);
const fallback = (provider: string): ProviderUsageResult => ({
  provider, displayName: provider, status: "stale", snapshot: { windows: [], credits: null, planType: "fixture", updatedAt: 1 }
});
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

beforeEach(() => {
  vi.stubEnv("COMMANDCODE_API_KEY", "");
  vi.stubEnv("COMMAND_CODE_API_KEY", "");
  credentials.mockReset().mockResolvedValue({});
  files.mockReset().mockResolvedValue(JSON.stringify({ generatedAt: Date.now(), results: [] }));
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("provider refresh ordering and failure semantics", () => {
  it("runs three providers sequentially and retains provider result order", async () => {
    vi.useFakeTimers();
    credentials.mockResolvedValue({
      openai: { type: "oauth", access: "fixture-openai" },
      anthropic: { type: "oauth", access: "fixture-claude" },
      "opencode-go": { type: "oauth", access: "fixture-go" }
    });
    const calls: string[] = [];
    const transport = vi.fn(async (url: string) => {
      const provider = url.includes("chatgpt") ? "openai" : url.includes("anthropic") ? "anthropic" : "opencode-go";
      calls.push(provider);
      await new Promise((resolve) => setTimeout(resolve, provider === "openai" ? 40 : provider === "anthropic" ? 30 : 20));
      return response(provider === "opencode-go" ? { usage: {} } : {});
    });
    vi.stubGlobal("fetch", transport);
    const result = fetchProviderUsage();
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toEqual(["openai"]);
    await vi.advanceTimersByTimeAsync(40);
    expect(calls).toEqual(["openai", "anthropic"]);
    await vi.advanceTimersByTimeAsync(30);
    expect(calls).toEqual(["openai", "anthropic", "opencode-go"]);
    await vi.advanceTimersByTimeAsync(20);
    expect((await result).map((entry) => [entry.provider, entry.status])).toEqual([
      ["openai", "ok"], ["anthropic", "ok"], ["opencode-go", "ok"]
    ]);
  });

  it("rejects malformed credentials before issuing any later provider requests", async () => {
    credentials.mockResolvedValue({
      openai: { type: "oauth", access: 42 } as unknown as OAuthEntry,
      anthropic: { type: "oauth", access: "fixture-claude" },
      "opencode-go": { type: "oauth", access: "fixture-go" }
    });
    const transport = vi.fn(async () => response({}));
    vi.stubGlobal("fetch", transport);
    await expect(fetchProviderUsage()).rejects.toThrow("split");
    expect(transport).not.toHaveBeenCalled();
  });

  it("does not start later providers after an unexpected parsing failure, even with a snapshot", async () => {
    credentials.mockResolvedValue({ anthropic: { access: "fixture-claude" }, "opencode-go": { access: "fixture-go" } });
    files.mockResolvedValue(JSON.stringify({ generatedAt: Date.now(), results: [fallback("anthropic")] }));
    const transport = vi.fn(async (_url: string) => response({ limits: [null] }));
    vi.stubGlobal("fetch", transport);
    await expect(fetchProviderUsage()).rejects.toThrow();
    expect(transport).toHaveBeenCalledTimes(1);
    expect(transport.mock.calls[0][0]).toContain("anthropic");
  });

  it("continues after expected network failure and keeps the retryable result visible", async () => {
    credentials.mockResolvedValue({ openai: { access: "fixture-openai" }, "opencode-go": { access: "fixture-go" } });
    const transport = vi.fn(async (url: string) => {
      if (url.includes("chatgpt")) throw new Error("Fixture network failure");
      return response({ usage: {} });
    });
    vi.stubGlobal("fetch", transport);
    const results = await fetchProviderUsage();
    expect(results.map((entry) => entry.provider)).toEqual(["openai", "opencode-go"]);
    expect(results[0].error).toMatchObject({ code: "fetch_failed", retryable: true });
    expect(results[1].status).toBe("ok");
  });

  it("uses snapshots for expected authentication failures and missing credentials, appending unknown providers", async () => {
    credentials.mockResolvedValue({ openai: { access: "fixture-openai" } });
    const snapshots = [fallback("custom"), fallback("opencode-go"), fallback("openai")];
    files.mockResolvedValue(JSON.stringify({ generatedAt: Date.now(), results: snapshots }));
    const transport = vi.fn(async () => response({}, 401));
    vi.stubGlobal("fetch", transport);
    expect(await fetchProviderUsage()).toEqual([snapshots[2], snapshots[1], snapshots[0]]);
    expect(transport).toHaveBeenCalledTimes(1);
  });
});
