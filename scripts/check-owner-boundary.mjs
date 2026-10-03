import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
const root = path.resolve("convex");
const failures = [], registrations = [];
const publicNames = new Set(["query", "mutation", "action", "queryGeneric", "mutationGeneric", "actionGeneric"]);
function walk(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === "_generated") continue;
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) { walk(file); continue; }
    if (!entry.name.endsWith(".ts") || /\.(?:test|spec|d)\.ts$/.test(entry.name)) continue;
    const source = ts.createSourceFile(file, fs.readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
    const relative = path.relative(root, file), builders = new Map();
    for (const statement of source.statements) {
      if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
      const module = statement.moduleSpecifier.text, named = statement.importClause?.namedBindings;
      if (!named) continue;
      const raw = module.endsWith("_generated/server") || module === "convex/server";
      if (ts.isNamespaceImport(named) && raw && relative !== "owner_functions.ts") {
        failures.push(`${relative}: raw SDK namespace imports can bypass owner registration`);
      }
      if (!ts.isNamedImports(named)) continue;
      for (const item of named.elements) {
        const original = (item.propertyName ?? item.name).text;
        if (!publicNames.has(original)) continue;
        builders.set(item.name.text, { original, module });
        if (raw && relative !== "owner_functions.ts" && !(relative === "auth.ts" && original === "query")) {
          failures.push(`${relative}: ${original} imported from ${module}`);
        }
      }
    }
    for (const statement of source.statements) {
      if (!ts.isVariableStatement(statement) || !statement.modifiers?.some(m => m.kind === ts.SyntaxKind.ExportKeyword)) continue;
      for (const declaration of statement.declarationList.declarations) {
        if (!declaration.initializer || !ts.isCallExpression(declaration.initializer) || !ts.isIdentifier(declaration.initializer.expression)) continue;
        const builder = builders.get(declaration.initializer.expression.text);
        if (!builder) continue;
        const name = declaration.name.getText(source);
        const bootstrapState = relative === "auth.ts" && name === "state" && builder.original === "query";
        if (!bootstrapState && !builder.module.endsWith("owner_functions")) failures.push(`${relative}:${name} bypasses the owner builder`);
        registrations.push({ file: relative, name, kind: builder.original, bootstrapState });
      }
    }
    if (relative === "auth.ts") {
      function inspectBootstrap(node) {
        if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
          const builder = builders.get(node.expression.text);
          if (builder?.module.endsWith("_generated/server")) {
            const declaration = node.parent;
            const statement = declaration.parent?.parent;
            const approved = ts.isVariableDeclaration(declaration) && declaration.name.getText(source) === "state"
              && ts.isVariableStatement(statement) && statement.modifiers?.some(m => m.kind === ts.SyntaxKind.ExportKeyword);
            if (!approved) failures.push("auth.ts: raw bootstrap builder used outside the approved state registration");
          }
        }
        ts.forEachChild(node, inspectBootstrap);
      }
      inspectBootstrap(source);
    }
  }
}
walk(root);
console.log(JSON.stringify({ registrations: registrations.length, guarded: registrations.filter(r => !r.bootstrapState).length, bootstrap: registrations.filter(r => r.bootstrapState).length, failures }, null, 2));
if (failures.length) process.exitCode = 1;
