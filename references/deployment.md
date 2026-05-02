# Deployment

Reference for Vercel (web) and Android (Capacitor) deployment pipelines, environment variables, secrets, and verification.

## Topology

```
GitHub (t7sen/our-space)
    │
    ├──→ Vercel ──→ https://t7senlovesbesho.me      (web, PWA-less, API routes, Edge SSE)
    │                       ↑
    │                       └──── Both phones load this URL via Capacitor's WebView
    │
    └──→ Local clone ──→ npx cap sync android ──→ Android Studio ──→ signed APK
                              (only when Capacitor config or plugins change)
```

The architecture is **hosted-webapp Capacitor**. The APK is a thin native shell that loads the live Vercel deployment. See [`./capacitor-native.md`](./capacitor-native.md) Section "Architecture" for full rationale.

**Practical implication:** APK rebuilds are rare. Most "releases" are Vercel deploys. You'll bump `versionCode` only when `capacitor.config.ts` or native plugins change.

---

## Vercel — Web

### Auto-deploy

Vercel watches the `main` branch and deploys on every push. Preview deployments are created for any other branch.

Build command (auto-detected from pnpm lockfile):

```bash
pnpm install --frozen-lockfile
pnpm build
```

If you ever see `Lockfile not found` in build logs, `pnpm-lock.yaml` is gitignored or missing — fix it.

### Required environment variables

All set in **Vercel → Project → Settings → Environment Variables**. Production environment.

| Variable                | Purpose                                           |
| ----------------------- | ------------------------------------------------- |
| `AUTH_SECRET_KEY`       | JWT signing secret (HS256). 32+ random bytes.     |
| `KV_REST_API_URL`       | Upstash Redis REST URL                            |
| `KV_REST_API_TOKEN`     | Upstash Redis REST token                          |
| `FIREBASE_PROJECT_ID`   | Firebase project ID for FCM                       |
| `FIREBASE_CLIENT_EMAIL` | Service account email                             |
| `FIREBASE_PRIVATE_KEY`  | Service account private key with **literal `\n`** |
| `SENTRY_AUTH_TOKEN`     | For source-map upload at build time               |

> **Removed:** `VAPID_EMAIL`, `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `NEXT_PUBLIC_VAPID_PUBLIC_KEY` are no longer used. Web Push was removed when PWA was dropped. If your Vercel project still has these set, delete them — they're dead config.

### `FIREBASE_PRIVATE_KEY` quirk

Multi-line PEM keys do not survive being pasted into env vars across most CI systems. The convention is to escape newlines as literal `\n`:

```
FIREBASE_PRIVATE_KEY=-----BEGIN PRIVATE KEY-----\nMIIEv...\n-----END PRIVATE KEY-----\n
```

Server code converts at runtime:

```ts
privateKey: process.env.FIREBASE_PRIVATE_KEY!.replace(/\\n/g, "\n");
```

**Don't change this.** If `firebase-admin` errors with `Failed to parse private key`, the `\n` literals were resolved too early — re-paste the env var with literal backslash-n sequences.

### Sentry

- Org: `t7sen-c0`
- Project: `our-space`
- Tunnel route: `/monitoring` (set via `next.config.ts`)
- Source maps: uploaded automatically when `SENTRY_AUTH_TOKEN` is present
- Tree-shaking: `removeDebugLogging: true` strips `Sentry.logger.*` calls in production

The tunnel route exists to bypass ad-blockers. Confirm it does not collide with any middleware matchers if you add middleware.

### Custom domain

`t7senlovesbesho.me` → Vercel project. DNS via the registrar's CNAME to `cname.vercel-dns.com`. No www subdomain.

The domain is **load-bearing** because it's hard-coded in `capacitor.config.ts` (`server.url`). If you ever change the domain, you must rebuild and redistribute the APK with the new URL.

### Deployment verification

After every push to `main`:

1. Open the Vercel deployments tab.
2. Confirm the build succeeded (green check).
3. Hit `https://t7senlovesbesho.me/api/presence` in a browser; should return some response (even an auth error is fine — it proves the route exists).
4. Open the APK on T7SEN's device — confirm it loads the new content.
5. Send a note from T7SEN, confirm SSE delivery on Besho's device.

If any of these fail, **redeploy without build cache** before investigating further.

---

## Lockfile

`pnpm-lock.yaml` **must be committed**. CI uses `pnpm install --frozen-lockfile`.

`package.json` should pin the package manager:

```json
{
  "packageManager": "pnpm@9.15.0",
  "engines": {
    "node": ">=20",
    "pnpm": ">=9"
  }
}
```

Local installs after a `pnpm add` regenerate the lockfile — commit it in the same commit as the `package.json` change.

---

## Android — Capacitor

### When to rebuild the APK

Because of the `server.url` architecture, the APK is rebuilt **only** when:

- `capacitor.config.ts` changes (plugin config, `appName`, splash screen, status bar, etc.)
- A new Capacitor plugin is added or removed
- Android-side native code or manifest changes (permissions, file provider, etc.)
- Releasing a versioned APK for install on a device for the first time

**Routine code changes do NOT require an APK rebuild.** They ship via Vercel and the WebView picks them up on next launch.

### Prerequisites

- Android Studio with the Android 14 SDK or newer
- JDK 17+
- The keystore at `C:\Users\T7SEN\keys\ourspace.jks`

### Build

```bash
cd /path/to/our-space
pnpm install --frozen-lockfile
npx cap sync android          # Apply capacitor.config.ts to android/
```

Then in Android Studio:

1. Open the `android/` folder as a project.
2. **Build → Generate Signed Bundle / APK** → APK → Release.
3. Select the keystore. Enter the passwords (which are not in the repo — they live in your password manager).
4. Build → APK lands in `android/app/build/outputs/apk/release/`.

### `versionCode` discipline

Bump `android/app/build.gradle` for every release:

```gradle
versionCode 14
versionName "1.4.0"
```

`versionCode` is a monotonically increasing integer. Skipping numbers is fine. Repeating a number is not — Android refuses to install an APK with `versionCode <= installed`.

`versionName` should track `package.json`'s `version` field for traceability.

### Sideload to devices

T7SEN's Samsung: enable **Install from unknown sources** for whatever file manager you use. Tap the APK to install.

Besho's Honor: same procedure. After install, the app loads from `t7senlovesbesho.me`. FCM registration will fail (no GMS) — this is expected. Push history surfaces via `NotificationDrawer`.

### `appId` is sacred

`me.t7senlovesbesho`. **Never change it.** Changing the application ID:

- Treats every device as a fresh install
- Resets biometric enrollment (Preferences keys are namespaced by appId)
- Invalidates FCM tokens
- Strands the old icon on the home screen until manually removed

Display name (`appName: 'Our Space'` in `capacitor.config.ts`) is what the user reads — change it freely.

---

## Renames

- **GitHub repo rename:** safe, auto-redirects.
- **Vercel project rename:** changes the `*.vercel.app` subdomain only; custom domain unaffected.
- **`package.json` `name`:** safe.
- **`appName` in `capacitor.config.ts`:** safe, regenerates `strings.xml` on `cap sync`.
- **`appId` in `capacitor.config.ts`:** **destructive**, see above.
- **Custom domain (`t7senlovesbesho.me`):** **destructive** — requires APK rebuild because `server.url` is hard-coded. Plan ahead.

---

## Smoke Test Checklist

Run this after every non-trivial deploy:

- [ ] `https://t7senlovesbesho.me` loads on desktop
- [ ] Login works for both accounts
- [ ] FloatingNavbar badge counts populate
- [ ] `/notes` SSE delivers a new note within 10s
- [ ] Push notification fires on T7SEN's Samsung when not on `/notes`
- [ ] Push notification is **suppressed** when partner is on `/notes`
- [ ] Biometric unlock on T7SEN's Samsung after backgrounding
- [ ] Toggle airplane mode on T7SEN's APK → offline banner appears, submit button disables
- [ ] Disable airplane mode → banner disappears, submit re-enables
- [ ] APK install replaces existing app without resetting biometric enrollment (only relevant when bumping `versionCode`)
- [ ] Sentry receives at least one event from the new release (check the Sentry dashboard)

---

## Cross-References

- `next.config.ts` — Sentry wiring, tunnel route
- `src/instrumentation.ts` — Sentry runtime registration
- `capacitor.config.ts` — appId, appName, webDir, **server.url**
- `android/app/build.gradle` — versionCode, versionName, applicationId
- `package.json` — packageManager, engines, version
- [`./push-routing.md`](./push-routing.md) — push delivery details
- [`./capacitor-native.md`](./capacitor-native.md) — Capacitor plugin handling, hosted-webapp architecture
