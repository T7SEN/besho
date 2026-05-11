// packages/cli/src/lib/api.ts
//
// Thin HTTP wrapper around the /api/admin/cli/* routes. Sets the
// bearer header on every request, translates non-2xx into a typed
// `ApiError`, and parses JSON responses. Uses Node 22's native
// `fetch` — no http-client dependency.

import type { CliConfig } from "./config.ts";

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly body: unknown,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

async function request<T>(
  config: CliConfig,
  method: "GET" | "POST",
  path: string,
  body?: unknown,
): Promise<T> {
  const url = `${config.baseUrl}${path}`;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${config.token}`,
    "User-Agent": "ourspace-cli/0.1.0",
  };
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
  }
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch (err) {
    const cause = err instanceof Error ? err.message : "unknown";
    throw new ApiError(
      `Network error reaching ${url}: ${cause}. Is OURSPACE_BASE_URL correct?`,
      0,
      null,
    );
  }

  let parsed: unknown = null;
  const text = await res.text();
  if (text.length > 0) {
    try {
      parsed = JSON.parse(text);
    } catch {
      // Non-JSON body — surface as-is in the error.
      parsed = text;
    }
  }

  if (!res.ok) {
    const message =
      parsed && typeof parsed === "object" && "error" in parsed
        ? String((parsed as { error: unknown }).error)
        : res.statusText || `HTTP ${res.status}`;
    throw new ApiError(message, res.status, parsed);
  }

  return parsed as T;
}

export function get<T>(config: CliConfig, path: string): Promise<T> {
  return request<T>(config, "GET", path);
}

export function post<T>(
  config: CliConfig,
  path: string,
  body?: unknown,
): Promise<T> {
  return request<T>(config, "POST", path, body ?? {});
}
