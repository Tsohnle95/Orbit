import { describe, expect, it, vi } from "vitest";
import { homedir } from "node:os";
import { MobileServer } from "./mobile-server";

const checkoutScript = "/work/orbit-mobile/scripts/desktop-service.mjs";
const servicePassword = "local-only-ui-password";
const serviceStatus = JSON.stringify({ pid: 123, port: 3011, password: servicePassword });

const makeServer = (options: {
  exists?: (candidate: string) => boolean;
  fetcher?: typeof fetch;
  readTextFile?: (candidate: string) => string;
  env?: NodeJS.ProcessEnv;
} = {}) => new MobileServer({
  cwd: "/work/orbit",
  supportDirectory: "/support",
  env: options.env ?? { ORBIT_NODE_BIN: "/node" },
  exists: options.exists ?? ((candidate) => candidate === checkoutScript || candidate === "/node"),
  readTextFile: options.readTextFile ?? (() => serviceStatus),
  fetcher: options.fetcher,
});

const jsonResponse = (body: unknown, init: ResponseInit = {}) => new Response(JSON.stringify(body), {
  headers: { "Content-Type": "application/json", ...init.headers },
  ...init,
});

describe("MobileServer setup and pairing", () => {
  it("finds the sibling mobile checkout and reports ready without exposing its password", async () => {
    const fetcher = vi.fn<typeof fetch>(async (input) => {
      expect(String(input)).toBe("http://127.0.0.1:3011/health");
      return jsonResponse({ status: "ok" });
    });
    const server = makeServer({ fetcher });

    await expect(server.getSetupStatus()).resolves.toEqual({
      state: "ready",
      workspacePath: "/work/orbit-mobile",
      port: 3011,
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("explains a missing companion checkout rather than silently disabling mobile setup", async () => {
    const server = makeServer({
      exists: (candidate) => candidate === "/node",
    });

    await expect(server.getSetupStatus()).resolves.toMatchObject({
      state: "setup-required",
      reason: "companion-checkout-missing",
      workspacePath: `${homedir()}/coding-projects/orbit-mobile`,
    });
    await expect(server.createPairingQr()).rejects.toThrow("set ORBIT_MOBILE_HOME to its folder");
  });

  it("surfaces missing Node.js as actionable setup state", async () => {
    const server = makeServer({
      env: { ORBIT_NODE_BIN: "/missing-node" },
      exists: (candidate) => candidate === checkoutScript,
    });

    await expect(server.getSetupStatus()).resolves.toMatchObject({
      state: "setup-required",
      reason: "node-runtime-missing",
      workspacePath: "/work/orbit-mobile",
    });
  });

  it("keeps the UI password in main while creating an authenticated one-time pairing URI", async () => {
    const connectionUrl = "orbit://connect?v=2&p=eyJ2IjoyfQ";
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input);
      if (url.endsWith("/health")) return jsonResponse({ status: "ok" });
      if (url.endsWith("/auth/session")) {
        expect(JSON.parse(String(init?.body))).toEqual({ password: servicePassword });
        return jsonResponse({ authenticated: true }, {
          headers: { "Set-Cookie": "oc_ui_session=session-cookie; Path=/; HttpOnly; SameSite=Lax" },
        });
      }
      if (url.endsWith("/api/client-auth/pairing/transports")) {
        expect(new Headers(init?.headers).get("cookie")).toBe("oc_ui_session=session-cookie");
        return jsonResponse({ local: "http://127.0.0.1:3011", lan: "http://192.168.1.20:3011", relayAvailable: true });
      }
      if (url.endsWith("/api/client-auth/pairing/sessions")) {
        expect(new Headers(init?.headers).get("cookie")).toBe("oc_ui_session=session-cookie");
        expect(JSON.parse(String(init?.body))).toEqual({
          allowedClientKinds: ["mobile"],
          serverUrl: "http://192.168.1.20:3011",
          includeDirect: true,
          includeRelay: true,
        });
        return jsonResponse({
          pairing: { id: "pair_once", secret: "single-use", expiresAt: "2099-01-01T00:00:00.000Z" },
          server: { label: "Mac Studio" },
          connectionUrl,
        }, { status: 201, headers: { "Cache-Control": "no-store" } });
      }
      throw new Error(`Unexpected URL: ${url}`);
    });
    const server = makeServer({ fetcher });

    const result = await server.createPairingQr();

    expect(result).toEqual({
      connectionUrl,
      expiresAt: "2099-01-01T00:00:00.000Z",
      serverLabel: "Mac Studio",
    });
    expect(JSON.stringify(result)).not.toContain(servicePassword);
    expect(fetcher).toHaveBeenCalledTimes(4);
  });

  it("creates a relay-only pairing link when the desktop has no directly reachable LAN address", async () => {
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input);
      if (url.endsWith("/health")) return jsonResponse({ status: "ok" });
      if (url.endsWith("/auth/session")) {
        return jsonResponse({ authenticated: true }, {
          headers: { "Set-Cookie": "oc_ui_session=session-cookie; Path=/" },
        });
      }
      if (url.endsWith("/api/client-auth/pairing/transports")) return jsonResponse({ local: "http://127.0.0.1:3011", lan: null, relayAvailable: true });
      if (url.endsWith("/api/client-auth/pairing/sessions")) {
        expect(JSON.parse(String(init?.body))).toEqual({
          allowedClientKinds: ["mobile"], includeDirect: false, includeRelay: true,
        });
        return jsonResponse({
          pairing: { id: "pair_relay", secret: "single-use", expiresAt: "2099-01-01T00:00:00.000Z" },
          server: { label: "Mac Studio" },
          connectionUrl: "orbit://connect?v=2&p=relay-only",
        }, { status: 201 });
      }
      throw new Error(`Unexpected URL: ${url}`);
    });
    const server = makeServer({ fetcher });

    await expect(server.createPairingQr()).resolves.toMatchObject({
      connectionUrl: "orbit://connect?v=2&p=relay-only",
      serverLabel: "Mac Studio",
    });
  });

  it("asks the user to restart Orbit when the running companion predates pairing URI support", async () => {
    const fetcher = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (url.endsWith("/health")) return jsonResponse({ status: "ok" });
      if (url.endsWith("/auth/session")) {
        return jsonResponse({ authenticated: true }, {
          headers: { "Set-Cookie": "oc_ui_session=session-cookie; Path=/" },
        });
      }
      if (url.endsWith("/api/client-auth/pairing/transports")) return jsonResponse({ lan: "http://192.168.1.20:3011" });
      if (url.endsWith("/api/client-auth/pairing/sessions")) {
        return jsonResponse({
          pairing: { id: "pair_old", secret: "single-use", expiresAt: "2099-01-01T00:00:00.000Z" },
          server: { label: "Mac Studio", candidates: [{ type: "lan", url: "http://192.168.1.20:3011" }] },
        }, { status: 201 });
      }
      if (url.endsWith("/api/client-auth/pairing/sessions/pair_old")) return jsonResponse({ cancelled: true });
      throw new Error(`Unexpected URL: ${url}`);
    });

    await expect(makeServer({ fetcher }).createPairingQr())
      .rejects.toThrow("Quit and reopen Orbit Desktop to restart the server with current pairing support");
    expect(fetcher).toHaveBeenCalledWith(expect.stringContaining("/api/client-auth/pairing/sessions/pair_old"), expect.objectContaining({ method: "DELETE" }));
  });
});
