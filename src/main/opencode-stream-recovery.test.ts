// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ shell: { trashItem: vi.fn(), openPath: vi.fn() } }));
vi.mock("@opencode-ai/client", () => ({ OpenCode: { make: vi.fn() } }));
vi.mock("@opencode-ai/client/service", () => ({
  Service: { discover: vi.fn(), ensure: vi.fn(), headers: () => undefined }
}));

import { OpenShellBackend } from "./opencode";

type BackendInternals = {
  client: unknown;
  handleStreamError: (reason: string) => void;
  handleStreamFailure: (failures: number) => void;
  handleStreamReconnect: () => void;
};

type EmittedMessage = { kind?: string; type?: string; data?: { error?: { code?: string; message?: string } } };

describe("OpenShellBackend stream recovery", () => {
  let backend: OpenShellBackend;
  let internals: BackendInternals;
  let messages: EmittedMessage[];

  beforeEach(() => {
    backend = new OpenShellBackend();
    internals = backend as unknown as BackendInternals;
    messages = [];
    backend.onMessage((msg) => messages.push(msg as EmittedMessage));
  });

  it("drops the bound client once the failure streak reaches the limit", () => {
    const client = { stub: true };
    internals.client = client;

    internals.handleStreamFailure(1);
    internals.handleStreamFailure(2);
    expect(internals.client).toBe(client);

    internals.handleStreamFailure(3);
    expect(internals.client).toBeNull();
  });

  it("leaves the client alone below the limit and when it is already dropped", () => {
    const client = { stub: true };
    internals.client = client;

    internals.handleStreamFailure(2);
    expect(internals.client).toBe(client);

    internals.client = null;
    internals.handleStreamFailure(9);
    expect(internals.client).toBeNull();
  });

  it("reports each outage as a structured global error", () => {
    internals.handleStreamError("[ORBIT_STREAM_FAILED] Live event stream failed");

    const error = messages.find((msg) => msg.type === "global.error");
    expect(error?.data?.error?.code).toBe("ORBIT_STREAM_FAILED");
    expect(error?.data?.error?.message).toBe("Live event stream failed");
  });

  it("emits server.connected only when a live stream reconnects", () => {
    internals.handleStreamReconnect();
    expect(messages.filter((msg) => msg.type === "server.connected")).toHaveLength(0);

    internals.handleStreamReconnect();
    expect(messages.filter((msg) => msg.type === "server.connected")).toHaveLength(1);
  });
});
