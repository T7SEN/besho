import { SignJWT, jwtVerify } from "jose";

const secretKey = process.env.AUTH_SECRET_KEY;
const encodedKey = new TextEncoder().encode(secretKey);

export interface SessionPayload {
  isAuthenticated: boolean;
  author: "T7SEN" | "Besho";
  expiresAt: string;
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
    return payload as unknown as SessionPayload;
  } catch (err) {
    console.error("Failed to verify session", err);
    return null;
  }
}
