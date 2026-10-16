/** A new rich-product writer must maintain the compact row in its transaction. */
import path from "node:path";
import ts from "typescript";

const root = process.cwd();
const configFile = ts.readConfigFile(path.join(root, "tsconfig.json"), ts.sys.readFile);
if (configFile.error) throw new Error("Cannot read TypeScript configuration for product writer audit");
const config = ts.parseJsonConfigFileContent(configFile.config, ts.sys, root);
// Only backend roots and their actual imports can write through MutationCtx.
// Avoid loading the unrelated Next.js UI and test suite into a second checker.
const backendRoots = config.fileNames.filter((file) => file.startsWith(path.join(root, "convex") + path.sep)
  && !/\.(test|spec|d)\.ts$/.test(file));
const program = ts.createProgram(backendRoots, config.options);
const checker = program.getTypeChecker();
const failures = [], writers = [], reviewed = new Map();
// These pre-existing casts write insurance claims, reservation vision results,
// and the explicitly enumerated MvTableName union. Keep each exception bounded
// to one existing expression, rather than exempting an entire file.
const reviewedUnknown = new Set([
  "convex/lib/websiteCases.ts|patch|old._id",
  "convex/reservation_vision.ts|patch|existing._id",
  "convex/mv/_helpers.ts|patch|existing._id as any",
]);
function permitsProduct(type) {
  if (type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) return true;
  if (type.flags & ts.TypeFlags.String) return true;
  if (type.isStringLiteral()) return type.value === "hygglo_products";
  if (type.isUnion()) return type.types.some(permitsProduct);
  const constraint = checker.getBaseConstraintOfType(type);
  return constraint && constraint !== type ? permitsProduct(constraint) : false;
}
function unwrap(expression) {
  while (ts.isAsExpression(expression) || ts.isParenthesizedExpression(expression)) expression = expression.expression;
  return expression;
}
for (const source of program.getSourceFiles()) {
  if (!source.fileName.startsWith(root + path.sep) || source.fileName.includes(`${path.sep}node_modules${path.sep}`)
    || /\.(test|spec|d)\.ts$/.test(source.fileName)) continue;
  const file = path.relative(root, source.fileName).split(path.sep).join("/");
  function visit(node) {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
      && ["insert", "patch", "replace", "delete"].includes(node.expression.name.text)
      && /\.db$/.test(node.expression.expression.getText(source))) {
      const operation = node.expression.name.text;
      const first = node.arguments[0];
      if (first) {
        const explicitTable = ts.isStringLiteral(first) ? first.text : undefined;
        const identifier = explicitTable && operation !== "insert" ? node.arguments[1] : first;
        const type = checker.getTypeAtLocation(identifier);
        const typeText = checker.typeToString(type);
        const tableBrand = type.getProperty("__tableName");
        const possibleProduct = operation === "insert"
          ? permitsProduct(checker.getTypeAtLocation(unwrap(first)))
          : explicitTable === "hygglo_products" || typeText.includes('"hygglo_products"') ||
            !!(tableBrand && permitsProduct(checker.getTypeOfSymbolAtLocation(tableBrand, identifier)));
        const unknown = operation !== "insert" && !!(type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown));
        if (possibleProduct) {
          writers.push({ file, operation });
          if (file !== "convex/lib/product_context.ts") failures.push(`${file}: direct ${operation} bypasses the atomic product projection helpers`);
        } else if (unknown) {
          const key = `${file}|${operation}|${identifier.getText(source)}`;
          const count = (reviewed.get(key) ?? 0) + 1;
          reviewed.set(key, count);
          if (!reviewedUnknown.has(key) || count > 1) failures.push(`${file}: unreviewed ${operation} with an unknown table identity`);
        }
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
}
console.log(JSON.stringify({ productWriters: writers, reviewedUnknownWrites: [...reviewed.keys()], failures }, null, 2));
if (failures.length) process.exitCode = 1;
