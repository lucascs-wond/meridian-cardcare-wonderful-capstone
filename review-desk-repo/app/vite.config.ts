import { fileURLToPath } from "node:url";
import { transformAsync } from "@babel/core";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin, type UserConfig } from "vite";
import svgr from "vite-plugin-svgr";
import { createSourceAnchorPlugins } from "./infra/source-anchor-plugin";

// @vitejs/plugin-react v6 transforms JSX with oxc and no longer accepts a
// `babel` option, so the source-anchor Babel plugin can't ride along with it
// anymore. Instead we run that plugin as a standalone `enforce: "pre"`
// transform: Babel parses the TSX, the anchor visitor injects its spreads, and
// the generator emits TSX again (no JSX/TS transform runs here) — plugin-react
// then handles the actual JSX/TS lowering downstream.
// biome-ignore lint/suspicious/noExplicitAny: Babel plugin factory is untyped.
function sourceAnchorBabelPlugin(anchorBabel: any): Plugin {
  return {
    name: "wonderful-source-anchor-babel",
    enforce: "pre",
    async transform(code, id) {
      const [file] = id.split("?");
      if (!/\.[jt]sx$/.test(file) || file.includes("/node_modules/")) {
        return null;
      }
      const result = await transformAsync(code, {
        filename: file,
        babelrc: false,
        configFile: false,
        sourceMaps: true,
        // Parse TS + JSX but run no transform preset, so the output keeps its
        // JSX/TS syntax intact for plugin-react/oxc to lower afterwards.
        parserOpts: { plugins: ["jsx", "typescript"] },
        plugins: [anchorBabel],
      });
      if (!result?.code) {
        return null;
      }
      return { code: result.code, map: result.map };
    },
  };
}

const runnerSdkShimPath = fileURLToPath(
  new URL("./runner/sdk-shim.ts", import.meta.url),
);

// Dependencies the platform host provides at render time. Externalized so the
// bundle stays small and shares the host's SINGLE live instance — never bundled
// into the app.
//
// `@wonderful/ui-base` is EXTERNALIZED (TEMP REVERT): bundling a full copy of
// ui-base into every app blew the agent app build up with out-of-memory, so we
// no longer bundle it. The app imports the bare specifier `@wonderful/ui-base`,
// which the host import map resolves to its already-served ui-base chunk and
// whose component CSS the host injects into the app's shadow root — exactly like
// React below. React/ReactDOM/jsx-runtime stay external so the bundle shares the
// host's one React instance (two Reacts = broken hooks), and `@wonderful/app-sdk`
// stays external because it's the host<->app bridge that must be the host's
// instance.
//
// NOTE: ui-base ships CSS that only REFERENCES design tokens (`var(--…)`); the
// host injects the token VALUE definitions AND the component CSS into the app's
// shadow root, so styling + dark mode work without bundling any CSS.
const external = [
  "react",
  "react-dom",
  "react/jsx-runtime",
  "@wonderful/ui-base",
  "@wonderful/app-sdk",
  "@wonderful/genui-react",
  // Platform-shared packages — uncomment when you install them so your bundle
  // uses the host's copy instead of shipping its own.
  // See the "URL state" guide in the Wonderful Apps docs.
  // "react-router-dom",
  // "use-query-params",
];

// The shippable app bundle contract, shared by the production build and the
// design build (they differ only in output dir + the source-anchor plugin).
// Return type pins the object to Vite's BuildOptions so `formats: ["es"]` is
// contextually typed as LibraryFormats[] (no `as const`, which would make it
// readonly and break the LibraryOptions assignment).
function libBuild(outDir: string): UserConfig["build"] {
  return {
    outDir,
    emptyOutDir: true,
    lib: {
      entry: "src/index.ts",
      formats: ["es"],
      fileName: "app",
    },
    rollupOptions: { external },
    cssCodeSplit: false,
  };
}

export default defineConfig(({ command, mode }) => {
  if (mode === "runner") {
    return {
      plugins: [svgr({ include: ["**/*.svg", "**/*.svg?react"] }), react()],
      root: "runner",
      server: {
        fs: {
          allow: [".."],
        },
      },
      resolve: {
        alias: {
          "@wonderful/app-sdk": runnerSdkShimPath,
        },
      },
      build: {
        outDir: "../runner-dist",
        emptyOutDir: true,
      },
    };
  }

  if (command === "serve") {
    return {
      plugins: [svgr({ include: ["**/*.svg", "**/*.svg?react"] }), react()],
      root: "dev",
      resolve: {
        alias: {
          "@wonderful/app-sdk": runnerSdkShimPath,
        },
      },
    };
  }

  // Production build. We stamp every host element with an OPAQUE `data-wf-id`
  // and emit a private `wf-source-map.json` sidecar (id → file/line/component).
  // The ids are meaningless without the sidecar, which is never served to
  // deployed clients — the assistant page fetches it and injects `data-source-*`
  // itself. So design-mode anchoring needs no separate bundle.
  const anchor = createSourceAnchorPlugins();
  return {
    plugins: [
      sourceAnchorBabelPlugin(anchor.babel),
      svgr({ include: ["**/*.svg", "**/*.svg?react"] }),
      react(),
      anchor.vite,
    ],
    root: ".",
    build: libBuild("dist"),
  };
});
