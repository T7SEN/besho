# Authentication, Error Handling, Observability, Security

Consolidated reference for cross-cutting concerns. Load when the task touches auth flows, server actions, error boundaries, logging, or security boundaries.

---

## 1. Authentication

- `src/lib/auth-utils.ts` — JWT via `jose`, HS256, 30-day expiry.
- Cookie: `session`, HTTP-only.
- Login writes a sessionStorage `SKIP_BIOMETRIC_KEY` to avoid post-login double-prompt.
- `getCurrentAuthor()` is the canonical client-callable read.

### Canonical session check (server action)

```ts
"use server";

import { cookies } from "next/headers";
import { decrypt } from "@/lib/auth-utils";

async function getSession() {
  const cookieStore = await cookies();
  const value = cookieStore.get("session")?.value;
  if (!value) return null;
  return decrypt(value);
}
```

Note `await cookies()` — Next.js 16 makes it async.

---

## 2. Role-Based Permission Model

Every state-mutating server action **must** check `session.author` server-side, even if the UI hides the button. Server actions are public endpoints — the client is adversarial.

### Permission matrix

| Action                                    | T7SEN (Sir) | Besho (kitten) |
| ----------------------------------------- | ----------- | -------------- |
| Create/complete/reopen rules              | ✓           | ✗              |
| Acknowledge rule                          | ✗           | ✓              |
| Create task                               | ✓           | ✗              |
| Complete task                             | ✗           | ✓              |
| Log ledger entry                          | ✓           | ✗              |
| View safe-word history                    | ✓           | ✗              |
| Send safe-word                            | ✗           | ✓              |
| Write notes / react / set mood / send hug | ✓           | ✓              |

### Canonical role check (copy this shape)

```ts
"use server";

export async function createRule(prevState: unknown, formData: FormData) {
  const session = await getSession();
  if (!session?.author) return { error: "Not authenticated." };
  if (session.author !== "T7SEN") {
    return { error: "Only Sir can set rules." };
  }
  // ... mutation
  return { success: true };
}
```

User-facing copy uses `Sir` / `kitten` via `TITLE_BY_AUTHOR` in `src/lib/constants.ts`. Never hard-code.

---

## 3. Error Handling, Logging, Observability

- `src/lib/logger.ts` — `info`, `warn`, `error`, `interaction`. Log every catch in a server action.
- Sentry: `next.config.ts` + `src/instrumentation.ts`. `tunnelRoute: '/monitoring'`.
- `<ErrorBoundary>` wraps the layout root and individual cards.
- Skeletons (`*Skeleton`) for fallback UI — never blank.
- User-facing errors are plain English.

### Server-action return shape

Every server action consumed by `useActionState` returns `{ success?: true; error?: string }`. **Never throw** — `useActionState` cannot catch. **Never return** `null` / `undefined` — typing breaks.

---

## 4. Security

- Sanitize rich-text input through the Markdown renderer's allowlist. Never `dangerouslySetInnerHTML` raw user content.
- Server-side role checks always. Treat the client as adversarial.
- Never log session JWTs, FCM tokens, or any secret.
- CSRF: server actions are protected by Next's built-in token. Don't disable it.

### Common XSS vectors to refuse

- `dangerouslySetInnerHTML={{ __html: userContent }}` — use `MarkdownRenderer`
- `eval()` or `new Function()` on user input — refuse outright
- URL parameters interpolated into HTML without escaping
- Trusting `request.headers` without validation

---

## 5. Cross-References

- `SKILL.md` Section 0 — pre-flight checklist (role-context identification step)
- `AGENTS.md` Section 3.1 — role-based dynamics summary
- `AGENTS.md` Section 6 — high-level reminder
- `references/refusal-catalog.md` — security-related refusals (XSS, role-skip, etc.)
- `references/code-style.md` Section 6 — server action patterns
