import { afterEach, describe, expect, test } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"
// Warm the app runtime so the preload's afterAll dispose does not first-import
// it during teardown (clave-bridge itself is dependency-free, unlike the other
// plugin tests whose src imports initialize the runtime as a side effect).
import "@/effect/app-runtime"
import { ClaveBridgePlugin, formatStateLine } from "@/plugin/clave-bridge"
import type { PluginInput } from "@opencode-ai/plugin"

const INPUT = {} as PluginInput

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "clave-bridge-"))
}

async function fire(hooks: Awaited<ReturnType<typeof ClaveBridgePlugin>>, type: string, properties: unknown) {
  await hooks.event?.({ event: { type, properties } as any })
}

const savedEnv = { state: process.env["CLAVE_STATE_FILE"], output: process.env["CLAVE_OUTPUT_FILE"] }

afterEach(() => {
  if (savedEnv.state === undefined) delete process.env["CLAVE_STATE_FILE"]
  else process.env["CLAVE_STATE_FILE"] = savedEnv.state
  if (savedEnv.output === undefined) delete process.env["CLAVE_OUTPUT_FILE"]
  else process.env["CLAVE_OUTPUT_FILE"] = savedEnv.output
})

describe("clave-bridge", () => {
  test("inert without env vars — returns no hooks", async () => {
    delete process.env["CLAVE_STATE_FILE"]
    delete process.env["CLAVE_OUTPUT_FILE"]
    const hooks = await ClaveBridgePlugin(INPUT)
    expect(hooks.event).toBeUndefined()
  })

  test("formatStateLine truncates summary to 200 chars and drops empty fields", () => {
    const line = JSON.parse(formatStateLine({ ts: 1, status: "running", summary: "x".repeat(500) }))
    expect(line.summary.length).toBe(200)
    expect("sessionID" in line).toBe(false)
  })

  test("text part end → running line; idle → idle line + output file", async () => {
    const dir = tmpDir()
    const stateFile = path.join(dir, "state.jsonl")
    const outputFile = path.join(dir, "out.md")
    process.env["CLAVE_STATE_FILE"] = stateFile
    process.env["CLAVE_OUTPUT_FILE"] = outputFile

    const hooks = await ClaveBridgePlugin(INPUT)
    await fire(hooks, "message.part.updated", {
      part: { type: "text", sessionID: "s1", text: "# Plan\n\ndone", time: { end: 123 } },
    })
    await fire(hooks, "session.status", { sessionID: "s1", status: { type: "idle" } })

    const lines = fs.readFileSync(stateFile, "utf-8").trim().split("\n").map((l) => JSON.parse(l))
    expect(lines.map((l) => l.status)).toEqual(["running", "idle"])
    expect(lines[0].sessionID).toBe("s1")
    expect(fs.readFileSync(outputFile, "utf-8")).toBe("# Plan\n\ndone")
  })

  test("session.error → error line with message from error.data", async () => {
    const dir = tmpDir()
    const stateFile = path.join(dir, "state.jsonl")
    process.env["CLAVE_STATE_FILE"] = stateFile
    delete process.env["CLAVE_OUTPUT_FILE"]

    const hooks = await ClaveBridgePlugin(INPUT)
    await fire(hooks, "session.error", {
      sessionID: "s2",
      error: { name: "ProviderAuthError", data: { message: "no providers are available" } },
    })

    const line = JSON.parse(fs.readFileSync(stateFile, "utf-8").trim())
    expect(line.status).toBe("error")
    expect(line.summary).toContain("no providers are available")
  })

  test("idle without any captured text writes no output file", async () => {
    const dir = tmpDir()
    const outputFile = path.join(dir, "out.md")
    process.env["CLAVE_STATE_FILE"] = path.join(dir, "state.jsonl")
    process.env["CLAVE_OUTPUT_FILE"] = outputFile

    const hooks = await ClaveBridgePlugin(INPUT)
    await fire(hooks, "session.status", { sessionID: "s3", status: { type: "idle" } })

    expect(fs.existsSync(outputFile)).toBe(false)
  })
})
