// @vitest-environment node
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  app: { getPath: () => tmpdir() },
  shell: { trashItem: vi.fn(), openPath: async () => "" }
}));
vi.mock("@opencode/client", () => ({ OpenCode: { make: vi.fn() } }));
vi.mock("@opencode/client/service", () => ({ Service: {} }));

import { SESSION_RETENTION_MS } from "@shared/retention";
import { OpenShellBackend } from "./opencode";
import { RuntimeSessionIndex } from "./runtimes/runtime-session-index";

interface RawSession {
  id?: string;
  title?: string;
  parentID?: string;
  agent?: string;
  tokens?: { input?: number; output?: number; reasoning?: number; cache?: { read?: number; write?: number } };
  location?: { directory?: string };
  time?: { updated?: number; created?: number };
}

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function session(overrides: RawSession): RawSession {
  return { id: `ses_${Math.random().toString(36).slice(2, 10)}`, ...overrides };
}

function recent(): RawSession["time"] {
  return { updated: Date.now() - 60_000, created: Date.now() - 120_000 };
}

function expired(): RawSession["time"] {
  return { updated: Date.now() - SESSION_RETENTION_MS - 60_000, created: Date.now() - SESSION_RETENTION_MS - 120_000 };
}

function usedTokens(): RawSession["tokens"] {
  return { input: 100, output: 50, reasoning: 0, cache: { read: 10, write: 0 } };
}

function pagedClient(pages: Array<{ data: RawSession[]; next?: string | null }>, removed: string[] = []): unknown {
  const remove = vi.fn(async ({ sessionID }: { sessionID: string }) => {
    removed.push(sessionID);
  });
  const list = vi.fn(async (...calls: unknown[]) => {
    const input = calls[0] as { cursor?: string } | undefined;
    const index = input?.cursor ? Number(input.cursor) : 0;
    return { data: pages[index]?.data ?? [], cursor: { next: pages[index]?.next ?? null } };
  });
  return { session: { list, remove }, message: { list: vi.fn(async () => []) } };
}

async function fixture(client: unknown): Promise<OpenShellBackend> {
  const root = await mkdtemp(path.join(tmpdir(), "orbit-retention-index-"));
  roots.push(root);
  const backend = new OpenShellBackend(
    () => {},
    () => { throw new Error("Runtime adapter is not used in retention tests"); },
    new RuntimeSessionIndex(path.join(root, "runtime-sessions.json"))
  );
  (backend as unknown as { client: unknown }).client = client;
  return backend;
}

describe("session retention", () => {
  it("hides conversation-less and expired sessions from recents", async () => {
    const time = recent();
    const keep = session({ title: "Real work", tokens: undefined, location: { directory: "/w/keep" }, time });
    const promptedButUntitled = session({ tokens: usedTokens(), location: { directory: "/w/prompted" }, time });
    const phantom = session({ location: { directory: "/w/phantom" }, time: recent() });
    const old = session({ title: "Old chat", tokens: usedTokens(), location: { directory: "/w/old" }, time: expired() });
    const backend = await fixture(pagedClient([{ data: [keep, promptedButUntitled, phantom, old] }]));

    const summaries = await backend.listSessions();

    expect(summaries.map((s) => s.id)).toEqual([keep.id, promptedButUntitled.id]);
    expect(summaries[0].title).toBe("Real work");
    expect(summaries[1].title).toBe("prompted");
  });

  it("keeps paging until recents are full or pages run out", async () => {
    const time = recent();
    const fillers = Array.from({ length: 3 }, () =>
      session({ title: "Filler", tokens: usedTokens(), location: { directory: "/w/fill" }, time })
    );
    const late = session({ title: "Late find", tokens: usedTokens(), location: { directory: "/w/late" }, time });
    const phantoms = Array.from({ length: 4 }, () => session({ location: { directory: "/w/x" }, time: recent() }));
    const removed: string[] = [];
    const client = pagedClient(
      [
        { data: [...phantoms.slice(0, 2), fillers[0]], next: "1" },
        { data: [...phantoms.slice(2), fillers[1]], next: "2" },
        { data: [fillers[2], late], next: null }
      ],
      removed
    );
    const backend = await fixture(client);

    const summaries = await backend.listSessions();

    expect(summaries.map((s) => s.title)).toEqual(["Filler", "Filler", "Filler", "Late find"]);
    expect((client as { session: { list: ReturnType<typeof vi.fn> } }).session.list).toHaveBeenCalledTimes(3);
  });

  it("prunes only expired sessions across pages, skipping active ones and tolerating failures", async () => {
    const root = await realpath(await mkdtemp(path.join(tmpdir(), "openshell-retention-")));
    roots.push(root);
    await writeFile(path.join(root, "keep.txt"), "content");
    const backend = new OpenShellBackend();
    const activeID = "ses_active";
    (backend as unknown as { client: unknown }).client = {
      session: {
        create: vi.fn(async () => ({ id: activeID })),
        get: vi.fn(async () => ({ id: activeID, location: { directory: root } })),
        list: vi.fn(async () => []),
        remove: vi.fn(async () => {})
      },
      message: { list: vi.fn(async () => []) }
    };
    await backend.openSession(root, 1);

    const goneA = session({ id: "ses_gone-a", title: "Old A", tokens: usedTokens(), location: { directory: "/w/a" }, time: expired() });
    const goneB = session({ id: "ses_gone-b", title: "Old B", tokens: usedTokens(), location: { directory: "/w/b" }, time: expired() });
    const keptRecent = session({ id: "ses_recent", title: "New", tokens: usedTokens(), location: { directory: "/w/c" }, time: recent() });
    const undated = session({ id: "ses_undated", title: "Undated", tokens: usedTokens(), location: { directory: "/w/d" }, time: undefined });
    const removed: string[] = [];
    const failingRemove = vi.fn(async ({ sessionID }: { sessionID: string }) => {
      if (sessionID === "ses_gone-a") throw new Error("remove failed");
      removed.push(sessionID);
    });
    (backend as unknown as { client: { session: { list: ReturnType<typeof vi.fn>; remove: typeof failingRemove } } }).client.session = {
      list: vi.fn(async (...calls: unknown[]) => {
        const input = calls[0] as { cursor?: string } | undefined;
        const page = !input?.cursor ? { data: [goneA, keptRecent], next: "p2" } : { data: [goneB, undated, { id: activeID, title: "Active", time: expired() }], next: null };
        return { data: page.data, cursor: { next: page.next ?? null } };
      }),
      remove: failingRemove
    };

    const pruned = await (backend as unknown as { pruneExpiredSessions: () => Promise<number> }).pruneExpiredSessions();

    expect(pruned).toBe(1);
    expect(removed).toEqual(["ses_gone-b"]);
    expect(failingRemove).toHaveBeenCalledWith({ sessionID: "ses_gone-a" });
    expect(failingRemove).not.toHaveBeenCalledWith({ sessionID: activeID });
    expect(failingRemove).not.toHaveBeenCalledWith({ sessionID: "ses_recent" });
    expect(failingRemove).not.toHaveBeenCalledWith({ sessionID: "ses_undated" });
  });

  it("prunes conversation-less sessions after a day while keeping real conversations for 30 days", async () => {
    const removed: string[] = [];
    const staleEmpty = session({ id: "ses_stale-empty", location: { directory: "/w/e" }, time: { updated: Date.now() - 25 * 60 * 60 * 1000, created: Date.now() - 25 * 60 * 60 * 1000 } });
    const freshEmpty = session({ id: "ses_fresh-empty", location: { directory: "/w/f" }, time: recent() });
    const staleTitled = session({ id: "ses_stale-titled", title: "Still young", tokens: usedTokens(), location: { directory: "/w/g" }, time: { updated: Date.now() - 25 * 60 * 60 * 1000, created: Date.now() - 25 * 60 * 60 * 1000 } });
    const backend = await fixture({
      session: {
        list: vi.fn(async () => ({ data: [staleEmpty, freshEmpty, staleTitled], cursor: { next: null } })),
        remove: vi.fn(async ({ sessionID }: { sessionID: string }) => {
          removed.push(sessionID);
        })
      },
      message: { list: vi.fn(async () => []) }
    });

    const pruned = await (backend as unknown as { pruneExpiredSessions: () => Promise<number> }).pruneExpiredSessions();

    expect(pruned).toBe(1);
    expect(removed).toEqual(["ses_stale-empty"]);
  });

  it("retries a failed history fetch once and throws instead of returning an empty transcript", async () => {
    const transient = { session: { list: vi.fn(async () => ({ data: [], cursor: {} })) }, message: { list: vi.fn()
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce({ data: [{ id: "m1", type: "user", text: "hello" }] }) } };
    const backend = await fixture(transient);
    const recovered = await backend.sessionTranscript("ses_x");
    expect(recovered.transcript.map((item) => item.kind)).toEqual(["user"]);
    expect(transient.message.list).toHaveBeenCalledTimes(2);

    const alwaysFailing = { session: { list: vi.fn(async () => ({ data: [], cursor: {} })) }, message: { list: vi.fn(async () => {
      throw new Error("down");
    }) } };
    const flaky = await fixture(alwaysFailing);
    await expect(flaky.sessionTranscript("ses_y")).rejects.toThrow("could not load conversation history");
    expect(alwaysFailing.message.list).toHaveBeenCalledTimes(2);
  });

  it("follows message.list pagination so long conversations load completely", async () => {
    const pageOf = (start: number, count: number) =>
      Array.from({ length: count }, (_, index) => ({ id: `m${start + index}`, type: "user", text: `page item ${start + index}` }));
    let calls = 0;
    const paged = { session: { list: vi.fn(async () => ({ data: [], cursor: {} })) }, message: { list: vi.fn(async (...inputs: unknown[]) => {
      const input = inputs[0] as { cursor?: string } | undefined;
      if (!input?.cursor) {
        expect(input).toEqual({ sessionID: "ses_long", order: "asc" });
        calls += 1;
        return { data: pageOf(0, 50), cursor: { next: "cursor-page-2" } };
      }
      expect(input).toEqual({ sessionID: "ses_long", cursor: "cursor-page-2" });
      calls += 1;
      return { data: pageOf(50, 39), cursor: { next: null } };
    }) } };
    const backend = await fixture(paged);

    const recovered = await backend.sessionTranscript("ses_long");

    expect(calls).toBe(2);
    expect(recovered.transcript).toHaveLength(89);
    expect(recovered.transcript.at(-1)).toMatchObject({ kind: "user", text: "page item 88" });
  });

  it("throttles retention pruning to once per cooldown", async () => {
    const backend = new OpenShellBackend();
    const prune = vi.fn(async () => 0);
    const internals = backend as unknown as { pruneExpiredSessions: () => Promise<number>; lastPruneAt: number; pruning: boolean; scheduleRetentionPrune: () => void };
    internals.pruneExpiredSessions = prune;
    internals.lastPruneAt = 0;

    internals.scheduleRetentionPrune();
    await new Promise((resolve) => setTimeout(resolve, 0));
    internals.scheduleRetentionPrune();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(prune).toHaveBeenCalledTimes(1);

    internals.lastPruneAt = 0;
    internals.scheduleRetentionPrune();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(prune).toHaveBeenCalledTimes(2);
  });
});
