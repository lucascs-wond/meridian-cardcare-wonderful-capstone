declare module "@wonderful/app-sdk" {
  export interface WonderfulAPI {
    fetch(path: string, options?: RequestInit): Promise<Response>;
    get<T = unknown>(path: string): Promise<T>;
    post<T = unknown>(path: string, body?: unknown): Promise<T>;
    put<T = unknown>(path: string, body?: unknown): Promise<T>;
    del(path: string): Promise<void>;
    /** Open an authenticated WebSocket to a controller endpoint (e.g. `/communications/{id}/live`). Internal apps only. */
    openSocket(path: string): WebSocket;
    invokeFunction<T = unknown>(slug: string, options?: { method?: "GET" | "POST" | "PUT" | "DELETE" | "PATCH"; params?: Record<string, unknown> }): Promise<T>;
  }

  export interface WonderfulContext {
    tenantId: string;
    workspaceId: string;
    userId: string;
    userName: string;
    theme: "light" | "dark";
    apiBaseUrl: string;
    /** Base URL for function invocation in external mode (e.g. "/app-functions/TOKEN"). */
    functionBaseUrl?: string;
  }

  export interface WonderfulSDK {
    context: WonderfulContext;
    api: WonderfulAPI;
    /** Record a custom analytics event, viewable in the app's Analytics tab. Works in every mode, incl. share links. */
    track(name: string, properties?: Record<string, unknown>): void;
    /** Evaluate a per-app A/B feature flag for the current visitor: false (off/unknown), true (on), or the assigned variant key. Stable per visitor. */
    getFlag(key: string): boolean | string;
  }

  export function useWonderful(): WonderfulSDK;
}
