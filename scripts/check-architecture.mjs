#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import { builtinModules } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { analyzeRepository, dependencyCycles, sourceCategory } from "./architecture-analysis.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const configurationPath = path.join(root, "scripts/architecture-baseline.json");
const builtins = new Set(builtinModules.flatMap((name) => [name, `node:${name}`]));
const metrics = ["codeLines", "cyclomatic", "nesting"];
const functionKey = (fn) => `${fn.file}:${fn.identity}`;
const edgeKey = (edge) => `${edge.from}>${edge.to}:${edge.typeOnly ? "type" : "value"}`;
const cloneKey = (group) => group.hash;

function cycleKey(component, edges) {
  const members = new Set(component);
  return [...new Set(edges.filter((edge) => members.has(edge.from) && members.has(edge.to)).map(edgeKey))].sort().join("|");
}

function matchesFile(file, rule) {
  return rule.file ? file === rule.file : file.startsWith(rule.prefix);
}

function matchesPath(file, prefix) {
  return /\.(?:[cm]?[jt]sx?|css|scss)$/.test(prefix) ? file === prefix : file.startsWith(prefix);
}

function matchesExternal(specifier, allowed) {
  return /[:/]$/.test(allowed) ? specifier.startsWith(allowed) : specifier === allowed;
}

export function architectureViolations(report, configuration) {
  const violations = [];
  const add = (rule, subject, detail) => violations.push({ rule, subject, detail });
  for (const section of ["modules", "functions", "functionExceptions"]) {
    for (const [subject, allowance] of Object.entries(configuration[section])) {
      if (typeof allowance.reason !== "string" || !allowance.reason.trim()) add("exception-rationale", subject, `${section} allowance needs a specific rationale`);
    }
  }
  for (const section of ["edgeExceptions", "cycleExceptions"]) {
    for (const allowance of configuration[section]) {
      if (typeof allowance.reason !== "string" || !allowance.reason.trim()) add("exception-rationale", section, "Allowance needs a specific rationale");
    }
  }
  const fileSet = new Set(report.production.inventory.map((file) => file.path));
  for (const reference of report.ipcReferences ?? []) {
    if (reference.file !== "src/main/index.ts") add("ipc-authority", `${reference.file}:${reference.line}`, reference.kind);
  }
  for (const file of report.production.inventory) {
    const limit = configuration.modules[file.path]?.loc ?? configuration.limits.module;
    if (file.loc > limit) add("module-size", file.path, `${file.loc} code lines exceeds ${limit}`);
    if (!configuration.knownFiles.includes(file.path) && /(?:^|\/)(?:helpers?|utils?|misc|common)(?:\.[^/]+)?(?:\/|$)/.test(file.path)) {
      add("ownership-name", file.path, "Use the owning feature or responsibility in the filename");
    }
  }
  for (const fn of report.functions) {
    const identity = functionKey(fn);
    const budget = configuration.functions[identity] ?? configuration.functionExceptions[identity];
    for (const metric of metrics) {
      const limit = budget?.[metric] ?? configuration.limits[metric];
      if (fn[metric] > limit) add(`function-${metric}`, identity, `${fn[metric]} exceeds ${limit}`);
    }
  }
  for (const edge of report.dependencies) {
    const exception = configuration.edgeExceptions.find((entry) => entry.from === edge.from && entry.to === edge.to && entry.typeOnly === edge.typeOnly);
    if (exception) continue;
    if (!fileSet.has(edge.to) && sourceCategory(edge.to) !== "pinned-upstream-styles") add("production-scope", edge.from, `Production cannot depend on excluded implementation ${edge.to}`);
    if (report.forbiddenEdges.some((forbidden) => edgeKey(forbidden) === edgeKey(edge))) add("layer-direction", edge.from, edgeKey(edge));
    for (const boundary of configuration.privateBoundaries) {
      if (!matchesPath(edge.to, boundary.targetPrefix)) continue;
      if (!boundary.allowedFrom.some((prefix) => matchesPath(edge.from, prefix))) add("private-owner", edge.from, `${edge.to} belongs to ${boundary.owner}`);
    }
    for (const owner of configuration.pureOwners) {
      if (matchesFile(edge.from, owner) && !owner.allowedLocal.some((prefix) => matchesPath(edge.to, prefix))) add("pure-owner", edge.from, `Cannot depend on ${edge.to}`);
    }
  }
  for (const imported of report.externalImports ?? []) {
    const privileged = builtins.has(imported.specifier) || imported.specifier.startsWith("node:") || ["electron", "electron-updater", "node-pty"].includes(imported.specifier.split("/")[0]);
    if (privileged && (imported.file.startsWith("src/renderer/") || imported.file.startsWith("src/shared/"))) add("privileged-import", imported.file, imported.specifier);
    if ((imported.specifier === "@opencode/client" || imported.specifier.startsWith("@opencode/client/")) && imported.file !== "src/main/opencode.ts") add("sdk-owner", imported.file, "OpenCode SDK belongs to src/main/opencode.ts");
    for (const owner of configuration.pureOwners) {
      if (matchesFile(imported.file, owner) && !owner.allowedExternal.some((prefix) => matchesExternal(imported.specifier, prefix))) add("pure-owner", imported.file, `Cannot depend on ${imported.specifier}`);
    }
  }
  for (const mode of ["valueImports", "includingTypeOnly"]) {
    const edges = mode === "valueImports" ? report.dependencies.filter((edge) => !edge.typeOnly) : report.dependencies;
    for (const component of dependencyCycles([...fileSet], edges, true)) {
      const key = cycleKey(component, edges);
      if (!configuration.cycleExceptions.some((entry) => entry.mode === mode && entry.key === key)) add("dependency-cycle", component.join(", "), mode);
    }
  }
  for (const kind of ["functions", "blocks"]) {
    for (const group of report.duplication[kind]) {
      const prior = configuration.duplicates[kind][cloneKey(group)] ?? 1;
      if (group.instances.length > prior) add("new-duplication", group.instances.map((entry) => entry.file).join(", "), `${kind}: ${group.instances.length} copies of ${group.codeLines} lines exceeds ${prior}`);
    }
  }
  return violations;
}

export function ratchetConfiguration(report, configuration) {
  const violations = architectureViolations(report, configuration);
  if (violations.length > 0) throw new Error("Cannot ratchet a failing architecture check");
  const next = structuredClone(configuration);
  const currentFiles = new Map(report.production.inventory.map((file) => [file.path, file]));
  const currentFunctions = new Map(report.functions.map((fn) => [functionKey(fn), fn]));
  for (const [file, budget] of Object.entries(next.modules)) {
    const current = currentFiles.get(file);
    if (!current || current.loc <= next.limits.module) delete next.modules[file];
    else budget.loc = Math.min(budget.loc, current.loc);
  }
  for (const section of ["functions", "functionExceptions"]) {
    for (const [identity, budget] of Object.entries(next[section])) {
      const current = currentFunctions.get(identity);
      if (!current || metrics.every((metric) => current[metric] <= next.limits[metric])) { delete next[section][identity]; continue; }
      for (const metric of metrics) budget[metric] = Math.min(budget[metric] ?? next.limits[metric], Math.max(next.limits[metric], current[metric]));
    }
  }
  next.knownFiles = [...currentFiles.keys()].sort();
  for (const kind of ["functions", "blocks"]) {
    const current = new Map(report.duplication[kind].map((group) => [cloneKey(group), group.instances.length]));
    for (const key of Object.keys(next.duplicates[kind])) {
      if (!current.has(key)) delete next.duplicates[kind][key];
      else next.duplicates[kind][key] = Math.min(next.duplicates[kind][key], current.get(key));
    }
  }
  next.cycleExceptions = next.cycleExceptions.filter((exception) => {
    const edges = exception.mode === "valueImports" ? report.dependencies.filter((edge) => !edge.typeOnly) : report.dependencies;
    return dependencyCycles([...currentFiles.keys()], edges, true).some((component) => cycleKey(component, edges) === exception.key);
  });
  return next;
}

async function main() {
  const configuration = JSON.parse(await readFile(configurationPath, "utf8"));
  const report = await analyzeRepository(root, { fast: true });
  const violations = architectureViolations(report, configuration);
  if (violations.length > 0) {
    console.error(`architecture check failed (${violations.length} violations)`);
    for (const violation of violations) console.error(`  ${violation.rule}: ${violation.subject}: ${violation.detail}`);
    process.exitCode = 1;
    return;
  }
  if (process.argv.includes("--ratchet")) {
    await writeFile(configurationPath, JSON.stringify(ratchetConfiguration(report, configuration), null, 2) + "\n");
    console.log("Architecture budgets ratcheted downward; review and commit the configuration diff.");
  } else console.log(`Architecture check passed: ${report.production.files} production files; budgets, boundaries, cycles, exact duplication.`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
