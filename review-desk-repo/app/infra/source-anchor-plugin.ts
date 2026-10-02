import crypto from "node:crypto";
import path from "node:path";
import process from "node:process";

/**
 * Source-anchoring for Wonderful design mode, designed so that **nothing** is
 * rendered into a deployed app's DOM.
 *
 * For every JSX element — host (`div`) AND component (`Card`) — the Babel plugin
 * injects an inline spread:
 *
 *     <Card {...(globalThis.__WF_ANCHORS__?.["<id>"])} />
 *
 *  - `<id>` is an OPAQUE, per-build-salted hash of file:line:col — it exists
 *    only as a string constant in the compiled JS, never in the DOM.
 *  - In production `globalThis.__WF_ANCHORS__` is never set, so the spread is a
 *    no-op (`{...undefined}`) → fibers and DOM are completely clean.
 *  - In our editor we set `globalThis.__WF_ANCHORS__` (id → {data-source-*})
 *    BEFORE the app renders, so each element's `data-source-*` lands on its
 *    React fiber's props. Host elements also render them as DOM attributes; for
 *    component-rendered DOM (e.g. the `<div>` ui-base's `Card` returns) the
 *    editor walks the fiber tree from the DOM node up to the nearest anchored
 *    element and stamps the attributes on. We anchor components too precisely
 *    because Wonderful apps are built from ui-base components whose DOM we
 *    couldn't otherwise reach (their prop APIs don't forward `data-*`).
 *  - Every instance of a looped element shares the same id (same source
 *    location), so the editor groups "instances of the same component"; the
 *    sidecar flags those (`loop`, `iterable`) so the editor can label them.
 *
 * A companion Vite plugin emits the private `wf-source-map.json` sidecar
 * (id → {name, component, file, line, loop, iterable}) the editor fetches to
 * build that global map.
 *
 * Babel/Rollup types are intentionally loose (`Any`) so the template doesn't
 * need @babel/types just to typecheck the Vite config.
 */

export const SOURCE_MAP_FILENAME = "wf-source-map.json";

// Must match the global key the editor sets (wonderful-ui editor/sourceMap.ts).
const ANCHORS_GLOBAL = "__WF_ANCHORS__";

export interface SourceMapEntry {
	/** The JSX element's own name — a host tag (`div`) or a component (`Card`). */
	name?: string;
	/** The component this element is written inside (e.g. `App`). */
	component?: string;
	/** True when the element is rendered from inside a `.map(...)` callback. */
	loop?: boolean;
	/** The mapped collection's name when known (e.g. `stories`). */
	iterable?: string;
	file: string;
	line: number;
}
export type WfSourceMap = Record<string, SourceMapEntry>;

// biome-ignore lint/suspicious/noExplicitAny: Babel/Rollup nodes are untyped here.
type Any = any;

/**
 * The element's own name, or null for things we never anchor: JSX fragments
 * (`<>`), `<Fragment>` (renders no DOM), and member/namespaced names
 * (`<motion.div>`) we can't cheaply attribute.
 */
function anchorableName(name: Any): string | null {
	if (name?.type !== "JSXIdentifier") {
		return null;
	}
	return name.name === "Fragment" ? null : name.name;
}

function enclosingComponentName(jsxPath: Any): string {
	const fn = jsxPath.getFunctionParent();
	if (!fn) {
		return "";
	}
	if (fn.node.id?.name) {
		return fn.node.id.name;
	}
	const parent = fn.parentPath?.node;
	if (parent?.type === "VariableDeclarator" && parent.id?.type === "Identifier") {
		return parent.id.name;
	}
	if (parent?.type === "AssignmentExpression" && parent.left?.type === "Identifier") {
		return parent.left.name;
	}
	return "";
}

/**
 * When the element is returned from a `.map(...)` callback, the mapped
 * collection's name (`stories` for `stories.map(...)`) — or "" for an anonymous
 * source like `getStories().map(...)`. Returns null when not inside a map, so
 * every instance of a looped element is flagged and can be grouped + labelled.
 */
function mapIterable(jsxPath: Any): string | null {
	const fn = jsxPath.getFunctionParent();
	const call = fn?.parentPath;
	if (!call?.isCallExpression?.()) {
		return null;
	}
	const callee = call.node.callee;
	if (
		callee?.type !== "MemberExpression" ||
		callee.property?.type !== "Identifier" ||
		callee.property.name !== "map"
	) {
		return null;
	}
	const obj = callee.object;
	if (obj?.type === "Identifier") {
		return obj.name;
	}
	if (obj?.type === "MemberExpression" && obj.property?.type === "Identifier") {
		return obj.property.name;
	}
	return "";
}

export function createSourceAnchorPlugins() {
	const salt = crypto.randomBytes(8).toString("hex");
	const map: WfSourceMap = {};

	const opaqueId = (file: string, line: number, column: number): string =>
		crypto
			.createHash("sha1")
			.update(`${salt}:${file}:${line}:${column}`)
			.digest("hex")
			.slice(0, 10);

	const babel = (babelArg: Any): Any => {
		const t = babelArg.types;
		return {
			name: "wonderful-source-anchor",
			visitor: {
				JSXOpeningElement(elementPath: Any, state: Any) {
					const node = elementPath.node;
					const name = anchorableName(node.name);
					if (!name || !node.loc || node.__wfAnchored) {
						return;
					}
					node.__wfAnchored = true;

					const filename: string | undefined = state.file?.opts?.filename;
					const root: string = state.cwd ?? process.cwd();
					const relativeFile = filename
						? path.relative(root, filename).split(path.sep).join("/")
						: "";
					const { line, column } = node.loc.start;
					const id = opaqueId(relativeFile, line, column);
					const iterable = mapIterable(elementPath);
					map[id] = {
						file: relativeFile,
						line,
						name,
						component: enclosingComponentName(elementPath) || undefined,
						loop: iterable !== null ? true : undefined,
						iterable: iterable || undefined,
					};

					// {...(globalThis.__WF_ANCHORS__?.["<id>"])}
					const lookup = t.optionalMemberExpression(
						t.memberExpression(
							t.identifier("globalThis"),
							t.identifier(ANCHORS_GLOBAL),
						),
						t.stringLiteral(id),
						true, // computed
						true, // optional
					);
					node.attributes.push(t.jsxSpreadAttribute(lookup));
				},
			},
		};
	};

	const vite: Any = {
		name: "wonderful-source-anchor-emit",
		apply: "build",
		generateBundle(this: Any) {
			this.emitFile({
				type: "asset",
				fileName: SOURCE_MAP_FILENAME,
				source: JSON.stringify(map),
			});
		},
	};

	return { babel, vite };
}
