/** Source writes must maintain their derived records in the same transaction. */
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
const projectionOwners = new Map([
  ["hygglo_products", "convex/lib/product_context.ts"],
  ["reservations", "convex/lib/reservation_revenue.ts"],
  ["weekly_metrics", "convex/lib/weekly_input_cache.ts"],
  ...["items", "hygglo_product_index", "listing_resolution_override", "insurance_claims", "owner_unavailability", "vacation_periods"]
    .map((table) => [table, "convex/lib/stock_input_writes.ts"]),
]);
// These pre-existing casts write reservation vision results and the explicitly
// enumerated MvTableName union. Keep each exception bounded
// to one existing expression, rather than exempting an entire file.
const reviewedUnknown = new Set([
  "convex/reservation_vision.ts|patch|existing._id",
  "convex/mv/_helpers.ts|patch|existing._id as any",
]);
function permitsTable(type, table) {
  if (type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) return true;
  if (type.flags & ts.TypeFlags.String) return true;
  if (type.isStringLiteral()) return type.value === table;
  if (type.isUnion()) return type.types.some((member) => permitsTable(member, table));
  const constraint = checker.getBaseConstraintOfType(type);
  return constraint && constraint !== type ? permitsTable(constraint, table) : false;
}
function unwrap(expression) {
  while (ts.isAsExpression(expression) || ts.isParenthesizedExpression(expression)) expression = expression.expression;
  return expression;
}
function databaseReceiver(expression, seen = new Set()) {
  expression = unwrap(expression);
  const type = checker.getTypeAtLocation(expression);
  if (type.getProperty("normalizeId") && type.getProperty("query") && type.getProperty("get")) return true;
  if (ts.isPropertyAccessExpression(expression) && expression.name.text === "db") return true;
  if (ts.isIdentifier(expression) && !seen.has(expression.text)) {
    seen.add(expression.text);
    return (checker.getSymbolAtLocation(expression)?.declarations ?? []).some((declaration) =>
      ts.isVariableDeclaration(declaration) && declaration.initializer && databaseReceiver(declaration.initializer, seen));
  }
  return false;
}
for (const source of program.getSourceFiles()) {
  if (!source.fileName.startsWith(root + path.sep) || source.fileName.includes(`${path.sep}node_modules${path.sep}`)
    || /\.(test|spec|d)\.ts$/.test(source.fileName)) continue;
  const file = path.relative(root, source.fileName).split(path.sep).join("/");
  function visit(node) {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
      && ["insert", "patch", "replace", "delete"].includes(node.expression.name.text)
      && databaseReceiver(node.expression.expression)) {
      const operation = node.expression.name.text;
      const first = node.arguments[0];
      if (first) {
        const explicitTable = ts.isStringLiteral(first) ? first.text : undefined;
        const identifier = explicitTable && operation !== "insert" ? node.arguments[1] : first;
        const type = checker.getTypeAtLocation(identifier);
        const typeText = checker.typeToString(type);
        const tableBrand = type.getProperty("__tableName");
        const sourceTables = [...projectionOwners.keys()].filter((table) => operation === "insert"
          ? permitsTable(checker.getTypeAtLocation(unwrap(first)), table)
          : explicitTable === table || typeText.includes(JSON.stringify(table)) ||
            !!(tableBrand && permitsTable(checker.getTypeOfSymbolAtLocation(tableBrand, identifier), table)));
        const unknown = operation !== "insert" && !!(type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown));
        if (sourceTables.length) {
          for (const table of sourceTables) {
            writers.push({ file, table, operation });
            if (file !== projectionOwners.get(table)) failures.push(`${file}: direct ${operation} of ${table} bypasses its atomic projection helpers`);
          }
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
console.log(JSON.stringify({ projectionWriters: writers, reviewedUnknownWrites: [...reviewed.keys()], failures }, null, 2));
if (failures.length) process.exitCode = 1;
