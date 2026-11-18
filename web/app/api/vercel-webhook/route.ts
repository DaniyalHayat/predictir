import { createHmac, timingSafeEqual } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";

const EVENTS = new Set([
  "deployment.error",
  "deployment.succeeded",
  "deployment.canceled",
  "deployment.cancelled",
  "alerts.triggered",
]);

function validSignature(body: string, header: string | null, secret: string): boolean {
  if (!header || !/^[a-f0-9]{40}$/i.test(header)) return false;
  const expected = createHmac("sha1", secret).update(body).digest();
  const received = Buffer.from(header, "hex");
  return expected.length === received.length && timingSafeEqual(expected, received);
}

export async function POST(request: NextRequest) {
  const secret = process.env.VERCEL_EVENT_WEBHOOK_SECRET;
  const projectId = process.env.VERCEL_EVENT_PROJECT_ID;
  if (!secret || !projectId) return NextResponse.json({ error: "Not configured" }, { status: 503 });

  const body = await request.text();
  if (Buffer.byteLength(body) > 1_000_000) {
    return NextResponse.json({ error: "Payload too large" }, { status: 413 });
  }
  if (!validSignature(body, request.headers.get("x-vercel-signature"), secret)) {
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }

  let event: Record<string, unknown>;
  try { event = JSON.parse(body); }
  catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }

  const type = String(event.type ?? "");
  if (!EVENTS.has(type)) return NextResponse.json({ ignored: true });

  const payload = (event.payload ?? {}) as Record<string, any>;
  const receivedProject = String(payload.project?.id ?? payload.projectId ?? "");
  if (receivedProject !== projectId) {
    return NextResponse.json({ ignored: true, reason: "Different project" });
  }

  const deployment = (payload.deployment ?? {}) as Record<string, unknown>;
  const deploymentId = String(deployment.id ?? "");
  const dashboardUrl = typeof payload.links?.deployment === "string"
    ? payload.links.deployment : "https://vercel.com/dashboard";
  const target = String(payload.target ?? "unknown");
  const isFailure = type === "deployment.error" || type === "alerts.triggered";
  const status = isFailure ? "🔴" : "🟢";

  const operations: Promise<Response>[] = [];
  const slack = process.env.SLACK_AGENT_OPS_WEBHOOK_URL;
  if (slack) {
    operations.push(fetch(slack, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text: `${status} *predictir Vercel:* ${type} (${target})\nDeployment: ${deploymentId || "n/a"}\n<${dashboardUrl}|View deployment>`,
      }),
      signal: AbortSignal.timeout(8000),
    }));
  }

  const githubToken = process.env.GITHUB_EVENT_DISPATCH_TOKEN;
  if (isFailure && githubToken) {
    operations.push(fetch("https://api.github.com/repos/DaniyalHayat/predictir/dispatches", {
      method: "POST",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${githubToken}`,
        "X-GitHub-Api-Version": "2022-11-28",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        event_type: "vercel_incident",
        client_payload: { event_type: type, deployment_id: deploymentId, deployment_url: dashboardUrl, target },
      }),
      signal: AbortSignal.timeout(8000),
    }));
  }

  const results = await Promise.allSettled(operations);
  const deliveryFailed = results.some((result) =>
    result.status === "rejected" || !result.value.ok
  );
  if (deliveryFailed) {
    console.error("Vercel event relay delivery failed", { type, deploymentId });
    return NextResponse.json({ error: "Forwarding failed" }, { status: 502 });
  }
  return NextResponse.json({ ok: true, forwarded: operations.length });
}
