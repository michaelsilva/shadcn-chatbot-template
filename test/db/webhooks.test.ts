import { env } from "cloudflare:workers"
import { describe, expect, it } from "vitest"

import { claimWebhookDelivery, recordWebhookOutcome } from "../../lib/db/webhooks"

describe("webhook_deliveries", () => {
  it("claims a (provider, eventKey) pair exactly once and rejects duplicate deliveries", async () => {
    const first = await claimWebhookDelivery(env, { provider: "fal", eventKey: "evt_1" })
    expect(first.claimed).toBe(true)

    const duplicate = await claimWebhookDelivery(env, { provider: "fal", eventKey: "evt_1" })
    expect(duplicate.claimed).toBe(false)

    // The same eventKey from a different provider is a distinct delivery.
    const otherProvider = await claimWebhookDelivery(env, { provider: "elevenlabs", eventKey: "evt_1" })
    expect(otherProvider.claimed).toBe(true)

    await recordWebhookOutcome(env, { id: first.id, outcome: "delivered" })
    const row = await env.DB.prepare(`SELECT outcome FROM webhook_deliveries WHERE id = ?1`)
      .bind(first.id)
      .first<{ outcome: string }>()
    expect(row?.outcome).toBe("delivered")
  })
})
