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

  for (const sourcePath of sourceFiles) {
    let source = await readFile(path.join(root, sourcePath), "utf8")

    // The production alias is correct for Next/tsconfig. The temporary CommonJS
    // harness copies the file outside that alias environment, so rewrite exactly
    // this import only in the disposable test copy.
    if (sourcePath === "lib/model-catalog-data.ts") {
      const productionImport = 'from "@/lib/model-catalog"'
      if (!source.includes(productionImport)) {
        throw new Error(
          "Expected production model-catalog alias was not found; integration harness needs review."
        )
      }
      source = source.replace(productionImport, 'from "./model-catalog"')
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
