import { spawnSync } from "node:child_process"
import { mkdir, readFile, rm, writeFile } from "node:fs/promises"
import path from "node:path"

const root = process.cwd()
const tempRoot = path.join(
  root,
  "node_modules",
  ".cache",
  "shadcn-atomic-integration"
)
const sourceDir = path.join(tempRoot, "src")
const outDir = path.join(tempRoot, "dist")

const sourceFiles = [
  "lib/model-catalog.ts",
  "lib/model-catalog-data.ts",
  "lib/atomic-executor-core.ts",
  "lib/atomic-executor.ts",
  "lib/atomic-executor.integration.contract.ts",
]

const sdkStub = `
export function createWorkersAI() {
  return (modelId: string) => ({ protocol: "workers-ai", modelId })
}

export function createAnthropic() {
  return (modelId: string) => ({ protocol: "messages", modelId })
}

export function createOpenAI() {
  return {
    responses(modelId: string) {
      return { protocol: "responses", modelId }
    },
    chat(modelId: string) {
      return { protocol: "chat-completions", modelId }
    },
  }
}
`

function fail(message) {
  console.error(message)
  process.exitCode = 1
}

try {
  await rm(tempRoot, { recursive: true, force: true })
  await mkdir(sourceDir, { recursive: true })
  await writeFile(
    path.join(tempRoot, "package.json"),
    JSON.stringify({ type: "commonjs" })
  )
  await writeFile(path.join(sourceDir, "ai-sdk-stubs.ts"), sdkStub)

  for (const sourcePath of sourceFiles) {
    let source = await readFile(path.join(root, sourcePath), "utf8")

    // Production aliases and ESM SDK packages are correct for the application.
    // The disposable CommonJS harness rewrites only its local copies so runtime
    // tests can isolate our dispatch/transport logic. Full repo typecheck still
    // validates the real SDK imports and their Cloudflare types.
    if (sourcePath === "lib/model-catalog-data.ts") {
      const productionImport = 'from "@/lib/model-catalog"'
      if (!source.includes(productionImport)) {
        throw new Error(
          "Expected production model-catalog alias was not found; integration harness needs review."
        )
      }
      source = source.replace(productionImport, 'from "./model-catalog"')
    }

    if (sourcePath === "lib/atomic-executor.ts") {
      for (const packageName of [
        "@ai-sdk/anthropic",
        "@ai-sdk/openai",
        "workers-ai-provider",
      ]) {
        const productionImport = `from "${packageName}"`
        if (!source.includes(productionImport)) {
          throw new Error(
            `Expected production SDK import ${packageName} was not found; integration harness needs review.`
          )
        }
        source = source.replace(productionImport, 'from "./ai-sdk-stubs"')
      }
    }

    await writeFile(path.join(sourceDir, path.basename(sourcePath)), source)
  }

  const tscPath = path.join(root, "node_modules", "typescript", "bin", "tsc")
  const compile = spawnSync(
    process.execPath,
    [
      tscPath,
      ...sourceFiles.map((sourcePath) =>
        path.join(sourceDir, path.basename(sourcePath))
      ),
      path.join(sourceDir, "ai-sdk-stubs.ts"),
      path.join(root, "cloudflare-env.d.ts"),
      "--module",
      "commonjs",
      "--moduleResolution",
      "node",
      "--target",
      "es2022",
      "--lib",
      "es2022,dom",
      "--outDir",
      outDir,
      "--skipLibCheck",
      "--esModuleInterop",
    ],
    { cwd: root, stdio: "inherit" }
  )

  if (compile.status !== 0) {
    fail(`Atomic integration TypeScript compilation failed (${compile.status}).`)
  } else {
    const run = spawnSync(
      process.execPath,
      [path.join(outDir, "atomic-executor.integration.contract.js")],
      { cwd: root, stdio: "inherit" }
    )

    if (run.status !== 0) {
      fail(`Atomic integration contract failed (${run.status}).`)
    }
  }
} finally {
  await rm(tempRoot, { recursive: true, force: true })
}
