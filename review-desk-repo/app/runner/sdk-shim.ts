type ThemeMode = "light" | "dark";

export interface WonderfulAPI {
  fetch(path: string, options?: RequestInit): Promise<Response>;
  get<T = unknown>(path: string): Promise<T>;
  post<T = unknown>(path: string, body?: unknown): Promise<T>;
  put<T = unknown>(path: string, body?: unknown): Promise<T>;
  del(path: string): Promise<void>;
  openSocket(path: string): WebSocket;
  invokeFunction<T = unknown>(
    slug: string,
    options?: {
      method?: "GET" | "POST" | "PUT" | "DELETE" | "PATCH";
      params?: Record<string, unknown>;
    },
  ): Promise<T>;
}

export interface WonderfulContext {
  tenantId: string;
  workspaceId: string;
  userId: string;
  userName: string;
  theme: ThemeMode;
  apiBaseUrl: string;
}

export interface WonderfulSDK {
  context: WonderfulContext;
  api: WonderfulAPI;
  /** Record a custom analytics event (host-provided in production; no-op in the local runner). */
  track(name: string, properties?: Record<string, unknown>): void;
  /** Evaluate a per-app A/B flag (host-provided in production; always false in the local runner). */
  getFlag(key: string): boolean | string;
}

interface WonderfulRunnerBootstrap {
  context: WonderfulContext;
  proxyPrefix: string;
}

declare global {
  interface Window {
    __WONDERFUL_RUNNER__?: WonderfulRunnerBootstrap;
  }
}

function normalizePath(path: string): string {
  if (path.startsWith("/")) {
    return path;
  }
  return `/${path}`;
}

function buildProxyPath(prefix: string, path: string): string {
  const normalizedPath = normalizePath(path);
  if (normalizedPath.startsWith("/api/")) {
    return `${prefix}${normalizedPath}`;
  }
  return `${prefix}/api/v1${normalizedPath}`;
}

async function parseResponse(response: Response): Promise<unknown> {
  if (response.status === 204) {
    return undefined;
  }
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    return response.json();
  }
  return response.text();
}

async function request<T>(
  method: string,
  proxyPrefix: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const requestPath = buildProxyPath(proxyPrefix, path);
  const headers = new Headers();
  if (body !== undefined) {
    headers.set("Content-Type", "application/json");
  }

  const response = await fetch(requestPath, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  if (!response.ok) {
    const errorBody = await parseResponse(response);
    const message =
      typeof errorBody === "string" && errorBody
        ? errorBody
        : `request failed: ${response.status}`;
    throw new Error(message);
  }

  return parseResponse(response) as Promise<T>;
}

function createAPI(proxyPrefix: string): WonderfulAPI {
  return {
    fetch: async (path: string, options?: RequestInit) => {
      const requestPath = buildProxyPath(proxyPrefix, path);
      return fetch(requestPath, options);
    },
    get: async <T = unknown>(path: string) =>
      request<T>("GET", proxyPrefix, path),
    post: async <T = unknown>(path: string, body?: unknown) =>
      request<T>("POST", proxyPrefix, path, body),
    put: async <T = unknown>(path: string, body?: unknown) =>
      request<T>("PUT", proxyPrefix, path, body),
    del: async (path: string) => {
      await request<unknown>("DELETE", proxyPrefix, path);
    },
    openSocket: (path: string): WebSocket => {
      // Same-origin proxy URL; the runner upgrades it and injects the API key.
      const proxyPath = buildProxyPath(proxyPrefix, path);
      const scheme = window.location.protocol === "https:" ? "wss:" : "ws:";
      return new WebSocket(`${scheme}//${window.location.host}${proxyPath}`);
    },
    invokeFunction: async <T = unknown>(_slug: string, _options?: unknown): Promise<T> => {
      throw new Error(
        "runner shim does not support invokeFunction; for local development call api.fetch('/api/v1/functions/<slug>') directly. " +
          "See https://docs.wonderful.cx/build/apps/integrating/functions#local-development",
      );
    },
  };
}

export function useWonderful(): WonderfulSDK {
  const bootstrap = window.__WONDERFUL_RUNNER__;
  if (!bootstrap) {
    throw new Error(
      "Wonderful runner is not initialized. Missing window.__WONDERFUL_RUNNER__",
    );
  }
  return {
    context: bootstrap.context,
    api: createAPI(bootstrap.proxyPrefix),
    // Analytics + flags are host-provided in production; local runner no-ops.
    track: (name: string, properties?: Record<string, unknown>) => {
      console.debug("[wonderful.track]", name, properties);
    },
    getFlag: (key: string): boolean | string => {
      console.debug("[wonderful.getFlag]", key, "-> false (runner shim)");
      return false;
    },
  };
}
