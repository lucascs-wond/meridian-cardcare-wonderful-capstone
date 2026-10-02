// Build script for a Wonderful functions repo. Discovers every function folder
// (a directory containing a config.json) and bundles its index.ts entrypoint
// into dist/<folder>/index.js with esbuild. Run by the sandbox build via
// `pnpm build` after `pnpm install`, so relative cross-function imports,
// shared_lib, and npm dependencies all resolve. The controller commits the
// produced dist/ artifacts and ships them to the runner.
import { build } from "esbuild";
import { readdirSync, existsSync, statSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const IGNORED = new Set(["node_modules", "dist", ".git"]);

function findFunctionFolders(dir) {
  const folders = [];
  if (existsSync(join(dir, "config.json")) && existsSync(join(dir, "index.ts"))) {
    folders.push(dir === "." ? "" : dir);
  }
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory() || IGNORED.has(entry.name)) continue;
    folders.push(...findFunctionFolders(join(dir, entry.name)));
  }
  return folders;
}

// WONDERFUL_BUILD_FOLDER scopes the build to a single function folder ("." = the
// repo-root function) so each function bundles against its own resolved
// dependencies. Unset (e.g. a local `pnpm build`) falls back to building every
// folder.
function resolveTargetFolders() {
  const target = process.env.WONDERFUL_BUILD_FOLDER;
  if (!target) return findFunctionFolders(".");
  const folder = target === "." ? "" : target;
  const dir = folder === "" ? "." : folder;
  if (!existsSync(join(dir, "config.json")) || !existsSync(join(dir, "index.ts"))) {
    console.error(`build target ${target} is not a function folder`);
    process.exit(1);
  }
  return [folder];
}

const folders = resolveTargetFolders();
const entryPoints = folders.map((f) => (f === "" ? "index.ts" : join(f, "index.ts")));

if (entryPoints.length === 0) {
  console.log("no function folders found; nothing to build");
  process.exit(0);
}

const entryAbs = new Set(entryPoints.map((e) => resolve(e)));

// The runner eval's the bundle as a classic script (no `module`/`require`) and
// calls a top-level `userFunction`/`main`. With an IIFE bundle those entry
// declarations are scoped inside the wrapper, and esbuild's globalName only
// re-exposes *exported* bindings — the default template's bare
// `async function userFunction(...)` (no export) would be lost. Append a
// typeof-guarded globalThis assignment to each entry's own source so the
// declaration, exported or not, is re-published as a global from inside the IIFE.
const exposeEntrypoint = {
  name: "expose-entrypoint",
  setup(b) {
    b.onLoad({ filter: /\.ts$/ }, (args) => {
      if (!entryAbs.has(args.path)) return null;
      const source = readFileSync(args.path, "utf8");
      const expose =
        '\n;if(typeof userFunction!=="undefined")globalThis.userFunction=userFunction;' +
        'if(typeof main!=="undefined")globalThis.main=main;\n';
      return { contents: source + expose, loader: "ts" };
    });
  },
};

// The runner preloads LangChain and exposes the registry-backed Wonderful
// adapters on globalThis. Functions must reference those runtime instances
// instead of bundling the Node-oriented LangChain SDK into the WASM script.
const langchainGlobals = {
  name: "resolve-langchain-globals",
  setup(b) {
    b.onResolve({ filter: /^@wonderful\/types\/langchain$/ }, () => ({
      path: "langchain-globals",
      namespace: "wonderful-types-langchain-shim",
    }));
    b.onLoad({ filter: /.*/, namespace: "wonderful-types-langchain-shim" }, () => ({
      contents: `
exports.LangChainOpenAI = globalThis.LangChainOpenAI;
exports.LangChainAnthropic = globalThis.LangChainAnthropic;
exports.LangChainGoogleGenAI = globalThis.LangChainGoogleGenAI;
exports.ModelProfiles = globalThis.ModelProfiles;
exports.LangChainCore = globalThis.LangChainCore;
`,
      loader: "js",
    }));
  },
};

await build({
  entryPoints,
  bundle: true,
  platform: "node",
  format: "iife",
  target: "es2020",
  outbase: ".",
  outdir: "dist",
  // Wonderful WIT imports are supplied by the runner component at execution
  // time. Keep them as imports instead of asking esbuild to resolve them as
  // npm packages while bundling a function.
  external: ["wonderful:llm/functions"],
  plugins: [exposeEntrypoint, langchainGlobals],
  // The entrypoint is reached only via the injected globalThis side effect;
  // keep tree shaking off so it is never dropped.
  treeShaking: false,
});

console.log(`bundled ${entryPoints.length} function(s)`);
