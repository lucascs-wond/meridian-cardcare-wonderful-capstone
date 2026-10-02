import { createReadStream } from "node:fs";
import { access, stat } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket, WebSocketServer } from "ws";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const workspaceRootDir = path.resolve(__dirname, "..");
const runnerDistDir = path.resolve(workspaceRootDir, "runner-dist");
const viteConfigPath = path.resolve(workspaceRootDir, "vite.config.ts");

const controllerBaseUrl = process.env.CONTROLLER_BASE_URL ?? "http://localhost:5050";
const apiKey = process.env.WONDERFUL_API_KEY ?? "";
const port = Number(process.env.RUNNER_PORT ?? "3200");
const useHmr = process.env.RUNNER_HMR !== "0";

function getTheme(theme) {
  return theme === "dark" ? "dark" : "light";
}

function buildRunnerConfig() {
  return {
    context: {
      tenantId: process.env.RUNNER_TENANT_ID ?? "local-runner-tenant",
      workspaceId: process.env.RUNNER_WORKSPACE_ID ?? "local-runner-workspace",
      userId: process.env.RUNNER_USER_ID ?? "local-runner-user",
      userName: process.env.RUNNER_USER_NAME ?? "Local Runner",
      theme: getTheme(process.env.RUNNER_THEME),
      apiBaseUrl: "/proxy/api/v1",
    },
    proxyPrefix: "/proxy",
  };
}

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

function stripHopByHopHeaders(headers) {
  const filtered = new Headers();
  for (const [key, value] of headers) {
    const lower = key.toLowerCase();
    if (
      lower === "host" ||
      lower === "connection" ||
      lower === "content-length" ||
      lower === "transfer-encoding"
    ) {
      continue;
    }
    filtered.set(key, value);
  }
  return filtered;
}

async function handleProxy(req, res, requestUrl) {
  if (!apiKey) {
    sendJson(res, 500, {
      error: "WONDERFUL_API_KEY is missing. Set it before starting the runner.",
    });
    return;
  }

  const proxyPath = requestUrl.pathname.replace(/^\/proxy/, "") + requestUrl.search;
  const target = new URL(proxyPath, controllerBaseUrl);
  const headers = stripHopByHopHeaders(new Headers(req.headers));
  headers.delete("accept-encoding");

  if (apiKey.startsWith("Bearer ")) {
    headers.set("Authorization", apiKey);
  } else {
    headers.set("X-api-key", apiKey);
  }

  const method = req.method ?? "GET";
  const hasBody = method !== "GET" && method !== "HEAD";

  let upstream;
  try {
    upstream = await fetch(target, {
      method,
      headers,
      body: hasBody ? req : undefined,
      duplex: hasBody ? "half" : undefined,
    });
  } catch (error) {
    sendJson(res, 502, {
      error: "failed to reach controller",
      details: String(error),
    });
    return;
  }

  const responseHeaders = {};
  for (const [key, value] of upstream.headers) {
    const lower = key.toLowerCase();
    if (
      lower === "connection" ||
      lower === "transfer-encoding" ||
      lower === "content-length" ||
      // Node fetch may decode compressed upstream bodies before we forward them.
      // If we keep `content-encoding`, browsers will attempt to decode again.
      lower === "content-encoding"
    ) {
      continue;
    }
    responseHeaders[key] = value;
  }

  const body = Buffer.from(await upstream.arrayBuffer());
  res.writeHead(upstream.status, responseHeaders);
  res.end(body);
}

// Socket sibling of handleProxy: tunnels /proxy/* upgrades upstream, API key injected.
const liveWss = new WebSocketServer({ noServer: true });

function proxyWebSocket(client, requestUrl) {
  const proxyPath =
    requestUrl.pathname.replace(/^\/proxy/, "") + requestUrl.search;
  const target = new URL(proxyPath, controllerBaseUrl);
  target.protocol = target.protocol === "https:" ? "wss:" : "ws:";

  const headers = {};
  if (apiKey.startsWith("Bearer ")) {
    headers.Authorization = apiKey;
  } else {
    headers["X-api-key"] = apiKey;
  }

  const upstream = new WebSocket(target.toString(), { headers });
  const pending = [];

  client.on("message", (data, isBinary) => {
    if (upstream.readyState === WebSocket.OPEN) {
      upstream.send(data, { binary: isBinary });
    } else {
      pending.push([data, isBinary]);
    }
  });
  upstream.on("open", () => {
    for (const [data, isBinary] of pending) {
      upstream.send(data, { binary: isBinary });
    }
    pending.length = 0;
  });
  upstream.on("message", (data, isBinary) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(data, { binary: isBinary });
    }
  });

  const closeBoth = () => {
    try {
      client.close();
    } catch {
      // ignore
    }
    try {
      upstream.close();
    } catch {
      // ignore
    }
  };
  client.on("close", closeBoth);
  upstream.on("close", closeBoth);
  client.on("error", closeBoth);
  upstream.on("error", (error) => {
    console.error("[runner/ws] upstream error:", error?.message ?? error);
    closeBoth();
  });
}

function getMimeType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case ".html":
      return "text/html; charset=utf-8";
    case ".js":
      return "application/javascript; charset=utf-8";
    case ".css":
      return "text/css; charset=utf-8";
    case ".json":
      return "application/json; charset=utf-8";
    case ".svg":
      return "image/svg+xml";
    case ".ico":
      return "image/x-icon";
    case ".map":
      return "application/json; charset=utf-8";
    default:
      return "application/octet-stream";
  }
}

async function resolveStaticPath(urlPathname) {
  const relative = urlPathname === "/" ? "/index.html" : urlPathname;
  const decoded = decodeURIComponent(relative);
  const absolute = path.resolve(runnerDistDir, `.${decoded}`);
  if (!absolute.startsWith(runnerDistDir)) {
    return null;
  }

  try {
    const fileStat = await stat(absolute);
    if (fileStat.isDirectory()) {
      return path.join(absolute, "index.html");
    }
    return absolute;
  } catch {
    if (!path.extname(absolute)) {
      const fallback = path.join(runnerDistDir, "index.html");
      try {
        await access(fallback);
        return fallback;
      } catch {
        return null;
      }
    }
    return null;
  }
}

async function handleStatic(req, res, requestUrl) {
  const staticPath = await resolveStaticPath(requestUrl.pathname);
  if (!staticPath) {
    sendJson(res, 404, { error: "not found" });
    return;
  }

  res.writeHead(200, {
    "Content-Type": getMimeType(staticPath),
    "Cache-Control": "no-store",
  });
  createReadStream(staticPath).pipe(res);
}

async function ensureBuildExists() {
  const entry = path.join(runnerDistDir, "index.html");
  await access(entry);
}

async function main() {
  let viteServer = null;

  const server = createServer(async (req, res) => {
    try {
      const requestUrl = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

      if (requestUrl.pathname === "/runner-config") {
        const runnerConfig = buildRunnerConfig();
        sendJson(res, 200, runnerConfig);
        return;
      }

      if (requestUrl.pathname === "/runner-config.js") {
        const runnerConfig = buildRunnerConfig();
        const payload = `window.__WONDERFUL_RUNNER__ = ${JSON.stringify(runnerConfig)};`;
        res.writeHead(200, {
          "Content-Type": "application/javascript; charset=utf-8",
          "Cache-Control": "no-store",
        });
        res.end(payload);
        return;
      }

      if (requestUrl.pathname.startsWith("/proxy/")) {
        await handleProxy(req, res, requestUrl);
        return;
      }

      if (viteServer) {
        await new Promise((resolve) => {
          viteServer.middlewares(req, res, (error) => {
            if (error) {
              viteServer.ssrFixStacktrace(error);
              sendJson(res, 500, {
                error: "vite middleware error",
                details: String(error),
              });
            }
            resolve();
          });
        });
        return;
      }

      await handleStatic(req, res, requestUrl);
    } catch (error) {
      sendJson(res, 500, {
        error: "runner request failed",
        details: String(error),
      });
    }
  });

  // Only claim /proxy/* upgrades; Vite HMR shares this server, so leave the rest.
  server.on("upgrade", (req, socket, head) => {
    let requestUrl;
    try {
      requestUrl = new URL(
        req.url ?? "/",
        `http://${req.headers.host ?? "localhost"}`,
      );
    } catch {
      return;
    }
    if (!requestUrl.pathname.startsWith("/proxy/")) return;
    if (!apiKey) {
      socket.destroy();
      return;
    }
    liveWss.handleUpgrade(req, socket, head, (client) => {
      proxyWebSocket(client, requestUrl);
    });
  });

  if (useHmr) {
    const { createServer: createViteServer } = await import("vite");
    viteServer = await createViteServer({
      configFile: viteConfigPath,
      mode: "runner",
      appType: "spa",
      server: {
        middlewareMode: true,
        hmr: {
          server,
          port,
        },
      },
    });
  } else {
    try {
      await ensureBuildExists();
    } catch {
      // eslint-disable-next-line no-console
      console.error("runner-dist is missing. Run `pnpm build:runner` first.");
      process.exit(1);
    }
  }

  const shutdown = (signal) => {
    // eslint-disable-next-line no-console
    console.log(`Shutting down runner (${signal})...`);
    server.closeAllConnections();
    process.exit(0);
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  server.listen(port, () => {
    // eslint-disable-next-line no-console
    console.log(`Wonderful runner listening on http://localhost:${port}`);
    // eslint-disable-next-line no-console
    console.log(`Controller base URL: ${controllerBaseUrl}`);

    if (useHmr) {
      // eslint-disable-next-line no-console
      console.log("Mode: HMR (default). Set RUNNER_HMR=0 for static runner-dist mode.");
    } else {
      // eslint-disable-next-line no-console
      console.log("Mode: static runner-dist (HMR disabled).");
    }
  });
}

void main();
