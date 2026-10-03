import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

const root = path.resolve("src");
const factories = new Set(["lib/owner-http-route.ts", "lib/convex-service.ts"]);
const failures = [];
let scanned = 0;
function walk(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) { walk(file); continue; }
    if (!/\.tsx?$/.test(entry.name) || /\.(?:test|spec|d)\.tsx?$/.test(entry.name)) continue;
    scanned++;
    const relative = path.relative(root, file);
    const source = ts.createSourceFile(file, fs.readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
    const browser = source.statements.some(node => ts.isExpressionStatement(node) && ts.isStringLiteral(node.expression) && node.expression.text === "use client");
    function inspect(node) {
      if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
        const module = node.moduleSpecifier.text, clause = node.importClause;
        if (browser && /(?:convex-service|owner-http-route|convex-request-context)$/.test(module)) {
          failures.push(`${relative}: private server transport imported by a browser component`);
        }
        if (module === "convex/browser" && clause && !clause.isTypeOnly && !factories.has(relative)) {
          const bindings = clause.namedBindings;
          if (bindings && (ts.isNamespaceImport(bindings) || bindings.elements.some(item => !item.isTypeOnly && (item.propertyName ?? item.name).text === "ConvexHttpClient"))) {
            failures.push(`${relative}: use an authenticated shared client instead of a raw HTTP client`);
          }
        }
      }
      if (ts.isCallExpression(node) && !factories.has(relative) && node.arguments.some(arg => ts.isStringLiteral(arg) && arg.text === "convex/browser")) {
        if (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === "require")) {
          failures.push(`${relative}: dynamic SDK loading can bypass request authentication`);
        }
      }
      ts.forEachChild(node, inspect);
    }
    inspect(source);
  }
}
walk(root);
console.log(JSON.stringify({ sourceFiles: scanned, approvedHttpFactories: [...factories], failures }, null, 2));
if (failures.length) process.exitCode = 1;
