# Sprint 1: PairCoder-native integration into opencode

> **PLAN ONLY — do not execute yet.**
>
> Goal: implement PairCoder (v2 / `paircoder2`, repo `PAIR/`) functionality
> **directly into opencode** as first-class TypeScript packages + plugin hooks,
> rather than shelling out to the Python CLI.
>
> ## Why this architecture (decision summary)
>
> - **TS-native core (`packages/paircoder`)** — opencode is a Bun/TS monorepo with
>   its own plugin bus, command system, agents, session server, storage, and
>   per-message token/cost accounting. Reimplementing the *contracts* (`.paircoder/`
>   on-disk format, backlog grammar, gates) in TS gives zero-IPC enforcement and
>   lets engage run on opencode sessions instead of headless `claude` spawns.
> - **`.paircoder/` stays the data contract** (per PC23.4 cutover intent: "one
>   CLI, one `.paircoder/`"). paircoder2 (Python) remains readable/writable-compatible;
>   migration is import, not fork.
> - **Engage on opencode sessions, not subprocess spawns.** This structurally
>   resolves the *unexecuted* ERHR6 phase (nested-session env poisoning, parent
>   Bash timeouts, no detached mode): opencode's server already provides
>   background sessions with pollable status.
>
> ## Unexecuted PAIR plans honored (they change the design)
>
> - **ERHR v2 (pending)** → baked in from day one, not retrofitted:
>   gates scope to **task-modified files only** (ERHR4.1/4.2); engage pre-flight
>   detects pre-existing gate debt (ERHR4.3); honest non-zero exit/status for
>   paused/blocked runs (ERHR5.3); `runs`/`task reset` management surface — no
>   sqlite hand-edits (ERHR5.1/5.2); strict test isolation from the real
>   `.paircoder/` (ERHR5.4); corrupt-neighbor-tolerant task lookup (ERHR2.2);
>   detached runs with pollable status (ERHR6.2 — free via opencode server).
> - **PC13 (pending, P0)** → no hollow core: reviewer is real from the first
>   engage run; cost/tokens come from opencode's real usage data (PC13.2 becomes
>   trivial); `requires: human` routes through opencode's permission/question
>   system (PC13.3); model routing uses opencode's provider registry (PC13.4).
> - **PC14–PC23 parity backlog (pending)** → used as the parity map. Explicitly
>   **in scope**: plan/task authoring, arch, review, engage flags, metrics/cost/
>   budget, containment checkpoints, state/audit groups. **Deferred** (same
>   waiver logic as PAIR's own backlog): Trello/PM webhooks (PC15), licensing/
>   subscription (PC22), QC/benchmark (PC19.2–3), fleet (PC21.4).
> - **Coordination rule:** ERHR work in PAIR may still land in the Python repo;
>   this sprint treats PAIR as read-only reference. Any contract change ERHR
>   introduces (runs.db schema, config keys) must be mirrored here (OC1.29).

### Phase 1: Decisions, scaffold, contracts

### OC1.1 — ADR: integration architecture + parity map | Cx: 5 | P0

**Description:** Write `packages/paircoder/ADR-001.md`: TS-native core, plugin
hook wiring, engage-on-sessions, `.paircoder/` compatibility, and a parity table
mapping every PC13–PC23 item to {port | defer | superseded-by-opencode}. Cite
ERHR v2 items as design constraints.

**AC:**
- [ ] AC1: ADR exists and enumerates all PC13–PC23 tasks with a disposition each
- [ ] AC2: All ERHR v2 tasks mapped to a design decision or an explicit "N/A in opencode because X"
- [ ] AC3: Deferred waivers listed (Trello, licensing, QC, fleet)

**Depends on:** None

### OC1.2 — Scaffold `packages/paircoder` + `packages/paircoder-plugin` | Cx: 5 | P0

**Description:** New workspace packages following opencode monorepo conventions
(tsconfig, turbo, bun test). `paircoder` = pure domain core (no opencode
imports); `paircoder-plugin` = the opencode `Plugin` that wires hooks/commands.

**AC:**
- [ ] AC1: `bun test` and typecheck pass for both empty packages in CI
- [ ] AC2: Core package has zero dependency on `@opencode-ai/*`

**Depends on:** OC1.1

### OC1.3 — `.paircoder/` contract layer: config + atomic storage | Cx: 8 | P0

**Description:** TS reader/writer for `.paircoder/config.yaml` (schema-validated,
unknown-key tolerant so paircoder2 files round-trip) and crash-safe atomic
temp-file+rename writes (port of `storage/atomic.py` semantics), plus
`capabilities.yaml` and directory bootstrap (`init`).

**AC:**
- [ ] AC1: Reads PAIR's real `.paircoder/config.yaml` without loss on rewrite (byte-stable for untouched keys)
- [ ] AC2: All writes atomic; kill-mid-write test leaves valid prior file
- [ ] AC3: Bootstrap creates the full skeleton on an empty repo

**Depends on:** OC1.2

### OC1.4 — Plan/task parsers + repository + state.md loop | Cx: 13 | P0

**Description:** Port PC4.1/4.2: `*.plan.yaml` + `*.task.md` parse/serialize
(round-trip PAIR fixtures), task repository with **corrupt-neighbor tolerance**
(ERHR2.2: one malformed file must not poison lookups), and the state.md context
loop (last/next/rotate, monthly archive rotation).

**AC:**
- [ ] AC1: Round-trips PAIR's existing 137 task files and all plan YAMLs unchanged
- [ ] AC2: Corrupt-neighbor test: garbage `.task.md` alongside valid ones → lookups still succeed, one warning
- [ ] AC3: state.md update + 30-day rotation covered by tests

**Depends on:** OC1.3

### Phase 2: Backlog grammar and engage front end

### OC1.5 — Backlog grammar + parser + schema validation | Cx: 8 | P0

**Description:** Port PC9.1 grammar exactly (separators, `Cx`, `P0-P9`,
phases, depends_on, AC, `Requires: human`, `External tools`), including the
PC-E050 no-AC redirect. Fixture-test against PAIR's six real backlogs.

**AC:**
- [ ] AC1: Parses all six PAIR backlogs to the same task/phase counts as `paircoder2 engage --dry-run`
- [ ] AC2: Zero-AC backlog rejected with actionable error

**Depends on:** OC1.4

### OC1.6 — Materializer + `--dry-run` | Cx: 5 | P0

**Description:** Backlog → plan YAML + task files via the OC1.4 serializers;
dry-run prints task count, total Cx, dependency graph, and **pre-flight gate-debt
report** (ERHR4.3: run gates on the current tree; warn if pre-existing debt
would block task 1).

**AC:**
- [ ] AC1: Dry-run writes nothing; real run materializes attached to one canonical plan
- [ ] AC2: Pre-flight reports pre-existing lint/type/test debt distinctly from task failures

**Depends on:** OC1.5

### Phase 3: Enforcement — gates and hooks on the opencode bus

### OC1.7 — Gate engine scoped to task-modified files | Cx: 13 | P0

**Description:** Deterministic gates (lint, typecheck, tests, arch limits)
computed over `git diff` of the task's changes only — ERHR4.1/4.2 as the
default behavior, never repo-wide. Pluggable per-language commands from config;
repo-wide mode only via explicit flag.

**AC:**
- [ ] AC1: Repo with seeded pre-existing errors: task touching a clean file passes gates
- [ ] AC2: Same repo, task introducing an error in its own diff: gate fails with file-scoped report
- [ ] AC3: Arch limits (file/function size, counts) configurable and enforced on modified files

**Depends on:** OC1.4

### OC1.8 — Edit-time enforcement via `tool.execute.before` | Cx: 8 | P0

**Description:** Port PC4.4 enforce contracts into the plugin: intercept
Edit/Write on `.task.md` (illegal status transitions, AC tampering) and
`state.md` (format), pure allow/deny with structured deny reason. Audited
bypass path (config flag → `security/bypass_log.jsonl`).

**AC:**
- [ ] AC1: Illegal task status transition via Edit tool is denied with the rule id
- [ ] AC2: Bypass allowed only when configured, and appends an audit record
- [ ] AC3: Non-paircoder file edits unaffected (<1 ms overhead path)

**Depends on:** OC1.7

### OC1.9 — Containment baseline via `permission.ask` + checkpoints | Cx: 8 | P1

**Description:** Port §13 containment: default-deny/readonly baseline ∪ config
allowlist mapped onto opencode's permission system; git checkpoint create/
list/rollback (PC20.1) using opencode's snapshot/worktree facilities.

**AC:**
- [ ] AC1: Denied-category tool call is blocked in containment mode, allowed otherwise
- [ ] AC2: `checkpoint` → mutate → `rollback` restores tree in a fixture repo

**Depends on:** OC1.8

### Phase 4: Roles, commands, context injection

### OC1.10 — Navigator/Driver/Reviewer as opencode agents | Cx: 8 | P0

**Description:** Ship the three role agents (`.opencode/agent` definitions in
the plugin package) with paircoder workflow prompts; reviewer gets read-only +
gate tools; driver gets TDD workflow instructions.

**AC:**
- [ ] AC1: Three agents installed and selectable; reviewer cannot write files
- [ ] AC2: Prompts reference state.md discipline and `task done` gating

**Depends on:** OC1.4

### OC1.11 — Command surface: plan/task/status/context | Cx: 8 | P0

**Description:** opencode commands (`/pc-plan`, `/start-task`, `/draft-backlog`,
`/pc-status`, `/pc-context-sync`) + programmatic command group covering PC14.1
core authoring verbs (`plan new|add-task|complete`, `task next|check|ac|update`,
`state` group per PC14.8 minimal).

**AC:**
- [ ] AC1: `/start-task` claims a task, injects its spec + AC into the session, sets in_progress
- [ ] AC2: `task done` runs the OC1.7 gate + dependency check; `--no-strict` audited
- [ ] AC3: `/pc-status` shows active plan/task/sprint from repository state

**Depends on:** OC1.7, OC1.10

### OC1.12 — Context auto-injection via chat hooks | Cx: 5 | P1

**Description:** On session start / prompt submit, inject compact paircoder
context (active plan, in-progress task, state.md "what's next", stale-state
reminder) via `experimental.chat.system.transform` — the opencode-native
replacement for PC5.4's SessionStart/UserPromptSubmit adapters.

**AC:**
- [ ] AC1: Injected block present when `.paircoder/` exists, absent otherwise
- [ ] AC2: Stale state (>N days since update) produces a visible reminder

**Depends on:** OC1.11

### Phase 5: Engage orchestrator on opencode sessions

### OC1.13 — Crash-safe run state + runs management | Cx: 8 | P0

**Description:** Run state as SQLite (WAL, one atomic commit per mutation —
PC9.2 semantics) in `.paircoder/data/`, plus the ERHR5 surface: `engage runs`,
`engage task reset <id>`, and **orphaned-run self-healing** (stale `running`
with no live session → reconciled on next command; ERHR5.2). No hand-edits ever
required.

**AC:**
- [ ] AC1: kill -9 mid-run leaves resumable state; `--resume` continues correctly
- [ ] AC2: Orphaned `running` row auto-reconciles with a logged reason
- [ ] AC3: `task reset` returns a failed task to pending without touching others

**Depends on:** OC1.6

### OC1.14 — Executor: dependency frontier on child sessions | Cx: 13 | P0

**Description:** Engage executor runs the dependency frontier concurrently
(semaphore `--max-parallel`), each task as an **opencode child session** (driver
agent) via the server API — no external `claude` spawn, so ERHR6.1 env
sanitization is moot by construction. Per-task commit with task id; failed task
blocks dependents; 50% phase circuit breaker.

**AC:**
- [ ] AC1: Fixture backlog (mock model) runs tasks in dependency order, parallel where allowed
- [ ] AC2: Circuit breaker halts phase at 50% failures; `--resume` after fix completes it
- [ ] AC3: Each completed task = one commit containing its id

**Depends on:** OC1.13, OC1.11

### OC1.15 — Findings loop with a real reviewer | Cx: 8 | P0

**Description:** driver→review→fix loop (PC9.3) where the reviewer is the OC1.10
reviewer agent + OC1.7 deterministic gates — PC13.1 "real reviewer" from day
one. Pass resolves; driver failure short-circuits; cap exhaustion → blocked.

**AC:**
- [ ] AC1: Seeded gate failure produces a fix attempt then pass within cap
- [ ] AC2: Exhausted cap marks task blocked, run continues per breaker rules

**Depends on:** OC1.14

### OC1.16 — Human gate + honest exit + detached mode | Cx: 8 | P0

**Description:** `Requires: human` tasks pause via opencode's question/permission
UI (PC13.3). Run completion status is **honest**: paused/blocked ⇒ non-zero CLI
exit and non-success status (ERHR5.3). Detached mode: run continues server-side
in background sessions; `engage status <run>` polls (ERHR6.2).

**AC:**
- [ ] AC1: Human-gated fixture task pauses and resumes on approval
- [ ] AC2: Paused/blocked terminal state exits non-zero with a summary
- [ ] AC3: Detached run pollable; status shows per-task states live

**Depends on:** OC1.15

### Phase 6: Cost, budget, telemetry (real numbers)

### OC1.17 — Telemetry from opencode usage events | Cx: 8 | P1

**Description:** Per-task/per-session records (tokens, cost, model, duration)
sourced from opencode's existing per-message accounting — fulfilling PC13.2 with
real data. Append-only JSONL source of truth in `.paircoder/telemetry/` (format-
compatible with paircoder2) + queryable store.

**AC:**
- [ ] AC1: Engage fixture run produces one record per task with nonzero token fields
- [ ] AC2: JSONL readable by paircoder2's cost reporting (schema parity test)

**Depends on:** OC1.14

### OC1.18 — Budget gates + forecast + statusline | Cx: 5 | P1

**Description:** Port PC8.2/8.3: budget status/check against `--limit-usd`/
tokens, audited `--budget-override`, plan forecast from calibration averages,
and a TUI statusline segment.

**AC:**
- [ ] AC1: Over-budget task start blocked; override audited
- [ ] AC2: Forecast excludes done tasks and labels confidence

**Depends on:** OC1.17

### OC1.19 — Model routing via provider registry | Cx: 5 | P1

**Description:** PC13.4: per-task model selection (complexity/type → model)
using opencode's provider/model registry, with persisted routing decisions and
demotion on repeated failure. No hardcoded model ids (ERHR2.3: denylist test
for stale ids).

**AC:**
- [ ] AC1: Routing decision persisted per task; demotion after N failures observable
- [ ] AC2: Stale-model-id denylist test passes across the package

**Depends on:** OC1.17

### Phase 7: Review pipeline and GitHub lifecycle

### OC1.20 — `review branch|task` on gates + reviewer agent | Cx: 8 | P0

**Description:** PC16.3 core: structured review of a branch/task diff — 
deterministic gates (task-scoped) + reviewer-agent findings, merged into one
report with severities.

**AC:**
- [ ] AC1: Review of a seeded-issue branch reports both gate and agent findings
- [ ] AC2: Clean branch reviews clean

**Depends on:** OC1.15

### OC1.21 — Engage full lifecycle: branch → security audit → PR | Cx: 8 | P1

**Description:** PC16.4: engage creates `engage/{stem}` (refuses protected
branches), runs pre-PR security audit over the full diff, pushes and opens a PR
via `gh`, posts reviewer summary. Degrades gracefully without `gh`.

**AC:**
- [ ] AC1: Protected-branch refusal tested; branch auto-created otherwise
- [ ] AC2: Missing `gh` → run succeeds locally with an actionable warning

**Depends on:** OC1.16, OC1.20

### Phase 8: Migration, parity gate, hardening

### OC1.22 — `import-from-paircoder2` + coexistence guard | Cx: 5 | P1

**Description:** One-command adoption of an existing `.paircoder/` (validate,
migrate schema versions, report diffs). Durable stomp-guard: warn when an
external paircoder2/bpsai-pair process rewrites config (ERHR5.5 analog) via
mtime/version watch.

**AC:**
- [ ] AC1: PAIR's real `.paircoder/` imports cleanly on a copy (read-only source)
- [ ] AC2: External config rewrite detected and surfaced once, not spammed

**Depends on:** OC1.3

### OC1.23 — Test isolation harness | Cx: 5 | P0

**Description:** ERHR5.4: all package tests run against temp `.paircoder/`
fixtures; a CI guard fails if any test touches a real repo `.paircoder/`
(logs, tasks, runs DB).

**AC:**
- [ ] AC1: Guard demonstrably fails on a deliberately leaky test, passes on suite
- [ ] AC2: Full suite leaves the working repo byte-identical

**Depends on:** OC1.13

### OC1.24 — Machine-checked parity gate + docs | Cx: 8 | P0

**Description:** PC23.3 analog: script asserts every in-scope parity-map item
(OC1.1) has a corresponding command/hook/test; regenerate a command reference;
user docs (`packages/web/` docs page): setup, engage, gates, migration,
"running engage from within a session" guide (supersedes ERHR6.3).

**AC:**
- [ ] AC1: Parity script green in CI; deferred items listed as waived, not missing
- [ ] AC2: Docs build passes; guide covers detached mode + status polling

**Depends on:** OC1.16, OC1.18, OC1.21, OC1.22

### OC1.25 — E2E: real engage run on a fixture repo | Cx: 8 | P0

**Description:** Opt-in E2E (PC13.6 analog): tiny fixture repo + 3-task backlog
run end-to-end with a real model behind an env flag; asserts commits, gates,
telemetry, honest status. Excluded from default CI.

**AC:**
- [ ] AC1: E2E green under the flag; skipped (not failed) without it
- [ ] AC2: Produces the full artifact set: commits, run state, telemetry, state.md updates

**Depends on:** OC1.24

### OC1.26 — Contract-drift watch vs PAIR (ERHR landing) | Cx: 3 | P2

**Description:** Since ERHR v2 is still executing in PAIR, add a fixture-refresh
script + checklist to re-sync contracts (runs schema, config keys, backlog
fixtures) if PAIR's remediation changes them before cutover.

**AC:**
- [ ] AC1: Script diffs PAIR contract fixtures vs ours and reports drift
- [ ] AC2: Checklist documented in ADR-001

**Depends on:** OC1.24

## Sequencing rationale

Contracts → parsing → enforcement → interaction surface → orchestration →
economics → lifecycle → migration/verification. All ERHR reliability lessons are
constraints on Phases 3/5 (not a later hardening pass). PC13's "no hollow core"
dictates that OC1.15/OC1.17 land inside the engage phase, not after it.

## Delivery Summary

| Phase | Tasks | Cx |
|---|---|---|
| Phase 1 — Decisions, scaffold, contracts | OC1.1–OC1.4 | 31 |
| Phase 2 — Backlog grammar and engage front end | OC1.5–OC1.6 | 13 |
| Phase 3 — Gates and hooks | OC1.7–OC1.9 | 29 |
| Phase 4 — Roles, commands, context | OC1.10–OC1.12 | 21 |
| Phase 5 — Engage orchestrator | OC1.13–OC1.16 | 37 |
| Phase 6 — Cost, budget, telemetry | OC1.17–OC1.19 | 18 |
| Phase 7 — Review and GitHub lifecycle | OC1.20–OC1.21 | 16 |
| Phase 8 — Migration, parity, hardening | OC1.22–OC1.26 | 29 |
| **Total** | **26 tasks** | **194** |

Deferred (waived): Trello/PM (PC15), licensing (PC22), QC/benchmark
(PC19.2–3), fleet (PC21.4), sweep/intent mining (PC17) — revisit after
cutover.

## Priority Order

1. **P0 spine** (dependency order): OC1.1 → OC1.2 → OC1.3 → OC1.4 → OC1.5 →
   OC1.6; OC1.7 → OC1.8; OC1.10 → OC1.11; OC1.13 → OC1.14 → OC1.15 → OC1.16;
   OC1.20; OC1.23; OC1.24 → OC1.25 (18 tasks, 147 Cx)
2. **P1**: OC1.9, OC1.12, OC1.17 → OC1.18, OC1.19, OC1.21, OC1.22 (7 tasks, 44 Cx)
3. **P2**: OC1.26 (3 Cx)
