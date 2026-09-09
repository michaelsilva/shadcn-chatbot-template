import { getCloudflareContext } from "@opennextjs/cloudflare"

import {
  RuntimeProbeWebhookPayloadSchema,
  processRuntimeProbeWebhook,
} from "@/lib/runtime-probe-webhook"

/**
 * Stand-in for a real provider webhook (e.g. a future Fal/queue callback
 * handled by #10). Proves the webhook -> D1 idempotency claim ->
 * `instance.sendEvent()` -> waiting `step.waitForEvent()` path end to end.
 */
export async function POST(req: Request) {
  const body = await req.json().catch(() => null)
  const parsed = RuntimeProbeWebhookPayloadSchema.safeParse(body)
  if (!parsed.success) {
    return Response.json({ error: "Invalid webhook payload." }, { status: 400 })
  }

  const { env } = await getCloudflareContext({ async: true })
  const result = await processRuntimeProbeWebhook(env, parsed.data)

  return Response.json(result)
}
