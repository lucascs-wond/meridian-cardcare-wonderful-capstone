import { createWriteStream, existsSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { extname, join, relative, sep } from "node:path";

const require = createRequire(import.meta.url);
const archiver = require("archiver");

// Bundles ship the built artifacts at the root (app.js, style.css, ...) and a
// snapshot of the app's source under `source/`. The controller skips the
// `source/` entries when serving the deployed app, so they are only available
// via `controller-cli apps download` for round-tripping edits. On `--extract`
// the CLI strips this prefix so the target becomes a normal template checkout.
const SOURCE_PREFIX = "source/";

// Top-level source directories to include. Each is walked recursively.
// `infra` carries the build-time source-anchor plugin imported by vite.config —
// without it, a round-tripped checkout can't build.
const SOURCE_DIRS = ["src", "runner", "dev", "scripts", "infra"];

// Top-level source files to include if they exist.
const SOURCE_FILES = [
  "package.json",
  "pnpm-lock.yaml",
  "tsconfig.json",
  "vite.config.ts",
  ".npmrc",
  "AGENTS.md",
  "README.md",
];

// Anything matching one of these — at any depth — is excluded from the source bundle.
const EXCLUDE_BASENAMES = new Set([
  "node_modules",
  "dist",
  "runner-dist",
  ".git",
  ".DS_Store",
  ".env",
  ".env.local",
]);

async function* walkSourceFiles(rootDir) {
  let entries;
  try {
    entries = await readdir(rootDir, { withFileTypes: true });
  } catch (err) {
    if (err.code === "ENOENT") return;
    throw err;
  }
  for (const entry of entries) {
    if (EXCLUDE_BASENAMES.has(entry.name)) continue;
    // Build-time tests never belong in a round-tripped app source snapshot.
    if (entry.isFile() && /\.test\.[cm]?[jt]s$/.test(entry.name)) continue;
    const full = join(rootDir, entry.name);
    if (entry.isDirectory()) {
      yield* walkSourceFiles(full);
    } else if (entry.isFile()) {
      yield full;
    }
  }
}

async function collectSourceEntries(cwd) {
  const entries = [];
  for (const name of SOURCE_FILES) {
    const abs = join(cwd, name);
    if (existsSync(abs) && (await stat(abs)).isFile()) {
      entries.push({ abs, archivePath: SOURCE_PREFIX + name });
    }
  }
  for (const dir of SOURCE_DIRS) {
    const abs = join(cwd, dir);
    if (!existsSync(abs)) continue;
    for await (const filePath of walkSourceFiles(abs)) {
      const rel = relative(cwd, filePath).split(sep).join("/");
      entries.push({ abs: filePath, archivePath: SOURCE_PREFIX + rel });
    }
  }
  entries.sort((a, b) => a.archivePath.localeCompare(b.archivePath));
  return entries;
}

async function main() {
  const cwd = process.cwd();
  const pkg = JSON.parse(await readFile(join(cwd, "package.json"), "utf-8"));
  const safeName = pkg.name.replace(/[^a-z0-9-]/gi, "-").toLowerCase();
  const version = process.env.BUNDLE_VERSION || pkg.version;

  const distEntries = await readdir("dist", { withFileTypes: true });
  const distFiles = distEntries
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .filter((name) => !name.endsWith(".zip"));

  if (!distFiles.includes("app.js")) {
    throw new Error("dist/app.js not found. Run 'pnpm build' first.");
  }

  const sourceEntries = process.env.BUNDLE_INCLUDE_SOURCE === "false"
    ? []
    : await collectSourceEntries(cwd);

  const manifest = {
    files: distFiles.sort(),
    source_files: sourceEntries.map((e) => e.archivePath),
  };

  const outputPath = `dist/${safeName}-${version}.zip`;
  const output = createWriteStream(outputPath);
  const archive = archiver("zip", { zlib: { level: 9 } });

  output.on("close", () => {
    const cssNote = manifest.files.some((file) => extname(file) === ".css")
      ? " (includes CSS)"
      : "";
    const sourceNote = sourceEntries.length > 0
      ? ` (+${sourceEntries.length} source files)`
      : "";
    console.log(`Packaged: ${outputPath} (${archive.pointer()} bytes)${cssNote}${sourceNote}`);
    console.log(`Manifest files: ${manifest.files.join(", ")}`);
  });

  archive.on("error", (err) => {
    throw err;
  });

  archive.pipe(output);

  for (const file of manifest.files) {
    archive.file(`dist/${file}`, { name: file });
  }
  for (const entry of sourceEntries) {
    archive.file(entry.abs, { name: entry.archivePath });
  }

  archive.append(JSON.stringify(manifest, null, 2), { name: "manifest.json" });
  await archive.finalize();
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
