// src/lib/redis.ts
//
// Process-wide Upstash Redis client singleton. Every other module
// imports `redis` from here — there is exactly ONE `new Redis({...})`
// call across the whole codebase. Module init runs once per cold
// start, so the client is reused across every request handled by a
// given worker.
//
// Why centralize: each `new Redis({...})` instantiates an HTTP/2 REST
// client with its own connection pool. With ~30 modules each minting
// their own at module-eval time, a Vercel cold start would build 30
// pools before the first request even ran. One singleton = one pool.
//
// `import "server-only"` ensures this never ships to the client
// bundle. The KV_REST_API_* env vars are server-side secrets; if a
// component accidentally imports this file, the `server-only`
// pragma turns it into a build error rather than a runtime leak.

import "server-only";
import { Redis } from "@upstash/redis";

export const redis = new Redis({
  url: process.env.KV_REST_API_URL!,
  token: process.env.KV_REST_API_TOKEN!,
});
