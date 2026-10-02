/// <reference types="vite/client" />
/// <reference types="vite-plugin-svgr/client" />

// SVGR is the default SVG loader (see vite.config `svgr({ include: … })`):
// a plain `import Logo from "./logo.svg"` is a React component. The `?react`
// form is typed by `vite-plugin-svgr/client`; this overrides the bare `*.svg`
// module so the default import is a component too. NOTE: under strict `tsgo`
// this can merge imperfectly with vite/client's `*.svg = string` — prefer
// `./logo.svg?react` if the component type doesn't resolve.
declare module "*.svg" {
	import type { FunctionComponent, SVGProps } from "react";
	const ReactComponent: FunctionComponent<
		SVGProps<SVGSVGElement> & { title?: string }
	>;
	export default ReactComponent;
}
// Explicit URL import: `import url from "./logo.svg?url"`.
declare module "*.svg?url" {
	const src: string;
	export default src;
}
