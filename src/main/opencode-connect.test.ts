// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

const hoisted = vi.hoisted(() => ({
  discover: vi.fn(),
  ensure: vi.fn(),
  openCodeMake: vi.fn()
}));

vi.mock("electron", () => ({ shell: { trashItem: vi.fn(), openPath: vi.fn() } }));
vi.mock("@opencode-ai/client", () => ({ OpenCode: { make: hoisted.openCodeMake } }));
vi.mock("@opencode-ai/client/service", () => ({
  Service: { discover: hoisted.discover, ensure: hoisted.ensure, headers: () => undefined }
}));

import { OpenShellBackend, serverBuild, serverVersionPredicate } from "./opencode";

const MIN_BUILD = 17577;

describe("serverBuild", () => {
  it("reads the trailing build from installed and service version strings", () => {
    expect(serverBuild("opencode2 v0.0.0-beta-19242")).toBe(19242);
    expect(serverBuild("0.0.0-beta-19242")).toBe(19242);
    expect(serverBuild(undefined)).toBeNull();
    expect(serverBuild("")).toBeNull();
    expect(serverBuild("no-build")).toBeNull();
  });
});

describe("serverVersionPredicate", () => {
  it("rejects a stale running service and accepts the installed build", () => {
    const accept = serverVersionPredicate("opencode2 v0.0.0-beta-19242", MIN_BUILD);
    expect(accept("0.0.0-beta-19242")).toBe(true);
    expect(accept("0.0.0-beta-18138")).toBe(false);
    expect(accept("0.0.0-beta-17000")).toBe(false);
  });

  it("falls back to the floor when the installed build is unknown", () => {
    const accept = serverVersionPredicate(null, MIN_BUILD);
    expect(accept("0.0.0-beta-19242")).toBe(true);
    expect(accept("0.0.0-beta-17577")).toBe(true);
    expect(accept("0.0.0-beta-17000")).toBe(false);
  });
});

describe("OpenShellBackend.connect", () => {
  const stubInstalledVersion = (backend: OpenShellBackend, version: string | null): void => {
    (backend as unknown as { installedServerVersion: () => Promise<string | null> }).installedServerVersion =
      async () => version;
  };

  beforeEach(() => {
    hoisted.discover.mockReset();
    hoisted.ensure.mockReset();
    hoisted.openCodeMake.mockReset();
    hoisted.openCodeMake.mockReturnValue({ session: { list: vi.fn(async () => []) } });
  });

  it("reuses a running service that matches the installed binary", async () => {
    const endpoint = { url: "http://127.0.0.1:1", auth: undefined };
    hoisted.discover.mockResolvedValue(endpoint);
    const backend = new OpenShellBackend();
    stubInstalledVersion(backend, "opencode2 v0.0.0-beta-19242");

    await expect(backend.connect()).resolves.toBe(true);

    const options = hoisted.discover.mock.calls[0][0] as { version: (value: string) => boolean };
    expect(options.version("0.0.0-beta-19242")).toBe(true);
    expect(options.version("0.0.0-beta-18138")).toBe(false);
    expect(hoisted.ensure).not.toHaveBeenCalled();
  });

  it("replaces a stale daemon by ensuring the installed binary's build", async () => {
    const staleVersion = "0.0.0-beta-18138";
    // Model the SDK's discover contract: reject a registered service whose
    // version fails the predicate instead of handing back the stale daemon.
    hoisted.discover.mockImplementation(async (options: { version: (value: string) => boolean }) =>
      options.version(staleVersion) ? { url: "http://127.0.0.1:1", auth: undefined } : undefined
    );
    hoisted.ensure.mockResolvedValue({ url: "http://127.0.0.1:2", auth: undefined });
    const backend = new OpenShellBackend();
    stubInstalledVersion(backend, "opencode2 v0.0.0-beta-19242");

    await expect(backend.connect()).resolves.toBe(true);

    expect(hoisted.ensure).toHaveBeenCalledTimes(1);
    const options = hoisted.ensure.mock.calls[0][0] as {
      command: string[];
      version: (value: string) => boolean;
    };
    expect(options.command).toEqual(["opencode2", "serve", "--service"]);
    expect(options.version("0.0.0-beta-19242")).toBe(true);
    expect(options.version(staleVersion)).toBe(false);
  });
});
