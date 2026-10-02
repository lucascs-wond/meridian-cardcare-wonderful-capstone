#!/usr/bin/env node
// scripts/package-plugin.mjs — turn this app repository into a Wonderful Catalog
// plugin zip, so an app you built for your own tenant can be published for others.
//
//   pnpm package:plugin              # build the app, then emit dist/<slug>-<version>.zip
//   pnpm package:plugin --no-build   # reuse the app bundle already in app/dist
//
// The repository is the source of truth; this is a pure translation of it into the
// plugin layout the catalog expects:
//
//   wonderful.json        -> manifest.json (identity + the `catalog` block)
//   tables/<name>.json    -> entities/<name>.custom_table.json   (same shape already)
//   functions/<slug>/     -> entities/<slug>.function/entity.json  (kind: http)
//                            entities/<slug>.cronjob/entity.json   (kind: cron)
//   app/dist/<...>.zip    -> entities/<app>.app/bundle.zip
//
// depends_on is derived, not authored: functions and the app depend on every table
// the repo declares, and the app additionally depends on every function — so the
// catalog's installer creates them in an order where each entity's dependencies
// already exist.

import { execFileSync } from "node:child_process";
import {
	cpSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = join(REPO_ROOT, "dist");
const STAGE_DIR = join(OUT_DIR, "plugin");

const VALID_CATEGORIES = [
	"Agents",
	"Monitoring",
	"Workflows",
	"Dev Tools",
	"Knowledge",
	"Other",
];

// Retired pre-2026-08 category names. Still accepted so a plugin repo scaffolded
// before the taxonomy change keeps packaging; the catalog folds them onto the
// current names on publish.
const DEPRECATED_CATEGORIES = [
	"Integrations",
	"Agent Skills",
	"Observability",
	"Industry Packs",
];

// How finished the plugin is — the author's own claim, so it lives in the manifest
// rather than being curated by a catalog admin. Optional.
const VALID_SOLUTION_TYPES = ["Working solution", "Demo / Inspiration"];

function fail(message) {
	console.error(`✖ ${message}`);
	process.exit(1);
}
function info(message) {
	console.log(`· ${message}`);
}
function ok(message) {
	console.log(`✓ ${message}`);
}

function readJson(path, label) {
	try {
		return JSON.parse(readFileSync(path, "utf8"));
	} catch (error) {
		fail(`${label} is not valid JSON: ${error.message}`);
	}
}

/** Reads wonderful.json and checks everything the catalog validator requires. */
function loadManifestSource() {
	const path = join(REPO_ROOT, "wonderful.json");
	if (!existsSync(path)) {
		fail("wonderful.json not found — run this from the root of an app repository");
	}
	const app = readJson(path, "wonderful.json");
	const catalog = app.catalog ?? {};

	const publisherId = (catalog.publisher_id ?? "").trim();
	if (!publisherId) {
		fail(
			"wonderful.json needs catalog.publisher_id to publish. Add a `catalog` block:\n" +
				'  "catalog": { "publisher_id": "acme", "slug": "acme/my-app", "version": "1.0.0", "category": "Other" }',
		);
	}

	// The catalog requires a scoped slug that agrees with publisher_id.
	const slug = (catalog.slug ?? `${publisherId}/${app.slug}`).trim();
	if (!slug.startsWith(`${publisherId}/`) || slug.split("/").length !== 2) {
		fail(`catalog.slug must be "<publisher>/<plugin>" and start with "${publisherId}/" (got "${slug}")`);
	}

	const version = (catalog.version ?? "").trim();
	if (!/^\d+\.\d+\.\d+(?:[-+].+)?$/.test(version)) {
		fail(`catalog.version must be semver (e.g. 1.0.0), got "${version || "(missing)"}"`);
	}

	const category = (catalog.category ?? "Other").trim();
	if (!VALID_CATEGORIES.includes(category) && !DEPRECATED_CATEGORIES.includes(category)) {
		fail(`catalog.category must be one of: ${VALID_CATEGORIES.join(", ")}`);
	}

	const solutionType = (catalog.solution_type ?? "").trim();
	if (solutionType && !VALID_SOLUTION_TYPES.includes(solutionType)) {
		fail(`catalog.solution_type must be one of: ${VALID_SOLUTION_TYPES.join(", ")}`);
	}

	const title = (catalog.title ?? app.name ?? "").trim();
	if (!title) fail("a title is required (catalog.title, or the app's name)");

	const shortDescription = (catalog.short_description ?? app.description ?? "").trim();
	if (!shortDescription) {
		fail("a short description is required (catalog.short_description, or the app's description)");
	}

	return { app, catalog, publisherId, slug, version, category, solutionType, title, shortDescription };
}

/** Builds and packages the app so app/dist holds a fresh bundle. */
function buildApp(version) {
	info("building the app…");
	const appDir = join(REPO_ROOT, "app");
	if (!existsSync(join(appDir, "package.json"))) {
		fail("app/package.json not found — is this an app repository?");
	}
	if (!existsSync(join(appDir, "node_modules"))) {
		fail("app/node_modules is missing — run `pnpm install` in app/ first, or pass --no-build");
	}
	const env = { ...process.env, BUNDLE_VERSION: version };
	for (const script of ["build", "package"]) {
		try {
			execFileSync("pnpm", ["run", script], { cwd: appDir, stdio: "inherit", env });
		} catch {
			// pnpm already printed the real compiler output above; a node stack trace
			// on top of it only buries the part the author needs to read.
			fail(`\`pnpm run ${script}\` failed in app/ — see the output above`);
		}
	}
}

/** Finds the bundle zip `pnpm package` produced. */
function findAppBundle() {
	const distDir = join(REPO_ROOT, "app", "dist");
	if (!existsSync(distDir)) {
		fail("app/dist not found — run without --no-build, or run `pnpm package` in app/ first");
	}
	const zips = readdirSync(distDir)
		.filter((name) => name.toLowerCase().endsWith(".zip"))
		.map((name) => join(distDir, name))
		.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
	if (!zips.length) {
		fail("no bundle zip in app/dist — does app/package.json define a `package` script?");
	}
	return zips[0];
}

/** Reads every tables/<name>.json. Its on-disk shape is already the entity shape. */
function loadTables() {
	const dir = join(REPO_ROOT, "tables");
	if (!existsSync(dir)) return [];
	return readdirSync(dir)
		.filter((name) => name.endsWith(".json"))
		.map((name) => {
			const key = name.slice(0, -".json".length);
			return { key, schema: readJson(join(dir, name), `tables/${name}`) };
		});
}

/** Reads every functions/<slug>/ folder, splitting by config.json's kind. */
function loadFunctions() {
	const dir = join(REPO_ROOT, "functions");
	if (!existsSync(dir)) return [];
	const out = [];
	for (const slug of readdirSync(dir)) {
		const folder = join(dir, slug);
		if (!statSync(folder).isDirectory()) continue;
		const configPath = join(folder, "config.json");
		const entryPath = join(folder, "index.ts");
		if (!existsSync(configPath)) continue;
		if (!existsSync(entryPath)) {
			fail(`functions/${slug} has config.json but no index.ts`);
		}
		const config = readJson(configPath, `functions/${slug}/config.json`);
		const code = readFileSync(entryPath, "utf8");

		// Extra sources beside the entrypoint travel as `files` so a function split
		// into modules still installs as one entity.
		const files = {};
		for (const name of readdirSync(folder)) {
			if (name === "config.json" || name === "index.ts") continue;
			const child = join(folder, name);
			if (statSync(child).isDirectory()) continue;
			files[name] = readFileSync(child, "utf8");
		}
		out.push({ slug, config, code, files });
	}
	return out;
}

function writeStaged(relativePath, contents) {
	const target = join(STAGE_DIR, relativePath);
	mkdirSync(dirname(target), { recursive: true });
	writeFileSync(target, contents);
}

function main() {
	const args = process.argv.slice(2);
	const skipBuild = args.includes("--no-build");

	const source = loadManifestSource();
	const { app, catalog } = source;

	if (!skipBuild) buildApp(source.version);
	const bundlePath = findAppBundle();

	const tables = loadTables();
	const functions = loadFunctions();
	const appKey = app.slug;

	rmSync(STAGE_DIR, { recursive: true, force: true });
	mkdirSync(STAGE_DIR, { recursive: true });

	const entities = [];
	const tableKeys = tables.map((t) => t.key);

	for (const { key, schema } of tables) {
		writeStaged(`entities/${key}.custom_table.json`, `${JSON.stringify(schema, null, 2)}\n`);
		entities.push({ type: "custom_table", key, path: `entities/${key}.custom_table.json` });
	}

	const functionKeys = [];
	for (const { slug, config, code, files } of functions) {
		const isCron = config.kind === "cron";
		const type = isCron ? "cronjob" : "function";
		const dir = `entities/${slug}.${type}`;
		const entity = isCron
			? {
					name: config.name ?? slug,
					slug,
					description: config.description ?? "",
					cron_schedules: config.cron_schedules ?? [],
					param_mapping: config.cron_param_mapping ?? undefined,
					timeout_ms: config.timeout_ms ?? undefined,
					is_enabled: true,
					code,
					files: Object.keys(files).length ? files : undefined,
				}
			: {
					name: config.name ?? slug,
					description: config.description ?? "",
					method: config.method ?? "POST",
					path_slug: config.path_slug ?? slug,
					param_mapping: config.param_mapping ?? {},
					timeout_ms: config.timeout_ms ?? undefined,
					is_enabled: true,
					code,
					files: Object.keys(files).length ? files : undefined,
				};
		writeStaged(`${dir}/entity.json`, `${JSON.stringify(entity, null, 2)}\n`);
		entities.push({
			type,
			key: slug,
			path: `${dir}/entity.json`,
			...(tableKeys.length ? { depends_on: tableKeys } : {}),
		});
		// Only HTTP functions are linked to the app: a resource link is the app's
		// invocation allowlist, and a cronjob is fired by the scheduler.
		if (!isCron) functionKeys.push(slug);
	}

	// The app entity: its bundle, plus links to everything the repo manages.
	const appDir = `entities/${appKey}.app`;
	cpSync(bundlePath, join(STAGE_DIR, appDir, "bundle.zip"), {
		recursive: false,
		force: true,
	});
	const appEntity = {
		name: app.name,
		description: app.description ?? "",
		bundle_path: `${appDir}/bundle.zip`,
		resource_links: [
			...tableKeys.map((key) => ({ type: "table", entity_key: key })),
			...functionKeys.map((key) => ({ type: "function", entity_key: key })),
		],
		...(app.roles ? { roles: app.roles } : {}),
	};
	writeStaged(`${appDir}/entity.json`, `${JSON.stringify(appEntity, null, 2)}\n`);
	entities.push({
		type: "app",
		key: appKey,
		path: `${appDir}/entity.json`,
		...(tableKeys.length || functionKeys.length
			? { depends_on: [...tableKeys, ...functionKeys] }
			: {}),
	});

	// Media. README is required by the catalog; a screenshot is too. An icon is
	// optional — the catalog falls back to a per-category one.
	const readmePath = catalog.readme_path ?? "README.md";
	if (!existsSync(join(REPO_ROOT, readmePath))) {
		fail(`the catalog requires a readme: ${readmePath} not found (add one, or set catalog.readme_path)`);
	}
	cpSync(join(REPO_ROOT, readmePath), join(STAGE_DIR, readmePath));

	const screenshotPaths = catalog.screenshot_paths ?? [];
	if (!screenshotPaths.length) {
		fail(
			"the catalog requires at least one screenshot. Add images to the repo and list them:\n" +
				'  "catalog": { ..., "screenshot_paths": ["media/screenshots/01-overview.png"] }',
		);
	}
	for (const relativePath of screenshotPaths) {
		if (!existsSync(join(REPO_ROOT, relativePath))) {
			fail(`catalog.screenshot_paths references a missing file: ${relativePath}`);
		}
		mkdirSync(dirname(join(STAGE_DIR, relativePath)), { recursive: true });
		cpSync(join(REPO_ROOT, relativePath), join(STAGE_DIR, relativePath));
	}
	const iconPath = catalog.icon_path;
	if (iconPath) {
		if (!existsSync(join(REPO_ROOT, iconPath))) {
			fail(`catalog.icon_path references a missing file: ${iconPath}`);
		}
		mkdirSync(dirname(join(STAGE_DIR, iconPath)), { recursive: true });
		cpSync(join(REPO_ROOT, iconPath), join(STAGE_DIR, iconPath));
	}

	const manifest = {
		schema_version: 1,
		publisher_id: source.publisherId,
		slug: source.slug,
		version: source.version,
		title: source.title,
		short_description: source.shortDescription,
		category: source.category,
		...(source.solutionType ? { solution_type: source.solutionType } : {}),
		...(catalog.tags ? { tags: catalog.tags } : {}),
		...(iconPath ? { icon_path: iconPath } : {}),
		screenshot_paths: screenshotPaths,
		readme_path: readmePath,
		...(catalog.release_notes ? { release_notes: catalog.release_notes } : {}),
		entities,
	};
	writeStaged("manifest.json", `${JSON.stringify(manifest, null, 2)}\n`);

	const zipName = `${source.slug.replace("/", "-")}-${source.version}.zip`;
	const zipPath = join(OUT_DIR, zipName);
	rmSync(zipPath, { force: true });
	try {
		// `zip` rather than a node dependency: it is present in the sandbox image and
		// on any developer machine that can run git, and this repo's root toolchain
		// exists to bundle functions, not to package archives.
		execFileSync("zip", ["-rq", zipPath, "."], { cwd: STAGE_DIR, stdio: "inherit" });
	} catch (error) {
		fail(`could not create the zip (is \`zip\` installed?): ${error.message}`);
	}

	ok(`packaged ${zipName}`);
	console.log(`  entities: ${entities.map((e) => `${e.key} (${e.type})`).join(", ")}`);
	console.log("");
	console.log("  Install it on a tenant to try it:");
	console.log(
		`    curl -X POST "$WONDERFUL_BASE_URL/api/v1/catalog/plugins/dev-install" \\\n` +
			`      -H "X-api-key: $WONDERFUL_API_KEY" -F "file=@dist/${zipName}"`,
	);
}

main();
