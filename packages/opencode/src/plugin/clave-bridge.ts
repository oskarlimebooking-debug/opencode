import fs from "fs"
import path from "path"
import type { Hooks, Plugin as PluginInstance } from "@opencode-ai/plugin"

/**
 * CLAVE BRIDGE — fork-only internal plugin for the Clave desktop app.
 *
 * Clave drives opencode headlessly (`opencode run`) and inside tmux-backed
 * PTYs (bare TUI). Neither surface gives it a deterministic way to read the
 * final assistant text or detect completion — scraping an alt-screen TUI via
 * `capture-pane` is guesswork. This plugin turns bus events into two plain
 * files the host app can watch. It is INERT unless Clave sets the env vars:
 *
 *   CLAVE_STATE_FILE  — JSONL, one line per state change:
 *                       {"ts":…,"status":"running"|"idle"|"error","sessionID":…,"summary":…}
 *   CLAVE_OUTPUT_FILE — final assistant text of the session, written
 *                       atomically (tmp + rename) each time a session goes idle.
 *
 * Every write is best-effort: the bridge must never crash or slow the CLI.
 */

type StateStatus = "running" | "idle" | "error"

export interface ClaveStateLine {
  ts: number
  status: StateStatus
  sessionID?: string
  summary?: string
}

export function formatStateLine(input: ClaveStateLine): string {
  return JSON.stringify({
    ts: input.ts,
    status: input.status,
    ...(input.sessionID ? { sessionID: input.sessionID } : {}),
    ...(input.summary ? { summary: input.summary.slice(0, 200) } : {}),
  })
}

export const ClaveBridgePlugin: PluginInstance = async () => {
  const stateFile = process.env["CLAVE_STATE_FILE"]
  const outputFile = process.env["CLAVE_OUTPUT_FILE"]
  if (!stateFile && !outputFile) return {}

  // Last completed assistant text per session — flushed to CLAVE_OUTPUT_FILE
  // when that session goes idle.
  const lastText = new Map<string, string>()
  let lastHeartbeatAt = 0

  const writeState = (status: StateStatus, sessionID?: string, summary?: string) => {
    if (!stateFile) return
    try {
      fs.mkdirSync(path.dirname(stateFile), { recursive: true })
      fs.appendFileSync(stateFile, formatStateLine({ ts: Date.now(), status, sessionID, summary }) + "\n")
    } catch {
      // best-effort only
    }
  }

  const flushOutput = (sessionID: string) => {
    if (!outputFile) return
    const text = lastText.get(sessionID)
    if (!text) return
    try {
      fs.mkdirSync(path.dirname(outputFile), { recursive: true })
      const tmp = outputFile + ".tmp"
      fs.writeFileSync(tmp, text, "utf-8")
      fs.renameSync(tmp, outputFile)
    } catch {
      // best-effort only
    }
  }

  const hooks: Hooks = {
    event: async ({ event }) => {
      try {
        const properties = event.properties as any
        if (event.type === "message.part.updated") {
          const part = properties?.part
          if (!part?.sessionID) return
          if (part.type === "text" && part.time?.end && typeof part.text === "string" && part.text.trim()) {
            lastText.set(part.sessionID, part.text)
            writeState("running", part.sessionID, part.text)
            return
          }
          // Tool churn = alive. Heartbeat at most every 5s to keep the file small.
          if (part.type === "tool" && Date.now() - lastHeartbeatAt > 5_000) {
            lastHeartbeatAt = Date.now()
            writeState("running", part.sessionID)
          }
          return
        }
        if (event.type === "session.error") {
          const err = properties?.error
          let message = err ? String(err.name ?? "error") : "error"
          if (err && "data" in err && err.data && "message" in err.data) message = String(err.data.message)
          writeState("error", properties?.sessionID, message)
          return
        }
        if (event.type === "session.status" && properties?.status?.type === "idle") {
          const sessionID = properties?.sessionID
          writeState("idle", sessionID)
          if (sessionID) flushOutput(sessionID)
        }
      } catch {
        // never let bridging break the CLI
      }
    },
  }
  return hooks
}
