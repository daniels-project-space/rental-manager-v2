import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import ts from "typescript";

export const MANIFEST = "deployment-inputs.json";
const normalize = value => value.split(path.sep).join("/");
export const isTest = file => /(?:^|\/)__tests__\//.test(file) || /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(file);
export const isNonRuntime = file => isTest(file) || /^(?:docs|graphify-out|\.serena|\.agents|\.codex|coverage|\.github)\//.test(file) || /(?:^|\/)(?:README|AGENTS)\.md$/.test(file);
const source = file => /\.[cm]?[jt]sx?$/.test(file) && !file.endsWith(".d.ts");
const workerRoot = file => file.startsWith("src/trigger/") && source(file) && !isTest(file);
const backendRoot = file => file.startsWith("convex/") && source(file) && !isTest(file);
const specialFiles = new Set(["package.json", "pnpm-lock.yaml", "tsconfig.json", ".npmrc", "pnpm-workspace.yaml", "scripts/deployment-inputs.mjs", "scripts/deployment-impact.mjs"]);

/** Derive this repository's boundaries; no hand-maintained list of worker
 * helpers. Type-only imports are checked by CI, and do not emit website code. */
export function createManifest(root = process.cwd()) {
  const files = execFileSync("git", ["ls-files", "-z"], { cwd: root }).toString().split("\0").filter(Boolean);
  const tracked = new Set(files);
  const config = ts.readConfigFile(path.join(root, "tsconfig.json"), ts.sys.readFile);
  if (config.error) throw Error("Cannot read deployment dependency configuration");
  const options = ts.parseJsonConfigFileContent(config.config, ts.sys, root).options;
  function closure(seeds) {
    const visited = new Set(), uncertain = new Set(), pending = [...seeds];
    while (pending.length) {
      const file = pending.pop();
      if (visited.has(file)) continue;
      visited.add(file);
      const filename = path.join(root, file);
      if (!source(file)) continue;
      // Trace emitted imports, matching isolated compilation. Older modules
      // legitimately write `import { Doc }` without `type`; TypeScript erases
      // these imports when their bindings occur only in type positions.
      const emitted = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
        fileName: filename,
        compilerOptions: { ...options, noEmit: false, module: ts.ModuleKind.ESNext, sourceMap: false, inlineSourceMap: false, declaration: false, declarationMap: false },
      }).outputText;
      const ast = ts.createSourceFile(filename, emitted, ts.ScriptTarget.Latest, true);
      if (ast.parseDiagnostics.length) uncertain.add(`${file}: parse error`);
      function dependency(specifier) {
        if (specifier.startsWith("node:")) return;
        const resolved = ts.resolveModuleName(specifier, filename, options, ts.sys).resolvedModule;
        if (!resolved) {
          // CSS/assets are included as website inputs without parsing as TS.
          if (/\.(?:css|svg|png|jpe?g|webp|woff2?|ttf|mp[34])$/.test(specifier)) return;
          if (specifier.startsWith(".") || specifier.startsWith("@/")) uncertain.add(`${file}: unresolved ${specifier}`);
          return;
        }
        let absolute = resolved.resolvedFileName;
        if (absolute.includes(`${path.sep}node_modules${path.sep}`)) return;
        // Convex provides runtime JS alongside its type declarations. Following
        // the .d.ts instead would falsely make every backend module a UI input.
        if (absolute.endsWith(".d.ts")) {
          const runtime = absolute.slice(0, -5) + ".js";
          if (!fs.existsSync(runtime)) {
            uncertain.add(`${file}: runtime implementation unavailable for ${specifier}`);
            return;
          }
          absolute = runtime;
        }
        if (!absolute.startsWith(root + path.sep)) {
          uncertain.add(`${file}: dependency escapes repository`); return;
        }
        const next = normalize(path.relative(root, absolute));
        if (!tracked.has(next)) {
          uncertain.add(`${file}: untracked runtime dependency ${next}`); return;
        }
        pending.push(next);
      }
      function visit(node) {
        if (ts.isImportDeclaration(node)) {
          const clause = node.importClause, bindings = clause?.namedBindings;
          const onlyTypes = clause?.isTypeOnly || (!clause?.name && bindings && ts.isNamedImports(bindings) && bindings.elements.every(element => element.isTypeOnly));
          if (!onlyTypes) dependency(node.moduleSpecifier.text);
        }
        if (ts.isExportDeclaration(node) && node.moduleSpecifier && !node.isTypeOnly) {
          const onlyTypes = node.exportClause && ts.isNamedExports(node.exportClause) && node.exportClause.elements.every(element => element.isTypeOnly);
          if (!onlyTypes) dependency(node.moduleSpecifier.text);
        }
        if (ts.isImportEqualsDeclaration(node) && !node.isTypeOnly && ts.isExternalModuleReference(node.moduleReference)) {
          if (node.moduleReference.expression && ts.isStringLiteral(node.moduleReference.expression)) dependency(node.moduleReference.expression.text);
          else uncertain.add(`${file}: dynamic import assignment`);
        }
        if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || ts.isIdentifier(node.expression) && node.expression.text === "require")) {
          if (node.arguments[0] && ts.isStringLiteral(node.arguments[0])) dependency(node.arguments[0].text);
          else uncertain.add(`${file}: dynamic module import`);
        }
        ts.forEachChild(node, visit);
      }
      visit(ast);
    }
    return { files: [...visited].sort(), uncertain: [...uncertain].sort() };
  }
  const websiteSeeds = files.filter(file => !isNonRuntime(file) && source(file) &&
    (file.startsWith("src/") && !file.startsWith("src/trigger/") && !file.startsWith("src/hygglo-core/") || /^next\.config\./.test(file) || file === "scripts/build-with-convex.mjs"));
  const website = closure(websiteSeeds);
  const backend = closure(files.filter(file => !isNonRuntime(file) && (file.startsWith("convex/") || file === "convex.json" || ["scripts/backend-fingerprint.mjs", "scripts/backend-publisher.mjs", "scripts/publish-backend.mjs"].includes(file))));
  const trigger = closure(files.filter(file => workerRoot(file) || file === "trigger.config.ts"));
  const result = { version: 1, generator: "scripts/deployment-inputs.mjs", globals: files.filter(file => specialFiles.has(file)).sort(), website, backend, trigger };
  return result;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  const contents = JSON.stringify(createManifest(), null, 2) + "\n";
  if (process.argv.includes("--write")) fs.writeFileSync(MANIFEST, contents);
  else if (!fs.existsSync(MANIFEST) || fs.readFileSync(MANIFEST, "utf8") !== contents) {
    console.error("Deployment inputs changed. Run node scripts/deployment-inputs.mjs --write.");
    process.exit(1);
  }
  const value = JSON.parse(contents);
  console.log(JSON.stringify(Object.fromEntries(["website", "backend", "trigger"].map(key => [key, { files: value[key].files.length, uncertain: value[key].uncertain }]))));
}
