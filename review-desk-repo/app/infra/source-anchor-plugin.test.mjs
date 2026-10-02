// Regression tests for the design-mode source-anchor plugin.
//
// These guard the contract that makes a NEWLY-created app editable in design
// mode: every host element gets the `globalThis.__WF_ANCHORS__?.["<id>"]`
// spread, the private `wf-source-map.json` sidecar lists those same ids with
// their source, and a deployed bundle leaks nothing meaningful.
//
// Run with `pnpm test` (node's built-in runner; no extra test framework).

import assert from "node:assert/strict";
import process from "node:process";
import { test } from "node:test";
import babel from "@babel/core";
import {
	createSourceAnchorPlugins,
	SOURCE_MAP_FILENAME,
} from "./source-anchor-plugin.ts";

// Matches the spread the plugin injects: globalThis.__WF_ANCHORS__?.["<id>"].
const ID_IN_CODE = /__WF_ANCHORS__\?\.\["([0-9a-f]{10})"\]/g;

/**
 * Transform a JSX/TSX snippet through one plugin instance and return both the
 * generated code and the sidecar map that the companion Vite plugin emits — so
 * we can assert the bundle and the sidecar stay consistent.
 */
function transform(code, filename = "src/Demo.tsx") {
	const { babel: anchorBabel, vite } = createSourceAnchorPlugins();
	const result = babel.transformSync(code, {
		filename,
		cwd: process.cwd(),
		babelrc: false,
		configFile: false,
		parserOpts: { plugins: ["jsx", "typescript"] },
		plugins: [anchorBabel],
	});

	let map = null;
	vite.generateBundle.call({
		emitFile: ({ fileName, source }) => {
			if (fileName === SOURCE_MAP_FILENAME) {
				map = JSON.parse(source);
			}
		},
	});

	return { code: result.code, map };
}

function idsInCode(code) {
	return new Set([...code.matchAll(ID_IN_CODE)].map((m) => m[1]));
}

test("anchors host elements AND components (ui-base DOM is unreachable otherwise)", () => {
	const { code, map } = transform(`
		const App = () => (
			<div className="root">
				<span>hi</span>
				<Card><p>nested</p></Card>
			</div>
		);
	`);

	// div + span + Card + p are all anchored; <Fragment> would be skipped.
	assert.equal(idsInCode(code).size, 4);
	assert.equal(Object.keys(map).length, 4);

	const names = Object.values(map).map((e) => e.name).sort();
	assert.deepEqual(names, ["Card", "div", "p", "span"]);

	for (const entry of Object.values(map)) {
		assert.equal(entry.file, "src/Demo.tsx");
		assert.equal(typeof entry.line, "number");
		assert.equal(entry.component, "App"); // enclosing component name
		assert.equal(entry.loop, undefined); // none are looped
	}
});

test("flags looped elements with the iterable so they can be grouped + labelled", () => {
	const { code, map } = transform(`
		const List = ({ stories }) => (
			<ul>
				{stories.map((s) => (<Card key={s.id}>{s.title}</Card>))}
			</ul>
		);
	`);

	// One <ul> site + one <Card> site, even though <Card> renders N times.
	assert.equal(idsInCode(code).size, 2);
	assert.equal(Object.keys(map).length, 2);

	const entries = Object.values(map);
	const card = entries.find((e) => e.name === "Card");
	const ul = entries.find((e) => e.name === "ul");
	assert.equal(card.loop, true);
	assert.equal(card.iterable, "stories");
	assert.equal(ul.loop, undefined); // the container is not itself looped
});

test("skips JSX fragments", () => {
	const { map } = transform(`
		const W = () => (<><span>a</span></>);
	`);
	// Only <span> is anchored; the fragment is not.
	assert.deepEqual(
		Object.values(map).map((e) => e.name),
		["span"],
	);
});

test("sidecar ids exactly match the ids baked into the code", () => {
	const { code, map } = transform(`
		const View = () => (<section><h1>t</h1><button>go</button></section>);
	`);

	assert.deepEqual(idsInCode(code), new Set(Object.keys(map)));
});

test("ids are opaque and re-salted per build (privacy)", () => {
	const src = `const A = () => (<div><span>x</span></div>);`;
	const first = transform(src);
	const second = transform(src);

	// 10-char hex, never the raw source location.
	for (const id of Object.keys(first.map)) {
		assert.match(id, /^[0-9a-f]{10}$/);
	}
	// Different build → different salt → different ids for the same source.
	assert.notDeepEqual(
		new Set(Object.keys(first.map)),
		new Set(Object.keys(second.map)),
	);
	// The source path is never embedded in the shipped bundle, only the sidecar.
	assert.ok(!first.code.includes("Demo.tsx"));
});

test("emits the sidecar only during build", () => {
	const { vite } = createSourceAnchorPlugins();
	assert.equal(vite.apply, "build");
});

test("code with no host elements produces no anchors and an empty map", () => {
	const { code, map } = transform(`export const value = 1 + 2;`);
	assert.equal(idsInCode(code).size, 0);
	assert.equal(Object.keys(map).length, 0);
	assert.ok(!code.includes("__WF_ANCHORS__"));
});
