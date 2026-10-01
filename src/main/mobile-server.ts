import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, openSync, closeSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

/**
 * Attaches the Orbit mobile server to the desktop app's lifecycle.
 *
 * While Orbit is open the mobile server (OpenCode backend + Orbit web server)
 * runs, so the Orbit mobile app can connect remotely. When Orbit quits —
 * or is force-killed — the server stops.
 *
 * Development checks the sibling `orbit-mobile` checkout first. Packaged installs
 * then check `~/code-repositories/orbit-mobile` and the historical
 * `~/coding-projects/orbit-mobile` location; `ORBIT_MOBILE_HOME` can select another checkout.
 */

const DEFAULT_MOBILE_HOMES = [
  path.join(homedir(), "code-repositories", "orbit-mobile"),
  path.join(homedir(), "coding-projects", "orbit-mobile"),
];
const DEFAULT_MOBILE_HOME = DEFAULT_MOBILE_HOMES[1];
const SUPPORT = path.join(homedir(), "Library", "Application Support", "OrbitMobile");
const DEFAULT_SERVER_PORT = 3011;
const MOBILE_SERVER_START_TIMEOUT_MS = 20_000;
const MOBILE_SERVER_PROBE_TIMEOUT_MS = 1_500;
const MOBILE_PAIRING_REQUEST_TIMEOUT_MS = 5_000;

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;

export interface MobileServerStatus {
  state: "ready" | "starting" | "offline" | "setup-required";
  reason?: "companion-checkout-missing" | "node-runtime-missing" | "server-not-running";
  workspacePath: string;
  port: number;
}

export interface MobilePairingQr {
  connectionUrl: string;
  expiresAt: string;
  serverLabel: string;
}

interface DesktopServiceStatus {
  pid?: number;
  port?: number;
  password?: string;
}

interface MobileServerDependencies {
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  supportDirectory?: string;
  exists?: (candidate: string) => boolean;
  readTextFile?: (candidate: string) => string;
  fetcher?: typeof fetch;
}

const resolveMobileHome = (
  env: NodeJS.ProcessEnv,
  cwd: string,
  exists: (candidate: string) => boolean,
): { home: string | null; expectedHome: string } => {
  const override = env["ORBIT_MOBILE_HOME"]?.trim();
  if (override) {
    const home = path.resolve(cwd, override);
    return { home: exists(path.join(home, "scripts", "desktop-service.mjs")) ? home : null, expectedHome: home };
  }

  const candidates = [
    path.resolve(cwd, "..", "orbit-mobile"),
    ...DEFAULT_MOBILE_HOMES,
  ];
  for (const home of [...new Set(candidates)]) {
    if (exists(path.join(home, "scripts", "desktop-service.mjs"))) return { home, expectedHome: home };
  }
  return { home: null, expectedHome: DEFAULT_MOBILE_HOME };
};

const resolveNode = (
  env: NodeJS.ProcessEnv,
  exists: (candidate: string) => boolean,
): string | null => {
  const explicit = env["ORBIT_NODE_BIN"];
  if (explicit && exists(explicit)) return explicit;
  const candidates = [
    path.join(homedir(), ".local", "bin", "node"),
    "/opt/homebrew/bin/node",
    "/usr/local/bin/node"
  ];
  for (const candidate of candidates) if (exists(candidate)) return candidate;
  try {
    const which = spawnSync("which", ["node"], { encoding: "utf8" });
    const found = (which.stdout || "").trim();
    if (found && exists(found)) return found;
  } catch {
    // fall through
  }
  return null;
};

export interface MobileBackend {
  url: string;
  username: string;
  password: string;
}

export class MobileServer {
  private child: ChildProcess | null = null;
  private readonly env: NodeJS.ProcessEnv;
  private readonly home: string | null;
  private readonly expectedHome: string;
  private readonly node: string | null;
  private readonly statusFile: string;
  private readonly readTextFile: (candidate: string) => string;
  private readonly fetcher: typeof fetch;

  constructor(dependencies: MobileServerDependencies = {}) {
    this.env = dependencies.env ?? process.env;
    const cwd = dependencies.cwd ?? process.cwd();
    const exists = dependencies.exists ?? existsSync;
    const resolvedHome = resolveMobileHome(this.env, cwd, exists);
    this.home = resolvedHome.home;
    this.expectedHome = resolvedHome.expectedHome;
    this.node = resolveNode(this.env, exists);
    this.statusFile = path.join(dependencies.supportDirectory ?? SUPPORT, "run", "desktop-status.json");
    this.readTextFile = dependencies.readTextFile ?? ((candidate) => readFileSync(candidate, "utf8"));
    this.fetcher = dependencies.fetcher ?? globalThis.fetch.bind(globalThis);
  }

  available(): boolean {
    return Boolean(this.home && this.node);
  }

  async getSetupStatus(): Promise<MobileServerStatus> {
    const port = this.serviceStatus()?.port ?? this.configuredPort();
    if (!this.home) {
      return { state: "setup-required", reason: "companion-checkout-missing", workspacePath: this.expectedHome, port };
    }
    if (!this.node) {
      return { state: "setup-required", reason: "node-runtime-missing", workspacePath: this.home, port };
    }
    const service = this.serviceStatus();
    if (service && await this.isHealthy(service.port ?? port)) {
      return { state: "ready", workspacePath: this.home, port: service.port ?? port };
    }
    return {
      state: this.child && this.child.exitCode === null ? "starting" : "offline",
      reason: "server-not-running",
      workspacePath: this.home,
      port,
    };
  }

  /** Create a short-lived pairing URI using the server's existing owner-authenticated API. */
  async createPairingQr(): Promise<MobilePairingQr> {
    if (!this.home) {
      throw new Error(`Orbit Mobile companion checkout was not found. Expected it at ${this.expectedHome}; set ORBIT_MOBILE_HOME to its folder and restart Orbit.`);
    }
    if (!this.node) {
      throw new Error("Node.js was not found. Install Node 22 or set ORBIT_NODE_BIN, then restart Orbit.");
    }

    const service = await this.waitForService();
    const baseUrl = `http://127.0.0.1:${service.port}`;
    const cookie = await this.createSessionCookie(baseUrl, service.password);
    const transports = await this.requestJson(`${baseUrl}/api/client-auth/pairing/transports`, {
      headers: { Accept: "application/json", Cookie: cookie },
      signal: AbortSignal.timeout(MOBILE_PAIRING_REQUEST_TIMEOUT_MS),
    });
    const lanUrl = typeof transports.lan === "string" && transports.lan.trim() ? transports.lan.trim() : null;
    const pairing = await this.requestJson(`${baseUrl}/api/client-auth/pairing/sessions`, {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({
        allowedClientKinds: ["mobile"],
        ...(lanUrl ? { serverUrl: lanUrl } : {}),
        includeDirect: Boolean(lanUrl),
        includeRelay: true,
      }),
      signal: AbortSignal.timeout(MOBILE_PAIRING_REQUEST_TIMEOUT_MS),
    });

    const pairingRecord = asRecord(pairing.pairing);
    const serverRecord = asRecord(pairing.server);
    if (typeof pairing.connectionUrl !== "string" || !pairing.connectionUrl.startsWith("orbit://connect?")) {
      if (pairingRecord && Array.isArray(serverRecord?.candidates)) {
        if (typeof pairingRecord.id === "string") {
          await this.cancelPairingSession(baseUrl, cookie, pairingRecord.id);
        }
        throw new Error("Orbit Mobile's companion server is out of date. Quit and reopen Orbit Desktop to restart the server with current pairing support.");
      }
      throw new Error(typeof pairing.error === "string" ? pairing.error : "Orbit could not create a mobile pairing QR. Check that this Mac and phone have a reachable network route.");
    }
    const expiresAt = pairingRecord?.expiresAt;
    if (typeof expiresAt !== "string" || !Number.isFinite(Date.parse(expiresAt))) {
      throw new Error("Orbit created an invalid pairing expiry. Update the Orbit Mobile companion and try again.");
    }
    return {
      connectionUrl: pairing.connectionUrl,
      expiresAt,
      serverLabel: typeof serverRecord?.label === "string" ? serverRecord.label : "Orbit Desktop",
    };
  }

  private configuredPort(): number {
    const configured = Number(this.env["ORBIT_PORT"] || DEFAULT_SERVER_PORT);
    return Number.isInteger(configured) && configured > 0 && configured <= 65535 ? configured : DEFAULT_SERVER_PORT;
  }

  private serviceStatus(): DesktopServiceStatus | null {
    try {
      const value = JSON.parse(this.readTextFile(this.statusFile)) as DesktopServiceStatus;
      const port = Number(value.port);
      if (!Number.isInteger(port) || port < 1 || port > 65535 || typeof value.password !== "string" || !value.password) return null;
      return { ...value, port };
    } catch {
      return null;
    }
  }

  private async requestJson(url: string, init: RequestInit): Promise<Record<string, unknown>> {
    const response = await this.fetcher(url, init);
    const payload = asRecord(await response.json().catch(() => null));
    if (!response.ok || !payload) {
      const message = typeof payload?.error === "string" ? payload.error : `Mobile server request failed (${response.status})`;
      throw new Error(message);
    }
    return payload;
  }

  private async cancelPairingSession(baseUrl: string, cookie: string, pairingId: string): Promise<void> {
    await this.fetcher(`${baseUrl}/api/client-auth/pairing/sessions/${encodeURIComponent(pairingId)}`, {
      method: "DELETE",
      headers: { Accept: "application/json", Cookie: cookie },
      signal: AbortSignal.timeout(MOBILE_PAIRING_REQUEST_TIMEOUT_MS),
    }).catch(() => undefined);
  }

  private async isHealthy(port: number): Promise<boolean> {
    try {
      const response = await this.fetcher(`http://127.0.0.1:${port}/health`, {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(MOBILE_SERVER_PROBE_TIMEOUT_MS),
      });
      const body = await response.json().catch(() => null) as { status?: unknown } | null;
      return response.ok && body?.status === "ok";
    } catch {
      return false;
    }
  }

  private async waitForService(): Promise<{ port: number; password: string }> {
    const deadline = Date.now() + MOBILE_SERVER_START_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const status = this.serviceStatus();
      if (status?.port && status.password && await this.isHealthy(status.port)) {
        return { port: status.port, password: status.password };
      }
      if (!this.child && status === null) break;
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
    const status = await this.getSetupStatus();
    if (status.state === "setup-required") {
      throw new Error(status.reason === "node-runtime-missing"
        ? "Node.js was not found. Install Node 22 or set ORBIT_NODE_BIN, then restart Orbit."
        : `Orbit Mobile companion checkout was not found. Expected it at ${status.workspacePath}; set ORBIT_MOBILE_HOME to its folder and restart Orbit.`);
    }
    throw new Error("Orbit's mobile server is not ready yet. Keep Orbit open, wait a few seconds, and try again.");
  }

  private async createSessionCookie(baseUrl: string, password: string): Promise<string> {
    const response = await this.fetcher(`${baseUrl}/auth/session`, {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({ password }),
      signal: AbortSignal.timeout(MOBILE_PAIRING_REQUEST_TIMEOUT_MS),
    });
    const payload = await response.json().catch(() => null) as { authenticated?: unknown; error?: unknown } | null;
    const setCookie = response.headers.get("set-cookie") ?? "";
    const cookie = setCookie.split(";", 1)[0]?.trim() ?? "";
    if (!response.ok || payload?.authenticated !== true || !cookie.includes("=")) {
      throw new Error(typeof payload?.error === "string" ? payload.error : "Orbit could not authenticate with its local mobile server. Restart Orbit and try again.");
    }
    return cookie;
  }

  start(backend?: MobileBackend): void {
    if (!this.available() || this.child) return;
    const script = path.join(this.home as string, "scripts", "desktop-service.mjs");
    mkdirSync(path.join(SUPPORT, "logs"), { recursive: true });
    const out = openSync(path.join(SUPPORT, "logs", "desktop-service.out.log"), "a");
    const err = openSync(path.join(SUPPORT, "logs", "desktop-service.err.log"), "a");
    // When the desktop daemon endpoint is known, point the mobile server at it
    // (ORBIT_EXTERNAL_BACKEND) so sessions are shared with the desktop. Without
    // it, the agent falls back to its own isolated backend.
    const backendEnv: Record<string, string> = backend
      ? {
          ORBIT_EXTERNAL_BACKEND: "1",
          OPENCODE_HOST: backend.url,
          OPENCODE_SERVER_USERNAME: backend.username,
          OPENCODE_SERVER_PASSWORD: backend.password
        }
      : {};
    try {
      this.child = spawn(this.node as string, [script, "--parent-pid", String(process.pid)], {
        cwd: this.home as string,
        env: { ...process.env, HOME: homedir(), ...backendEnv },
        stdio: ["ignore", out, err]
      });
      this.child.on("exit", () => {
        this.child = null;
      });
    } catch (error) {
      console.error("[mobile-server] failed to start:", error);
    } finally {
      closeSync(out);
      closeSync(err);
    }
  }

  async stop(): Promise<void> {
    const child = this.child;
    if (!child) return;
    this.child = null;
    await new Promise<void>((resolve) => {
      const done = (): void => resolve();
      child.once("exit", done);
      try {
        child.kill("SIGTERM");
      } catch {
        done();
        return;
      }
      setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          // already gone
        }
        done();
      }, 4000);
    });
  }
}
