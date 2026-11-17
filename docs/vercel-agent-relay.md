# Vercel → Slack → GitHub incident relay

This feature adds an authenticated Vercel webhook receiver at `/api/vercel-webhook` and an on-demand GitHub Actions incident workflow. The receiver **never sends email** and does not automatically merge or deploy code.

## Deployment setup (after merging this PR)

1. In **Vercel → predictir → Settings → Environment Variables**, set these **server-only** variables for Production:
   - `VERCEL_EVENT_PROJECT_ID` = `prj_4yesBcmYUTUoyYvTWS4cOrI0SHkK`.
   - `VERCEL_EVENT_WEBHOOK_SECRET` = secret provided **after** creating the Vercel account webhook.
   - `SLACK_AGENT_OPS_WEBHOOK_URL` = Slack incoming webhook for your private `#agent-ops` channel.
   - `GITHUB_EVENT_DISPATCH_TOKEN` = restricted GitHub fine-grained token (repository **Contents: Read and write** is required by GitHub's dispatch endpoint), scoped **only to** `DaniyalHayat/predictir`. Use a GitHub App installation token instead where feasible. Do not commit secrets.
2. In **Vercel Team Settings → Webhooks**, select the `predictir` project and events `Deployment Error`, `Deployment Succeeded`, and optionally `Alerts Triggered`. Set endpoint to `https://predictir.dev/api/vercel-webhook`. Create the webhook, copy its secret into the Vercel environment variable above, and redeploy once so the secret is available.
3. Vercel Pro/Enterprise is required for account-level webhooks. If using Hobby, prefer direct GitHub Actions notifications and status checks.
4. In GitHub → Actions, confirm **Investigate Vercel incident** is enabled. It can be tested manually via `workflow_dispatch` without generating a real incident.
5. For automated Codex diagnosis later, add an independently permission-scoped Codex workflow triggered by the incident run; require PR review and keep deployments manual.

## Verification
- A request without an `x-vercel-signature` returns 401.
- A signed but wrong-project event is ignored.
- A signed `deployment.error` posts to Slack and dispatches `vercel_incident` to the repository.
- A signed `deployment.succeeded` posts to Slack without dispatching a failure workflow.
- Use Vercel's webhook delivery logs to confirm 2xx responses.

## Safety
Avoid putting raw webhook payloads into Slack or logs: payloads may include metadata. The relay forwards only a few fields. GitHub and Slack credentials stay in server-only Vercel environment variables. Vercel may retry failed deliveries, so any future mutating incident automation must be idempotent on deployment ID.
