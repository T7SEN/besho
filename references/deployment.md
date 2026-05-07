# Deployment

Reference for Vercel (web) and Android (Capacitor) deployment pipelines, environment variables, secrets, and verification.

> **Tier: Vercel Hobby.** Notable consequences:
>
> - **Vercel Cron is unused on this project.** Hobby caps cron at once-per-day, and any `vercel.json` cron schedule more frequent than that breaks the build outright. **Cron-job.org is the sole trigger** for `/api/cron/*` (see below). There is intentionally no `vercel.json` in the repo.
> - 12 serverless functions max (we're well under).
> - 100 GB bandwidth / month (a 2-user app is nowhere near).
> - No team members on the project.
>
> Mention this any time you propose new cron / scheduled work — every cron-style trigger goes through cron-job.org's dashboard, never `vercel.json`. Adding a `vercel.json` with crons will fail the next deploy.

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

### Cron triggers

The single trigger for every `/api/cron/*` endpoint is **cron-job.org** (free tier, 1-minute cadence). There is no `vercel.json` cron entry — Hobby would reject it at build time.

The endpoint authenticates via `Authorization: Bearer ${CRON_SECRET}` — refuses any request without it. Per-target dedup (e.g. `ritual:fcm:sent:{ritualId}:{owningDateKey}` for ritual windows, atomic `SET NX EX 36h`) makes accidental double-fires safe.

**Configuration (out-of-band, in the cron-job.org dashboard):**

- URL: `https://t7senlovesbesho.me/api/cron/ritual-windows`
- Method: `GET`
- Schedule: `* * * * *` (every minute)
- Time zone: `Africa/Cairo` (cosmetic — endpoint computes Cairo time internally either way)
- Timeout: 30 seconds
- Headers: `Authorization: Bearer <CRON_SECRET>` matching the Vercel env var
- Save responses in job history: ON — endpoint returns tiny JSON `{ok, scanned, fired, dedupHits, durationMs}` that's invaluable for diagnosis
- Notify on failure: ON to the operator's email — this is your only outage signal
- Auto-disable on repeated failures: ON

The cron-job.org account is single-tenant (operator's own), not in the repo. Treat it as out-of-band infra. If access is lost or the account is suspended, the endpoint and dedup logic are unaffected — re-create the cron entry pointing at the same URL.

**No fallback trigger.** If cron-job.org is down, no FCMs fire from cron until access is restored. Local notifications scheduled by the rituals page still fire on-device on Android (the only reminder layer that runs offline). If `cron-job.org` reliability becomes a real problem, options are: (1) a second cron-job.org-equivalent vendor pointed at the same URL (dedup makes parallel fires safe), or (2) Vercel Pro upgrade so `vercel.json` can run minute-cadence cron natively.

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
| `CRON_SECRET`           | Bearer token for Vercel Cron auth — required for `/api/cron/*` to run; Vercel injects it into the cron request as `Authorization: Bearer ...` |

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

### Adding a new Capacitor plugin — checklist

1. `pnpm add @capacitor/<plugin-name>@^8` (match the Capacitor 8 line).
2. `npx cap sync android` — registers the plugin's native bridge in the Android project.
3. If the plugin needs new permissions, edit `android/app/src/main/AndroidManifest.xml`.
4. Bump `versionCode` in `android/app/build.gradle`.
5. Rebuild and sideload the APK.

Until step 2 + 5 ship, the JS layer will load but native calls fall back silently because the bridge isn't registered. The dynamic-import + try/catch pattern absorbs this without crashing.

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

Besho's Honor: same procedure. After install, the app loads from `t7senlovesbesho.me`. Confirm FCM registration succeeds and `push:fcm:Besho` is populated; if registration fails for any reason (permissions, network, OEM quirks), push history still surfaces via `NotificationDrawer`.

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
- [ ] `/admin` redirects to `/` when logged in as Besho (verify the layout guard fires)
- [ ] `/admin/devices` "Right now" section polls every 5s and shows live presence + masked FCM token preview (was the standalone `/admin/inspector` page; merged in)
- [ ] `/admin/push-test` form sends a custom FCM and the kitten device receives it (bypasses presence)
- [ ] `/admin/activity` shows at least the most recent `[admin]` interaction event from the test push
- [ ] Soft-delete: delete a throwaway note → confirm it appears in `/admin/trash` → restore → it's back at its original list position
- [ ] `/admin/sessions` "Force logout" on Besho invalidates her active session within 5 seconds (kitten device redirects to login on next nav)
- [ ] `/admin` "Summon kitten" two-step button delivers a max-priority FCM to Besho's device (bypasses presence; Android opens with sound + heads-up regardless of foreground state)
- [ ] `/admin/devices` lists T7SEN's APK as online with a populated fingerprint (manufacturer · model · Android version · app version) and coarse coords; backgrounding the app for 90s flips it to offline while preserving the last-known state
- [ ] Restraint toggle on `/admin` engages with two-step confirm; while on, Besho's note submission returns `"Sir put you on restraint."` and safeword still works
- [ ] Wrong passcode at `/login` lands a record in `/admin/auth-log` within seconds (records IP + UA, never the passcode)
- [ ] `/admin/stats` renders all sections without 5xx; numbers update after a fresh note / task / ledger entry
- [ ] `/admin/health` shows Redis OK + both FCM tokens registered; Reseed indexes button corrects a deliberately-mis-set `notes:count:*`
- [ ] `/admin/dates` round-trips a date edit and the dashboard CounterCard reflects the change after refresh
- [ ] `/admin/mood` overrides write `mood:{today}:{author}` AND `state:{today}:{author}` (per-author state options) and the home Mood card picks up both changes
- [ ] Create a ritual with a `windowStart` 1–2 minutes in the future; the owner receives an FCM at the window-open instant (delivered by the `ritual-windows` cron, in addition to the local notification)

---

## Cross-References

- `next.config.ts` — Sentry wiring, tunnel route
- `src/instrumentation.ts` — Sentry runtime registration
- `capacitor.config.ts` — appId, appName, webDir, **server.url**
- `android/app/build.gradle` — versionCode, versionName, applicationId
- `package.json` — packageManager, engines, version
- [`./push-routing.md`](./push-routing.md) — push delivery details
- [`./capacitor-native.md`](./capacitor-native.md) — Capacitor plugin handling, hosted-webapp architecture
