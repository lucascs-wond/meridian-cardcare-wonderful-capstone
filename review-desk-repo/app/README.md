# Wonderful App Template

Minimal starter for building a Wonderful App bundle.

## What You Get

- Tiny React app entry (`src/index.ts` + `src/App.tsx`)
- Library-mode Vite build that outputs `dist/app.js` and optional `dist/style.css`
- Packaging script that creates a zip with:
  - build files from `dist/`
  - `manifest.json` containing the uploaded file list

## Quick Start

```bash
pnpm install
pnpm dev
```

Dev server runs standalone at the URL printed by Vite (typically `http://localhost:5173`).

### Optional GenUI

GenUI is not installed in the base template. If the app imports
`GenUISurface` or another export from `@wonderful/genui-react`, opt in with the
pinned development dependency:

```bash
pnpm add -D @wonderful/genui-react@0.2.0
```

The development dependency provides types for `tsc --noEmit` and updates this
app's lockfile. The package remains external in Vite because the Wonderful host
provides the runtime module; it is not bundled into the app.

## Build and Package

```bash
pnpm build
pnpm package
```

Output zip is created in `dist/`, for example:

- `dist/wonderful-app-template-1.0.0.zip`

You can override version at package time:

```bash
BUNDLE_VERSION=1.2.3 pnpm package
```

## Run Locally with Runner (No Upload Needed)

The runner serves the app directly from local build output and proxies API calls to the controller using a server-side credential.

1. Start runner (HMR mode by default):

```bash
pnpm runner
```

2. Provide runner environment:

```bash
WONDERFUL_API_KEY="<API_KEY_OR_BEARER_TOKEN>" \
CONTROLLER_BASE_URL="https://wonderful.api.dev.wonderful.cx" \
RUNNER_PORT=3200 \
pnpm runner
```

3. Open:

```text
http://localhost:3200
```

Optional static mode (requires prebuild):

```bash
pnpm build:runner
RUNNER_HMR=0 pnpm runner
```

### Runner Environment Variables

- `WONDERFUL_API_KEY` (required):
  - If value starts with `Bearer `, runner forwards it as `Authorization`.
  - Otherwise runner forwards it as `X-api-key`.
- `CONTROLLER_BASE_URL` (optional): defaults to `http://localhost:5050`
- `RUNNER_PORT` (optional): defaults to `3200`
- `RUNNER_TENANT_ID` (optional): context value shown to the app
- `RUNNER_WORKSPACE_ID` (optional): context value shown to the app
- `RUNNER_USER_ID` (optional): context value shown to the app
- `RUNNER_USER_NAME` (optional): context value shown to the app
- `RUNNER_THEME` (optional): `light` (default) or `dark`

## Upload Flow

There are two ways to upload and activate a bundle. Both end at the same place.

### Manual UI (recommended for first uploads)

1. Build and package your bundle:

```bash
pnpm build
pnpm package
```

2. Sign in to the Wonderful web app.
3. Open **Apps** and create a new app (or open an existing one).
4. Go to **Versions** (or **Upload version**), select the zip from `dist/` (for example `dist/wonderful-app-template-1.0.0.zip`), and upload it.
5. Activate the uploaded version from the same page.

### Scripted (API key)

Bundle upload is also supported via the controller API — useful for CI or scripted releases. The four-step flow (`POST /api/v2/apps`, `POST /apps/:id/upload/init` → presigned URL, `PUT` the zip, `POST /apps/:id/upload/complete`, `PUT /apps/:id/versions/:vid/activate`) is documented in `wonderful-app-demo-internal/README.md` with copy-pasteable curl recipes.

Use runner mode (`pnpm runner`) for fast local iteration before uploading.
