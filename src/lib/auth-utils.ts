import { SignJWT, jwtVerify } from "jose";
import { redis } from "./redis";

const secretKey = process.env.AUTH_SECRET_KEY;
const encodedKey = new TextEncoder().encode(secretKey);

export interface SessionPayload {
  isAuthenticated: boolean;
  author: "T7SEN" | "Besho";
  expiresAt: string;
}

interface EpochCacheEntry {
  value: number;
  until: number;
}
const epochCache = new Map<string, EpochCacheEntry>();
const EPOCH_CACHE_MS = 5_000;

async function readSessionEpoch(
  author: "T7SEN" | "Besho",
): Promise<number> {
  const now = Date.now();
  const cached = epochCache.get(author);
  if (cached && cached.until > now) return cached.value;
  try {
    const raw = await redis.get<number | string>(`session:epoch:${author}`);
    const value =
      typeof raw === "number" ? raw : raw == null ? 0 : Number(raw);
    const safe = Number.isFinite(value) ? value : 0;
    epochCache.set(author, { value: safe, until: now + EPOCH_CACHE_MS });
    return safe;
  } catch {
    return 0;
  }
}

export async function encrypt(payload: SessionPayload) {
  return await new SignJWT(payload as unknown as Record<string, unknown>)
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("30d")
    .sign(encodedKey);
}

export async function decrypt(
  session: string | undefined = "",
): Promise<SessionPayload | null> {
  try {
    const { payload } = await jwtVerify(session, encodedKey, {
      algorithms: ["HS256"],
    });

    const data = payload as unknown as SessionPayload & { iat?: number };
    const author = data.author;
    if (author !== "T7SEN" && author !== "Besho") return data;

    const iatMs = typeof data.iat === "number" ? data.iat * 1000 : 0;
    const epoch = await readSessionEpoch(author);
    if (epoch > 0 && iatMs < epoch) return null;

    return data;
  } catch {
    return null;
  }
}

/**
 * Bump the per-author session epoch so all currently-issued JWTs for
 * that author become invalid. The next decrypt reads the new epoch and
 * rejects any JWT issued before it. Cache TTL is 5 seconds, so the
 * cutover is effectively immediate at request scale.
 */
export async function revokeAuthorSessions(
  author: "T7SEN" | "Besho",
): Promise<void> {
  const at = Date.now();
  await redis.set(`session:epoch:${author}`, at);
  epochCache.set(author, { value: at, until: at + EPOCH_CACHE_MS });
}

/**
 * Read the current epoch for both authors (for the admin sessions
 * page). Bypasses the cache so the UI always shows ground truth.
 */
export async function readAllSessionEpochs(): Promise<
  Record<"T7SEN" | "Besho", number>
> {
  const [t, b] = await Promise.all([
    redis.get<number | string>("session:epoch:T7SEN"),
    redis.get<number | string>("session:epoch:Besho"),
  ]);
  const toN = (v: number | string | null) => {
    if (v == null) return 0;
    const n = typeof v === "number" ? v : Number(v);
    return Number.isFinite(n) ? n : 0;
  };
  return { T7SEN: toN(t), Besho: toN(b) };
}
