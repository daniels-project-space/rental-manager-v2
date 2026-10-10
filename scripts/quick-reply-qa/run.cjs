/* Run actual React controls through a local, fixture-only transport. No production data. */
const fs = require("node:fs"),
  path = require("node:path"),
  os = require("node:os"),
  http = require("node:http"),
  { spawn } = require("node:child_process"),
  { createRequire } = require("node:module");
const repo = path.resolve(__dirname, "../.."),
  work = fs.mkdtempSync(path.join(os.tmpdir(), "quick-reply-qa-")),
  publicDir = path.join(work, "public");
fs.mkdirSync(publicDir);
const output = process.env.RM_QA_OUTPUT ?? work;
fs.mkdirSync(output, { recursive: true });
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const child = (file, args, options = {}) =>
  new Promise((resolve, reject) => {
    const p = spawn(file, args, { stdio: "inherit", ...options });
    p.on("error", reject);
    p.on("exit", (code) =>
      code === 0 ? resolve() : reject(Error(`${file} exited ${code}`)),
    );
  });
let browser, server;
(async () => {
  process.chdir(repo);
  const req = createRequire(repo + "/package.json");
  const esbuild = createRequire(require.resolve("tsx"))("esbuild");
  const css = await req("postcss")([req("@tailwindcss/postcss")()]).process(
    fs
      .readFileSync(repo + "/src/app/globals.css", "utf8")
      .replace(
        '@import "tailwindcss";',
        '@import "tailwindcss" source(none);\n@source "../components/dashboard/ReplyInbox.tsx";\n@source "../components/ui";',
      ),
    { from: repo + "/src/app/globals.css" },
  );
  fs.writeFileSync(publicDir + "/tailwind.css", css.css);
  await esbuild.build({
    entryPoints: [__dirname + "/harness.tsx"],
    bundle: true,
    external: ["/fonts/*"],
    outfile: publicDir + "/bundle.js",
    loader: { ".tsx": "tsx", ".ts": "ts", ".module.css": "local-css" },
    jsx: "automatic",
    alias: { "convex/react": __dirname + "/transport.tsx", "@": repo + "/src" },
    nodePaths: [repo + "/node_modules"],
    define: { "process.env.NODE_ENV": '"development"' },
  });
  fs.writeFileSync(
    publicDir + "/index.html",
    '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/tailwind.css"><link rel="stylesheet" href="/bundle.css"><style>body{margin:0;background:#0d151d}#root{padding:24px;max-width:1500px;margin:auto}@media(max-width:640px){#root{padding:8px}}</style></head><body><div id="root"></div><script src="/bundle.js"></script></body></html>',
  );
  server = http.createServer((request, response) => {
    const url = new URL(request.url, "http://127.0.0.1");
    if (
      /^\/(face|gear)\d+\.png$/.test(url.pathname) &&
      process.env.RM_QA_IMAGE_FILES
    ) {
      const photo = path.join(
        process.env.RM_QA_IMAGE_FILES,
        path.basename(url.pathname),
      );
      if (fs.existsSync(photo)) {
        const data = fs.readFileSync(photo);
        response.setHeader(
          "Content-Type",
          data[0] === 0xff && data[1] === 0xd8
            ? "image/jpeg"
            : data.toString("ascii", 0, 4) === "RIFF"
              ? "image/webp"
              : "image/png",
        );
        return response.end(data);
      }
    }
    if (/^\/(face|gear)\d+\.png$/.test(url.pathname)) {
      response.setHeader("Content-Type", "image/svg+xml");
      return response.end(
        '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><rect width="100" height="100" rx="18" fill="#334253"/><text x="50" y="60" text-anchor="middle" fill="#c7d4e2" font-size="25">QA</text></svg>',
      );
    }
    const relative =
        url.pathname === "/" ? "index.html" : url.pathname.slice(1),
      base = relative.startsWith("fonts/") ? repo + "/public" : publicDir;
    const file = path.resolve(base, relative);
    if (
      !file.startsWith(path.resolve(base) + path.sep) ||
      !fs.existsSync(file) ||
      !fs.statSync(file).isFile()
    ) {
      response.statusCode = 404;
      return response.end();
    }
    response.setHeader(
      "Content-Type",
      file.endsWith(".css")
        ? "text/css"
        : file.endsWith(".js")
          ? "text/javascript"
          : file.endsWith(".woff2")
            ? "font/woff2"
            : file.endsWith(".ttf")
              ? "font/ttf"
              : "text/html",
    );
    response.end(fs.readFileSync(file));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const profile = work + "/chrome";
  fs.mkdirSync(profile);
  browser = spawn(
    "google-chrome",
    [
      "--headless=new",
      "--no-sandbox",
      "--disable-dev-shm-usage",
      "--disable-background-networking",
      "--disable-extensions",
      "--no-first-run",
      "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE localhost",
      `--user-data-dir=${profile}`,
      "--remote-debugging-port=0",
      "about:blank",
    ],
    { stdio: "ignore" },
  );
  const active = profile + "/DevToolsActivePort";
  for (let attempt = 0; attempt < 100 && !fs.existsSync(active); attempt++)
    await pause(100);
  if (!fs.existsSync(active)) throw Error("Temporary Chrome did not start.");
  const port = Number(fs.readFileSync(active, "utf8").split("\n")[0]);
  if (!Number.isSafeInteger(port) || port < 1)
    throw Error("Invalid private Chrome port");
  const env = {
    ...process.env,
    DBC_CDP_URL: `http://127.0.0.1:${port}`,
    RM_QA_ORIGIN: `http://127.0.0.1:${server.address().port}`,
    RM_QA_OUTPUT: output,
  };
  console.log(
    "Testing Quick Reply with fixture-only transport and external DNS disabled.",
  );
  if (!process.env.RM_QA_DESIGN_ONLY) {
    await child(process.execPath, [__dirname + "/controls.cjs"], { env });
    await child(process.execPath, [__dirname + "/phone-close.cjs"], { env });
  }
  await child(process.execPath, [__dirname + "/design.cjs"], { env });
  console.log(
    "Quick Reply selected fixture checks passed. Receipts: " + output,
  );
})()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    browser?.kill();
    server?.close();
  });
