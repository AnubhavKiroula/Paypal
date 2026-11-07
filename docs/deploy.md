# Deploy runbook: Render

**Related:** [render.yaml](../render.yaml) · [tech stack](tech-stack.md) · [architecture](architecture.md)

The API, the web app and Postgres are described as code in [`render.yaml`](../render.yaml) (a Render Blueprint): `mandate-api` (Node web service), `mandate-web` (static site) and `mandate-db` (Postgres 17).

## Deployment

| Service | URL | Plan |
|---|---|---|
| API (`mandate-api`) | `<api-url>` | Free |
| Web app (`mandate-web`) | `<web-url>` | Free (static) |
| Postgres (`mandate-db`) | private to the Render workspace (no external connections) | Free, created 2026-11-07 |

The live URLs are deliberately not published here. The API has no login or rate limit yet, so a public URL invites abuse of the LLM quota (see Known limits). Get them from the Render dashboard or a teammate.

Render adds a random suffix (`mandate-api-xxxx.onrender.com`) when a service name is already taken on `onrender.com`. **Never guess a URL**: the unsuffixed names belong to other people's services. Copy each URL from its service page.

## First deploy

1. Render dashboard → **New → Blueprint** → `PxA-Labs/Paypal` → branch `main` → name `mandate`. An org member can connect the org repo: the Blueprint page shows "You are deploying from a Blueprint for PxA-Labs/Paypal" when Render can read it.
2. Render asks for every `sync: false` variable. Enter what you have now, then fix the URLs in step 4. **Names only below. Never paste values into git, issues, PRs or chat.** Judges get sandbox credentials only through the Devpost testing instructions (hard rule 7).

   | Variable | Set on | Value | Needed for |
   |---|---|---|---|
   | `DATABASE_URL` | mandate-api | Set by Render from `mandate-db` | Everything |
   | `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET` | mandate-api | Sandbox app credentials (developer.paypal.com → Apps & Credentials → **Sandbox**) | Purchases |
   | LLM key (`ANTHROPIC_API_KEY` today) | mandate-api | The team's LLM key | Purchases |
   | `WEB_ORIGIN` | mandate-api | The web app URL, no trailing slash | The browser calling the API (CORS) |
   | `WEB_APP_URL` | mandate-api | The web app URL | Review links in approval messages |
   | `ZAPIER_APPROVAL_WEBHOOK_URL` | mandate-api | Zapier Catch Hook ([zapier.md](zapier.md)) | Approval messages (optional) |
   | `PAYPAL_RETURN_URL`, `PAYPAL_CANCEL_URL` | mandate-api | Where PayPal sends the buyer back. Default `https://example.com/paypal/...` | Optional |
   | `PAYPAL_WEBHOOK_ID` | mandate-api | Id of the webhook on the sandbox app (see below) | Webhook route (optional: the 60 s reconcile job also settles orders) |
   | `VITE_API_URL` | mandate-web | The **API** URL | The web app. Compiled into public JavaScript at build time, so never a secret, and a change needs a rebuild |

3. **Deploy Blueprint.** Render creates `mandate-db`, builds both services and starts `mandate-api` with `pnpm db:migrate && pnpm db:seed && pnpm --filter @mandate/api start`. The demo seed only inserts missing rows, so it is safe on every boot. The free plan has no Shell or pre-deploy command to run it once by hand.
4. Copy the real URLs from the two service pages. Set `WEB_ORIGIN` and `WEB_APP_URL` on **mandate-api** to the web URL, and `VITE_API_URL` on **mandate-web** to the API URL. Then **Save, rebuild, and deploy** each.
5. Check from your machine:

   ```sh
   pnpm smoke:deployed https://<api> --web https://<web>
   pnpm smoke:deployed https://<api> --web https://<web> --purchase   # also submits one purchase
   ```

   It prints one PASS/FAIL line per check (health, Postgres, demo mandate, dashboard summary, CORS, and with `--purchase`, a purchase decision) and exits non-zero on any failure. It prints status codes only, never bodies or configuration. `--purchase` is opt-in because an `ALLOW` holds demo budget and opens a sandbox PayPal order.

At boot the API logs `feature disabled: configuration missing` with the **names** of missing variables, never their values, and still serves `/health` and `/ready`. Purchases are registered only when the database, PayPal and LLM settings are all present.

## PayPal webhook

1. developer.paypal.com → **Apps & Credentials → Sandbox** → the app → **Sandbox Webhooks → Add Webhook**.
2. URL: `https://<api>/webhooks/paypal`. Events: `CHECKOUT.ORDER.APPROVED`, `PAYMENT.CAPTURE.COMPLETED`, `PAYMENT.CAPTURE.PENDING`, `PAYMENT.CAPTURE.DENIED`. The handler only triggers a reconcile from PayPal's `getOrder`, and never trusts the payload for money state.
3. Copy the **Webhook ID** into `PAYPAL_WEBHOOK_ID` on mandate-api and redeploy. The route is registered only when it is set.

`VERIFY`: the event list and a signature check against a delivery from PayPal's webhook simulator.

## Every deploy after that

Merging to `main` deploys automatically (`autoDeployTrigger: commit`). Migrations run on boot. If one fails, the new version does not start and the previous one keeps serving.

Background jobs run inside the API every 60 s: expired approvals are swept, and orders in `UNKNOWN_OUTCOME` are reconciled from PayPal. This assumes **one instance**. The sweep locks each row, but `reconcile()` does not, so don't scale out until it does.

## Rollback

Service → **Events** → pick the last good deploy → **Rollback**. Migrations are forward-only: roll back code, then fix the schema with a new migration, never by editing an applied one (the runner refuses edited migrations).

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| A URL answers with someone else's app (e.g. `x-render-origin-server: uvicorn`) | The name was taken; Render added a suffix to ours | Use the URL from the service page |
| Smoke: `demo mandate HTTP 404 MANDATE_NOT_FOUND` | Demo data not seeded | Redeploy with the current `render.yaml` start command |
| Smoke: `origin not allowed (set WEB_ORIGIN)`; browser console shows CORS errors | `WEB_ORIGIN` on mandate-api is not exactly the web URL | Set it (scheme + host, no trailing slash) and redeploy mandate-api |
| The web app calls `127.0.0.1:3000` or its own URL | `VITE_API_URL` unset or wrong at **build** time | Fix it on mandate-web, then rebuild |
| Smoke: `purchases disabled` | A purchase variable is missing | The API boot log names it |
| First request takes about a minute | Free web services sleep after 15 minutes idle | Expected on the free plan; open the URL before a demo |

## Known limits

From Render's free-plan docs (render.com/docs/free, read 2026-11-07; check before relying on them):

| Item | Why it matters |
|---|---|
| **Free Postgres expires 30 days after creation**, then is inaccessible for a 14-day grace period, then deleted. No backups | Ours was created 2026-11-07, so it stops working about **2026-12-07**, before judging ends. Upgrade `mandate-db` to a paid plan before then (price: check render.com/pricing) |
| **Free web services sleep** after 15 minutes without traffic and take about a minute to wake | Judges may see a slow first load. Consider a paid instance for judging |
| One free Postgres per workspace; 750 free instance hours per month | Don't create a second free database in the same workspace |
| **No authentication yet** (#10 follow-up) | The API is public, and the demo user ids are in the repo, so anyone with the URL can edit the demo mandate or submit sandbox purchases. Sandbox only: no real money moves |
| Region `singapore` | Close to the team. Judges are mostly US-based; latency is acceptable for a demo |
