// @vitest-environment node
import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  app: { getPath: () => "/tmp" },
  shell: { trashItem: vi.fn(), openPath: vi.fn() }
}));
vi.mock("@opencode/client", () => ({ OpenCode: { make: vi.fn() } }));
vi.mock("@opencode/client/service", () => ({ Service: {} }));

import { LatestGeneration } from "@shared/generation";
import type { FileBaseline, WorkspaceIdentity } from "@shared/types";
import { OpenShellBackend, type SessionContext } from "./opencode";

const workspace: WorkspaceIdentity = { id: "11111111-1111-4111-8111-111111111111", generation: 1 };

function fixture() {
  const backend = new OpenShellBackend();
  const directory = "/workspace";
  const client = {
    session: {
      form: {
        list: vi.fn(async () => [{
          id: "frm_session",
          sessionID: "session",
          title: "Session question",
          fields: [{ key: "answer", type: "string" }]
        }]),
        reply: vi.fn(async () => {}),
        cancel: vi.fn(async () => {})
      }
    },
    form: {
      list: vi.fn(async () => ({
        location: { directory },
        data: [{
          id: "frm_global",
          sessionID: "global",
          title: "Global question",
          fields: [{ key: "choice", type: "boolean" }]
        }]
      }))
    }
  };
  const context: SessionContext = {
    workspace,
    sessionID: "session",
    directory,
    sessionInfo: { id: "session", directory, workspace },
    watchContext: {
      root: directory,
      sessionID: "session",
      workspace,
      snapshots: new Map<string, FileBaseline>(),
      lastKnown: new Map<string, string>(),
      hasGit: false,
      timers: new Map()
    },
    watcher: null,
    activations: new LatestGeneration()
  };
  const state = backend as unknown as {
    client: typeof client;
    contexts: Map<string, SessionContext>;
    primary: string | null;
  };
  state.client = client;
  state.contexts = new Map([[workspace.id, context]]);
  state.primary = workspace.id;
  return { backend, client };
}

describe("backend forms", () => {
  it("merges session and location-global pending forms", async () => {
    const { backend, client } = fixture();

    await expect(backend.listForms(workspace)).resolves.toEqual([
      expect.objectContaining({ id: "frm_session", sessionID: "session" }),
      expect.objectContaining({ id: "frm_global", sessionID: "global" })
    ]);
    expect(client.session.form.list).toHaveBeenCalledWith({ sessionID: "session" });
    expect(client.form.list).toHaveBeenCalledWith({ location: { directory: "/workspace" } });
  });

  it("answers and cancels global forms with their location context", async () => {
    const { backend, client } = fixture();

    await backend.replyForm(workspace, "frm_global", { choice: true }, "global");
    await backend.cancelForm(workspace, "frm_global", "global");

    const requestOptions = { headers: { "x-opencode-directory": "%2Fworkspace" } };
    expect(client.session.form.reply).toHaveBeenCalledWith(
      { sessionID: "global", formID: "frm_global", answer: { choice: true } },
      requestOptions
    );
    expect(client.session.form.cancel).toHaveBeenCalledWith(
      { sessionID: "global", formID: "frm_global" },
      requestOptions
    );
  });

  it("rejects a form owned by an unrelated session", async () => {
    const { backend, client } = fixture();

    await expect(backend.replyForm(workspace, "frm_other", {}, "other-session"))
      .rejects.toThrow("form does not belong");
    expect(client.session.form.reply).not.toHaveBeenCalled();
  });
});
