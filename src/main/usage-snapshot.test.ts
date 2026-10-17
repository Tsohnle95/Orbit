import { describe, expect, it } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { readMiraUsageSnapshot } from "./provider-usage";

const result = {
  provider: "openai",
  displayName: "ChatGPT",
  status: "ok",
  snapshot: { windows: [], credits: null, planType: null, updatedAt: 1 },
  error: null
};

async function inTemp(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "mira-usage-"));
}

describe("mira usage snapshot", () => {
  it("accepts a fresh snapshot with results", async () => {
    const dir = await inTemp();
    const file = path.join(dir, "mira-usage.json");
    await writeFile(file, JSON.stringify({ generatedAt: Date.now() - 1000, results: [result] }));
    const read = await readMiraUsageSnapshot([file]);
    expect(read).toHaveLength(1);
    expect(read[0].provider).toBe("openai");
    await rm(dir, { recursive: true, force: true });
  });

  it("ignores stale snapshots and falls through to later candidates", async () => {
    const dir = await inTemp();
    const stale = path.join(dir, "stale.json");
    const fresh = path.join(dir, "fresh.json");
    await writeFile(stale, JSON.stringify({ generatedAt: Date.now() - 60 * 60 * 1000, results: [result] }));
    await writeFile(fresh, JSON.stringify({ generatedAt: Date.now() - 1000, results: [{ ...result, provider: "anthropic" }] }));
    const read = await readMiraUsageSnapshot([stale, fresh]);
    expect(read[0].provider).toBe("anthropic");
    await rm(dir, { recursive: true, force: true });
  });

  it("returns empty when no candidate is readable or valid", async () => {
    const dir = await inTemp();
    const missing = path.join(dir, "missing.json");
    const garbage = path.join(dir, "garbage.json");
    await writeFile(garbage, "not json");
    expect(await readMiraUsageSnapshot([missing, garbage])).toEqual([]);
    await rm(dir, { recursive: true, force: true });
  });
});
