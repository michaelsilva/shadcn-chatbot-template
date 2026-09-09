#!/usr/bin/env node

import { createHash } from "node:crypto"
import { readFile, writeFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"

const BASELINE_URL = new URL("../catalog/workers-ai-baseline.json", import.meta.url)
const API_ROOT = "https://api.cloudflare.com/client/v4"

const args = new Set(process.argv.slice(2))
const refresh = args.has("--refresh")
const remoteRequired = args.has("--remote-required") || refresh

for (const arg of args) {
  if (arg !== "--refresh" && arg !== "--remote-required") {
    throw new Error(`Unknown argument: ${arg}`)
  }
}

const accountId = process.env.CLOUDFLARE_ACCOUNT_ID?.trim()
const apiToken = (
  process.env.CLOUDFLARE_API_TOKEN ?? process.env.CLOUDFLARE_AUTH_TOKEN
)?.trim()

function fail(message) {
  console.error(`catalog: ${message}`)
  process.exitCode = 1
}

function assertBaselineShape(baseline) {
  if (!baseline || typeof baseline !== "object") {
    throw new Error("Workers AI baseline must be a JSON object.")
  }
  if (baseline.version !== 1) {
    throw new Error(`Unsupported Workers AI baseline version: ${baseline.version}`)
  }
  if (typeof baseline.reviewedAt !== "string" || !baseline.reviewedAt) {
    throw new Error("Workers AI baseline must include reviewedAt.")
  }
  if (!baseline.models || typeof baseline.models !== "object") {
    throw new Error("Workers AI baseline must include a models object.")
  }

  for (const [modelId, model] of Object.entries(baseline.models)) {
    if (!modelId.startsWith("@cf/")) {
      throw new Error(`Workers AI baseline contains a non-Workers id: ${modelId}`)
    }
    if (!model || typeof model !== "object") {
      throw new Error(`Invalid baseline record for ${modelId}.`)
    }
    if (model.expectedLifecycle !== "launch") {
      throw new Error(
        `Workers freshness baseline is launch-only; ${modelId} is ${model.expectedLifecycle}.`
      )
    }
    if (
      model.schemaFingerprint !== null &&
      !/^sha256:[a-f0-9]{64}$/.test(model.schemaFingerprint)
    ) {
      throw new Error(`Invalid schema fingerprint for ${modelId}.`)
    }
    if (typeof model.docs !== "string" || !model.docs.startsWith("https://")) {
      throw new Error(`Workers baseline ${modelId} must include an HTTPS docs URL.`)
    }
  }
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalize(value[key])])
    )
  }
  return value
}

function schemaFingerprint(schema) {
  const normalized = JSON.stringify(canonicalize(schema))
  return `sha256:${createHash("sha256").update(normalized).digest("hex")}`
}

async function cloudflare(path, searchParams = {}) {
  const url = new URL(`${API_ROOT}/accounts/${accountId}${path}`)
  for (const [key, value] of Object.entries(searchParams)) {
    url.searchParams.set(key, String(value))
  }

  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${apiToken}` },
  })

  const body = await response.json().catch(() => null)
  if (!response.ok || body?.success === false) {
    const errors = Array.isArray(body?.errors)
      ? body.errors.map((error) => error?.message ?? JSON.stringify(error)).join("; ")
      : ""
    throw new Error(
      `Cloudflare ${response.status} for ${url.pathname}: ${errors || response.statusText}`
    )
  }

  return body
}

function modelRows(payload) {
  if (Array.isArray(payload?.result)) return payload.result
  if (Array.isArray(payload?.data)) return payload.data
  if (Array.isArray(payload?.result?.data)) return payload.result.data
  return []
}

function objectContainsExactString(value, target, depth = 0) {
  if (depth > 4) return false
  if (value === target) return true
  if (Array.isArray(value)) {
    return value.some((item) => objectContainsExactString(item, target, depth + 1))
  }
  if (value && typeof value === "object") {
    return Object.values(value).some((item) =>
      objectContainsExactString(item, target, depth + 1)
    )
  }
  return false
}

function hasExactModel(payload, modelId) {
  const rows = modelRows(payload)
  return rows.some((row) => {
    if (typeof row === "string") return row === modelId
    if (!row || typeof row !== "object") return false

    const directIds = [
      row.id,
      row.name,
      row.model,
      row.model_id,
      row.modelId,
      row.slug,
    ]
    if (directIds.some((value) => value === modelId)) return true

    // Cloudflare intentionally documents the default search response as unknown.
    // Keep the fallback exact-only so response-shape changes do not silently
    // match a partial model name or description.
    return objectContainsExactString(row, modelId)
  })
}

async function searchModel(modelId, { includeDeprecated, hideExperimental }) {
  return cloudflare("/ai/models/search", {
    search: modelId,
    include_deprecated: includeDeprecated,
    hide_experimental: hideExperimental,
    per_page: 100,
    format: "openrouter",
  })
}

async function inspectLifecycle(modelId) {
  const [inclusive, nonDeprecated, nonExperimental] = await Promise.all([
    searchModel(modelId, { includeDeprecated: true, hideExperimental: false }),
    searchModel(modelId, { includeDeprecated: false, hideExperimental: false }),
    searchModel(modelId, { includeDeprecated: false, hideExperimental: true }),
  ])

  const exists = hasExactModel(inclusive, modelId)
  const active = hasExactModel(nonDeprecated, modelId)
  const stable = hasExactModel(nonExperimental, modelId)

  return {
    exists,
    deprecated: exists && !active,
    experimental: active && !stable,
  }
}

async function getModelSchema(modelId) {
  const body = await cloudflare("/ai/models/schema", { model: modelId })
  if (!body?.result?.input || !body?.result?.output) {
    throw new Error(`Cloudflare returned no input/output schema for ${modelId}.`)
  }
  return { input: body.result.input, output: body.result.output }
}

const baseline = JSON.parse(await readFile(BASELINE_URL, "utf8"))
assertBaselineShape(baseline)

const modelIds = Object.keys(baseline.models).sort()
console.log(`catalog: static Workers baseline valid (${modelIds.length} launch models)`)

if ((!accountId && apiToken) || (accountId && !apiToken)) {
  throw new Error(
    "Set both CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN (or neither)."
  )
}

if (!accountId || !apiToken) {
  if (remoteRequired) {
    throw new Error(
      "Remote Workers catalog validation requires CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN."
    )
  }
  console.log(
    "catalog: remote Workers validation skipped (Cloudflare credentials not configured)"
  )
  process.exit(0)
}

const refreshedFingerprints = {}

for (const modelId of modelIds) {
  try {
    const lifecycle = await inspectLifecycle(modelId)
    if (!lifecycle.exists) {
      fail(`${modelId} is missing from Workers AI Model Search.`)
      continue
    }
    if (lifecycle.deprecated) {
      fail(`${modelId} is deprecated according to Workers AI Model Search.`)
      continue
    }
    if (lifecycle.experimental) {
      fail(`${modelId} is experimental but is declared launch in our baseline.`)
      continue
    }

    const schema = await getModelSchema(modelId)
    const currentFingerprint = schemaFingerprint(schema)
    refreshedFingerprints[modelId] = currentFingerprint

    const expectedFingerprint = baseline.models[modelId].schemaFingerprint
    if (!refresh && expectedFingerprint === null) {
      fail(
        `${modelId} has no reviewed schema fingerprint. Review the current Workers schema, then run pnpm catalog:refresh-workers.`
      )
      continue
    }
    if (!refresh && expectedFingerprint !== currentFingerprint) {
      fail(
        `${modelId} schema drifted. Expected ${expectedFingerprint}; current ${currentFingerprint}. Review before refreshing the baseline.`
      )
      continue
    }

    console.log(
      `catalog: ${modelId} active/stable; schema ${currentFingerprint.slice(0, 20)}…`
    )
  } catch (error) {
    fail(`${modelId}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

if (process.exitCode) process.exit(process.exitCode)

if (refresh) {
  const today = new Date().toISOString().slice(0, 10)
  const next = {
    ...baseline,
    reviewedAt: today,
    models: Object.fromEntries(
      modelIds.map((modelId) => [
        modelId,
        {
          ...baseline.models[modelId],
          schemaFingerprint: refreshedFingerprints[modelId],
        },
      ])
    ),
  }

  await writeFile(BASELINE_URL, `${JSON.stringify(next, null, 2)}\n`)
  console.log(`catalog: refreshed ${fileURLToPath(BASELINE_URL)} (${today})`)
} else {
  console.log("catalog: remote Workers lifecycle/schema validation passed")
}
