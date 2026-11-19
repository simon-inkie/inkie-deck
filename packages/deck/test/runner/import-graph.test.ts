import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { expect, it } from "vitest";

const deck = fileURLToPath(new URL("../../", import.meta.url));
const fixtures = join("test", "runner") + sep;
const runner = join("app", "lib", "runner");
const core = join(runner, "runner.ts");
const pty = join(runner, "pty-runner.server.ts");
const registry = join(runner, "registry.server.ts");
const sourceFile = /\.[cm]?[jt]sx?$/;
const compilerOptions = ts.getParsedCommandLineOfConfigFile(join(deck, "tsconfig.json"), {}, {
  ...ts.sys,
  onUnRecoverableConfigFileDiagnostic: (error) => { throw new Error(String(error.messageText)); },
})!.options;

it("isolates the promoted runner and keeps its fixtures out of production", () => {
  const roots = [
    ...["app", "server", "scripts"].flatMap((directory) =>
      readdirSync(join(deck, directory), { recursive: true, encoding: "utf8" })
        .filter((file) => sourceFile.test(file)).map((file) => join(deck, directory, file))),
    join(deck, "vite.config.ts"), join(deck, "react-router.config.ts"),
  ];
  const visited = new Set<string>();
  const violations: string[] = [];
  const cache = ts.createModuleResolutionCache(deck, (file) => file, compilerOptions);

  function scan(file: string): void {
    if (visited.has(file)) return;
    visited.add(file);
    const importer = relative(deck, file);
    const source = readFileSync(file, "utf8");
    for (const { fileName } of ts.preProcessFile(source, true, true).importedFiles) {
      const resolved = ts.resolveModuleName(fileName, file, compilerOptions, ts.sys, cache).resolvedModule;
      const dependency = resolved?.resolvedFileName;
      const target = dependency && relative(deck, dependency);
      if ((/^node-pty(?:\/|$)/.test(fileName) && importer !== pty) || target?.startsWith(fixtures) ||
        target === registry || (target === pty && importer !== registry) ||
        (target === core && importer !== pty && importer !== registry)) {
        violations.push(`${importer} -> ${fileName}`);
      } else if (dependency && !resolved.isExternalLibraryImport && sourceFile.test(dependency)) {
        scan(dependency);
      }
    }
  }

  roots.forEach(scan);
  expect(violations).toEqual([]);
});
