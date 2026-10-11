import { describe, expect, it } from "vitest";
import ts from "typescript";
import { functionIdentity } from "./architecture-analysis.mjs";
import { architectureViolations, ratchetConfiguration } from "./check-architecture.mjs";

const configuration = () => ({
  limits: { module: 800, codeLines: 100, cyclomatic: 20, nesting: 5 }, knownFiles: [], modules: {}, functions: {}, functionExceptions: {},
  edgeExceptions: [], cycleExceptions: [], duplicates: { functions: {}, blocks: {} },
  privateBoundaries: [{ targetPrefix: "src/main/runtimes/deepseek/", owner: "dormant runtime", allowedFrom: ["src/main/runtimes/deepseek/"] }],
  pureOwners: [{ file: "src/main/session-replay.ts", allowedLocal: ["src/shared/"], allowedExternal: [] }]
});
const report = () => ({ production: { files: 0, inventory: [] }, functions: [], dependencies: [], forbiddenEdges: [], externalImports: [], duplication: { functions: [], blocks: [] } });
const checked = (value: any, config = configuration()) => architectureViolations(value, config).map((entry: any) => entry.rule);

describe("architecture fitness checks", () => {
  it("fails new oversized modules and functions, nesting and complexity", () => {
    const value = report() as any;
    value.production.inventory.push({ path: "src/main/new.ts", loc: 801 });
    value.functions.push({ file: "src/main/new.ts", identity: "run#1", codeLines: 101, cyclomatic: 21, nesting: 6 });
    expect(checked(value)).toEqual(["module-size", "function-codeLines", "function-cyclomatic", "function-nesting"]);
  });

  it("does not transfer an old function budget to renamed or moved functions", () => {
    const config = configuration() as any;
    config.functions["src/main/old.ts:run#1"] = { codeLines: 200, cyclomatic: 30, nesting: 6, reason: "Existing frozen debt" };
    const value = report() as any;
    value.functions.push({ file: "src/main/old.ts", identity: "renamed#1", codeLines: 150, cyclomatic: 1, nesting: 0 },
      { file: "src/main/new.ts", identity: "run#1", codeLines: 150, cyclomatic: 1, nesting: 0 });
    expect(checked(value, config)).toEqual(["function-codeLines", "function-codeLines"]);
  });

  it("removes deleted function allowances and only ratchets limits downward", () => {
    const config = configuration() as any;
    config.functions["src/main/old.ts:run#1"] = { codeLines: 200, cyclomatic: 30, nesting: 6, reason: "Existing frozen debt" };
    config.modules["src/main/old.ts"] = { loc: 900, reason: "Existing debt" };
    const value = report() as any;
    value.production.inventory.push({ path: "src/main/old.ts", loc: 850 });
    const tightened = ratchetConfiguration(value, config);
    expect(tightened.functions).toEqual({});
    expect(tightened.modules["src/main/old.ts"].loc).toBe(850);
    value.production.inventory[0].loc = 901;
    expect(() => ratchetConfiguration(value, config)).toThrow("Cannot ratchet");
  });

  it("keeps function identities stable when comments or preceding lines move", () => {
    const identity = (text: string) => {
      const source = ts.createSourceFile("x.ts", text, ts.ScriptTarget.Latest, true);
      return functionIdentity(source.statements.find(ts.isFunctionDeclaration)!, source);
    };
    expect(identity("function work() { return 1; }")).toBe(identity("// new comment\n\nfunction work() { return 1; }"));
    expect(identity("function changed() { return 1; }")).not.toBe(identity("function work() { return 1; }"));
  });

  it("rejects forbidden layers, private implementation imports and privileged renderer dependencies", () => {
    const value = report() as any;
    value.production.inventory.push({ path: "src/main/runtimes/deepseek/private.ts", loc: 1 });
    const edge = { from: "src/renderer/src/panel.ts", to: "src/main/runtimes/deepseek/private.ts", typeOnly: false };
    value.dependencies.push(edge); value.forbiddenEdges.push(edge);
    value.externalImports.push({ file: "src/renderer/src/panel.ts", specifier: "node:fs", typeOnly: false },
      { file: "src/main/other.ts", specifier: "@opencode/client", typeOnly: true });
    expect(checked(value)).toEqual(["layer-direction", "private-owner", "privileged-import", "sdk-owner"]);
  });

  it("allows only the narrow declaration bridge exception", () => {
    const config = configuration() as any;
    config.edgeExceptions.push({ from: "src/renderer/src/global.d.ts", to: "src/preload/index.ts", typeOnly: true, reason: "Bridge declaration" });
    const value = report() as any;
    value.production.inventory.push({ path: "src/preload/index.ts", loc: 1 });
    const edge = { from: "src/renderer/src/global.d.ts", to: "src/preload/index.ts", typeOnly: true };
    value.dependencies.push(edge); value.forbiddenEdges.push(edge);
    expect(checked(value, config)).toEqual([]);
    value.dependencies[0] = { ...edge, typeOnly: false }; value.forbiddenEdges[0] = value.dependencies[0];
    expect(checked(value, config)).toEqual(["layer-direction"]);
  });

  it("fails value and type-only cycles and substantially duplicated exact bodies", () => {
    const value = report() as any;
    value.production.inventory.push({ path: "src/main/a.ts", loc: 10 }, { path: "src/main/b.ts", loc: 10 });
    value.dependencies.push({ from: "src/main/a.ts", to: "src/main/b.ts", typeOnly: false }, { from: "src/main/b.ts", to: "src/main/a.ts", typeOnly: true });
    value.duplication.functions.push({ hash: "clone", codeLines: 30, instances: [{ file: "src/main/a.ts" }, { file: "src/main/b.ts" }] });
    expect(checked(value)).toEqual(["dependency-cycle", "new-duplication"]);
    value.dependencies[1].typeOnly = false;
    expect(checked(value)).toEqual(["dependency-cycle", "dependency-cycle", "new-duplication"]);
  });

  it("rejects dependency leakage from pure replay and generic ownership-free names", () => {
    const value = report() as any;
    value.production.inventory.push({ path: "src/main/helpers.ts", loc: 10 }, { path: "src/main/opencode.ts", loc: 10 });
    value.dependencies.push({ from: "src/main/session-replay.ts", to: "src/main/opencode.ts", typeOnly: true });
    value.externalImports.push({ file: "src/main/session-replay.ts", specifier: "electron", typeOnly: false });
    expect(checked(value)).toEqual(["ownership-name", "pure-owner", "pure-owner"]);
  });

  it("rejects excluded implementation imports rather than permitting metric-scope leaks", () => {
    const value = report() as any;
    value.production.inventory.push({ path: "src/main/service.ts", loc: 10 });
    value.dependencies.push({ from: "src/main/service.ts", to: "src/main/fixtures/implementation.ts", typeOnly: false },
      { from: "src/main/service.ts", to: "scripts/implementation.ts", typeOnly: false },
      { from: "src/main/service.ts", to: "src/renderer/src/styles/opencode/theme.scss", typeOnly: false });
    expect(checked(value)).toEqual(["production-scope", "production-scope"]);
  });

  it("does not grant private-file access through a filename prefix or generic folder", () => {
    const config = configuration() as any;
    config.privateBoundaries.push({ targetPrefix: "src/main/private.ts", owner: "service", allowedFrom: ["src/main/public.ts"] });
    const value = report() as any;
    value.production.inventory.push({ path: "src/main/utils/new.ts", loc: 10 }, { path: "src/main/private.ts", loc: 10 });
    value.dependencies.push({ from: "src/main/public.ts.extra.ts", to: "src/main/private.ts", typeOnly: false });
    expect(checked(value, config)).toEqual(["ownership-name", "private-owner"]);
  });

  it("cannot retain an old cycle exception when edges inside its component change", () => {
    const config = configuration() as any;
    const value = report() as any;
    value.production.inventory.push({ path: "src/main/a.ts", loc: 10 }, { path: "src/main/b.ts", loc: 10 });
    value.dependencies.push({ from: "src/main/a.ts", to: "src/main/b.ts", typeOnly: false }, { from: "src/main/b.ts", to: "src/main/a.ts", typeOnly: false });
    const key = "src/main/a.ts>src/main/b.ts:value|src/main/b.ts>src/main/a.ts:value";
    config.cycleExceptions.push({ mode: "valueImports", key, reason: "Reviewed cycle" }, { mode: "includingTypeOnly", key, reason: "Reviewed cycle" });
    expect(checked(value, config)).toEqual([]);
    value.dependencies.push({ from: "src/main/a.ts", to: "src/main/b.ts", typeOnly: true });
    expect(checked(value, config)).toEqual(["dependency-cycle"]);
  });

  it("ratchets removed duplication and cycles without blessing new clones", () => {
    const config = configuration() as any;
    config.duplicates.functions.clone = 3;
    config.cycleExceptions.push({ mode: "valueImports", key: "gone", reason: "Existing cycle" });
    const value = report() as any;
    value.duplication.functions.push({ hash: "clone", codeLines: 30, instances: [{ file: "a" }, { file: "b" }] });
    const tightened = ratchetConfiguration(value, config);
    expect(tightened.duplicates.functions.clone).toBe(2);
    expect(tightened.cycleExceptions).toEqual([]);
    value.duplication.functions[0].instances.push({ file: "c" });
    expect(() => ratchetConfiguration(value, tightened)).toThrow("Cannot ratchet");
  });

  it("keeps raw IPC authority in the central sender validation owner", () => {
    const value = report() as any;
    value.ipcReferences = [{ file: "src/main/index.ts", line: 1, kind: "raw-ipc" },
      { file: "src/main/service.ts", line: 1, kind: "raw-ipc" }, { file: "src/main/ipc/agent.ts", line: 1, kind: "ipc-domain-electron-import" }];
    expect(checked(value)).toEqual(["ipc-authority", "ipc-authority"]);
  });

  it("fails undocumented debt and dependency exceptions", () => {
    const config = configuration() as any;
    config.modules["src/main/old.ts"] = { loc: 900 };
    config.functionExceptions["src/main/old.ts:run#1"] = { codeLines: 200 };
    config.edgeExceptions.push({ from: "a", to: "b", typeOnly: true });
    expect(checked(report(), config)).toEqual(["exception-rationale", "exception-rationale", "exception-rationale"]);
  });

  it("does not permit React DOM or store imports in a React-only interaction owner", () => {
    const config = configuration() as any;
    config.pureOwners.push({ file: "src/renderer/src/layout/panel-interactions.ts", allowedLocal: [], allowedExternal: ["react"] });
    const value = report() as any;
    value.production.inventory.push({ path: "src/renderer/src/store.tsx", loc: 10 });
    value.dependencies.push({ from: "src/renderer/src/layout/panel-interactions.ts", to: "src/renderer/src/store.tsx", typeOnly: false });
    value.externalImports.push({ file: "src/renderer/src/layout/panel-interactions.ts", specifier: "react", typeOnly: false },
      { file: "src/renderer/src/layout/panel-interactions.ts", specifier: "react-dom", typeOnly: false });
    expect(checked(value, config)).toEqual(["pure-owner", "pure-owner"]);
  });
});
