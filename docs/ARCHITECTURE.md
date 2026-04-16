# Agent Orchestrator — Architecture Doc

**Companion to PLANNING.md. Read both before writing code.**
**Prepared:** April 16, 2026

---

## Purpose of this document

PLANNING.md says **what** we're building and **when**. This doc says **how** it fits together and **why** each piece is the shape it is. When Cowork has a design question mid-build, the answer is here or needs to be added here.

---

## System at a glance

```
┌─────────────────────────────────────────────────────────────┐
│                     Vercel (Next.js)                         │
│   Dashboard · Supabase Auth · Realtime subscription          │
└────────────┬──────────────────────────────┬─────────────────┘
             │ authenticated writes          │ realtime reads
             ▼                               ▼
┌─────────────────────────────────────────────────────────────┐
│                    Supabase (Postgres)                       │
│   State · event log · commands queue · audit · RLS           │
└────────────┬──────────────────────────────▲─────────────────┘
             │ LISTEN/NOTIFY                 │ append
             ▼                               │
┌─────────────────────────────────────────────────────────────┐
│              Railway — Control Plane (Node)                  │
│   WebSocket hub · authz · rate limiting · cost tracking      │
│   OpenTelemetry export · Sentry · Prometheus metrics         │
└────────────┬──────────────────────────────▲─────────────────┘
             │ mTLS WebSocket (Sprint 1+)    │ events, logs
             │ shared-secret (MVP only)      │
             ▼                               │
┌─────────────────────────────────────────────────────────────┐
│         Codespace 1..N — Agent Supervisor (Node)             │
│   Claude Agent SDK session · canUseTool callback ────────────│
│   PreToolUse/PostToolUse hooks · cost meter · checkpoints    │
│   Outbound-only WebSocket to control plane                   │
└─────────────────────────────────────────────────────────────┘
```

The direction of every arrow matters. Codespaces only make *outbound* connections. The control plane never reaches into a Codespace; Codespaces call home. This keeps the network model simple (no inbound ports, no port forwarding, no firewall rules) and means Codespaces pausing/moving doesn't change anything — the supervisor just reconnects when it comes back.

---

## Core design principles

1. **Codespaces are ephemeral. Supabase is the source of truth.** If every Codespace died and respawned, state should be recoverable. Session transcripts, commands, audit — all in Postgres.
2. **The control plane is a dumb router by default.** Business logic lives in the supervisor (where Claude runs) and the dashboard (where humans decide). The control plane authenticates, routes, enforces rate limits, and writes to Supabase. It should be boring.
3. **Every human action is auditable.** Every command carries an issuer. Every permission decision is logged. Who/what/when for anything that touched a machine.
4. **Fail closed on permissions.** When in doubt, deny. The operator can always approve again. An agent that silently runs the wrong command is worse than one that blocks on an extra approval.
5. **One SDK session per supervisor.** Don't multiplex sessions inside one Node process. Want parallel agents on one Codespace? Run multiple supervisors. Simpler mental model, cleaner isolation.

---

## Component: Agent Supervisor (per Codespace)

**Package:** `orchestrator-control/packages/supervisor`
**Runtime:** Node 20+, single long-running process per Codespace
**Lifecycle:** Started by dotfiles install, managed by `systemctl --user` so it restarts on crash and survives Codespace reconnection.

### Responsibilities

- Maintain one `@anthropic-ai/claude-agent-sdk` session.
- Stream every SDK message to the control plane via WebSocket.
- Translate inbound commands (prompt / approve / deny / interrupt / set-mode / close) into SDK calls.
- Enforce local safety rails (budget, turns, disallowed tools) that do not require a round-trip to the dashboard.
- Report heartbeat every 10s so "machine offline" can fire fast.

### SDK configuration

```typescript
import {
  unstable_v2_createSession,
  unstable_v2_resumeSession,
} from "@anthropic-ai/claude-agent-sdk";

const session = await unstable_v2_createSession({
  model: "claude-opus-4-6",
  settingSources: ["user", "project"],   // keeps CLAUDE.md, skills, MCP, plugins
  cwd: process.env.GITHUB_WORKSPACE,
  permissionMode: "default",             // fall through to canUseTool
  maxTurns: 40,                          // runaway protection
  maxBudgetUsd: 5,                       // cost ceiling per session (MVP default)
  hooks: { PreToolUse, PostToolUse, Notification, Stop, SessionStart, SessionEnd },
  canUseTool: askControlPlane,
});
```

**Why `settingSources: ["user", "project"]`:** preserves everything the user has configured for Claude Code — `CLAUDE.md`, skills, MCP servers, plugins, settings. Without this, the SDK runs in a bare environment and loses all project context. This is the key to "the orchestrator doesn't take anything away from Claude Code, it adds a layer on top."

**Why `permissionMode: "default"`:** forces every tool decision through `canUseTool`, which is our human-in-the-loop. `acceptEdits` can be opted into per-session by the operator from the dashboard. `bypassPermissions` is **never** allowed in production config — the supervisor rejects that mode.

### The `canUseTool` callback

This is the heart of the system. Every time Claude wants to use a tool that isn't pre-approved, this fires:

```typescript
async function askControlPlane(toolName: string, toolInput: unknown) {
  // Check local auto-deny list first — destructive patterns never even ask.
  if (isHardDenied(toolName, toolInput)) {
    return { behavior: "deny", message: "Blocked by supervisor auto-deny list." };
  }

  const decisionId = crypto.randomUUID();
  ws.send({ type: "permission_request", decisionId, toolName, toolInput });

  // Wait for dashboard operator to answer. Timeout = auto-deny.
  try {
    return await ws.awaitDecision(decisionId, { timeoutMs: 10 * 60_000 });
  } catch (e) {
    return { behavior: "deny", message: "No operator decision within 10 minutes." };
  }
}
```

**MVP:** timeout is generous (10 min). **Sprint 3:** operator can extend timeout, "allow always for this tool in this session," or redirect with an explanation.

### Hook responsibilities (MVP set)

| Hook | Purpose |
|---|---|
| `SessionStart` | Record session_id, cwd, git branch to Supabase via control plane. |
| `PreToolUse` | Stream tool request (including redacted input preview) to audit log. |
| `PostToolUse` | Stream tool result summary + size + exit code to audit log. |
| `Notification` | **Primary "needs input" signal.** Set `sessions.awaiting = 'prompt'`, trigger push. |
| `Stop` | Mark session idle. Emit final cost & turn totals. |
| `SessionEnd` | Mark session ended. Flush cost ledger. |

Sprint 2 adds `PreCompact`, `PostToolUseFailure`, `SubagentStart/Stop`, `TaskCompleted`.

### Inbound commands from control plane

```typescript
ws.on("command", async (cmd) => {
  switch (cmd.type) {
    case "prompt":            await session.send(cmd.text); break;
    case "permission_decision": pendingDecisions.resolve(cmd.decisionId, cmd.decision); break;
    case "interrupt":         await session.interrupt(); break;
    case "set_permission_mode": await session.setPermissionMode(cmd.mode); break;
    case "close":             await session.close(); process.exit(0);
  }
});
```

Every command is acked on receipt (`acked`) and again on execution (`executed` or `failed`). The control plane will redeliver anything stuck in `delivered` after a reconnect.

### Local auto-deny list (MVP)

Regex patterns that the supervisor refuses before asking. Non-negotiable, not overridable from the dashboard without a supervisor config change.

- `Bash` with `rm -rf /`, `rm -rf ~`, `rm -rf $HOME`
- `Bash` with `git push --force` (or `-f`) against `main`/`master`/`production`
- `Bash` reading from `/etc/shadow`, `~/.ssh/id_*`, Codespaces secrets paths
- `Write` or `Edit` against `.env*` files that contain unredacted secrets (best-effort heuristic)
- Any tool call whose input size exceeds a sanity cap (10 MB)

This list grows in Sprint 3 guardrails work.

---

## Component: Control Plane

**Repo:** `orchestrator-control`
**Runtime:** Node 20+ on Railway. One service, horizontally scalable in Sprint 4 (sticky sessions on `machine_id`).

### Responsibilities

- Terminate inbound WebSocket connections from supervisors (auth + routing).
- Terminate inbound HTTP/WebSocket from dashboard users (Supabase JWT validated).
- Fan out realtime events to Supabase so dashboards pick them up via Realtime.
- Pull commands from Supabase (LISTEN/NOTIFY) and push them to the right supervisor WebSocket.
- Aggregate cost and emit metrics.

### Auth — MVP

Shared secret header. `Authorization: Bearer <token>` from supervisor. `X-Orchestrator-Key` from dashboard. Stored in Railway env vars. **This is temporary and replaced in Sprint 1.**

### Auth — Sprint 1+

- **Supervisors authenticate with mTLS.** Each Codespace receives a client cert issued by our internal CA (step-ca). Cert CN = `machine_id`. Control plane verifies cert on connect and refuses unknown machines.
- **Dashboard users authenticate with Supabase Auth.** Control plane validates JWT on every request; maps user ID → permitted machines via RLS-backed query.
- **Certs + keys + JWTs are all short-lived.** Rotation automated in Sprint 4.

### Command delivery semantics (Sprint 1+)

```
Dashboard writes `commands` row   →   status = pending
Control plane picks it up         →   status = delivered (and WS send)
Supervisor acks receipt           →   status = acked
Supervisor reports execution      →   status = executed | failed
```

On supervisor reconnect: control plane re-sends all commands in `delivered` state for that `machine_id`. Supervisor deduplicates on `command.id`. Any command stuck in `pending` > 5 min without a connected supervisor is marked `expired`.

### Rate limits

- Per-machine: 60 commands/minute inbound.
- Per-user: 600 commands/minute across all machines.
- Event stream from supervisor: no hard cap, but control plane buffers to disk if Supabase write rate exceeds capacity. Backpressure signal sent to supervisor to slow logging (not Claude itself).

### Why not Supabase Edge Functions for the control plane?

Considered and rejected. Edge Functions are stateless and short-lived. We need persistent WebSocket connections per supervisor — dozens of them, for hours each. Railway is the right home.

---

## Component: Supabase

### Project structure

- Schema `public`: minimum MVP tables only.
- Schema `orchestrator`: production tables (Sprint 1+).
- Schema `audit`: append-only log (Sprint 2+).
- Schema `metrics`: cost & perf ledger (Sprint 2+).

Split into schemas so RLS policies stay scoped and grants are easy to reason about.

### MVP Schema (ship this in migration 0001)

```sql
-- Minimum to power the weekend MVP. Will be migrated into the `orchestrator` schema in Sprint 1.

create table public.sessions (
  id uuid primary key default gen_random_uuid(),
  machine_id text not null,
  sdk_session_id text,
  project_path text,
  status text not null default 'idle',          -- idle | running | awaiting | errored | stopped
  awaiting text,                                 -- null | 'prompt' | 'permission'
  awaiting_detail jsonb,
  last_message text,
  last_event_at timestamptz default now(),
  created_at timestamptz default now()
);

create table public.commands (
  id uuid primary key default gen_random_uuid(),
  machine_id text not null,
  session_id uuid references public.sessions(id),
  command_type text not null,                    -- prompt | permission_decision | interrupt | close
  payload jsonb not null,
  status text not null default 'pending',        -- pending | delivered | acked | executed | failed | expired
  created_at timestamptz default now(),
  delivered_at timestamptz,
  acked_at timestamptz,
  result jsonb
);

create index on public.sessions (machine_id, status);
create index on public.sessions (awaiting) where awaiting is not null;
create index on public.commands (machine_id, status) where status in ('pending','delivered');

-- Realtime for the dashboard
alter publication supabase_realtime add table public.sessions;
alter publication supabase_realtime add table public.commands;
```

**MVP RLS:** disabled. Service role key is used from Railway; dashboard uses anon key + a shared dashboard secret. Not safe beyond a single developer — Sprint 1 replaces this with proper RLS.

### Full schema (Sprint 1+ migration plan)

```sql
-- orchestrator.machines — registry, one row per known Codespace
create table orchestrator.machines (
  id text primary key,
  owner_user_id uuid references auth.users,
  display_name text,
  current_cert_fingerprint text,
  last_seen_at timestamptz,
  status text check (status in ('online','offline','paused','degraded'))
);

-- orchestrator.sessions — supersedes public.sessions
create table orchestrator.sessions (
  id uuid primary key,
  machine_id text references orchestrator.machines,
  sdk_session_id text,
  project_path text,
  git_branch text,
  status text,
  awaiting text,
  awaiting_detail jsonb,
  started_at timestamptz,
  last_activity_at timestamptz,
  ended_at timestamptz,
  total_cost_usd numeric(10,4) default 0,
  total_input_tokens bigint default 0,
  total_output_tokens bigint default 0,
  turn_count int default 0,
  max_budget_usd numeric(10,4),
  max_turns int
);

-- orchestrator.commands — supersedes public.commands, adds issuer
create table orchestrator.commands (
  id uuid primary key,
  session_id uuid references orchestrator.sessions,
  issued_by uuid references auth.users,
  command_type text,
  payload jsonb,
  status text,
  created_at timestamptz default now(),
  delivered_at timestamptz,
  acked_at timestamptz,
  result jsonb
);

-- audit.events — append-only
create table audit.events (
  id bigserial primary key,
  occurred_at timestamptz default now(),
  session_id uuid,
  machine_id text,
  actor text,                                    -- 'agent' | user_id | 'system'
  event_type text,                               -- tool_use_requested | approved | denied | prompt_sent | ...
  payload jsonb,
  trace_id text                                  -- OpenTelemetry correlation
);

-- metrics.cost_ledger
create table metrics.cost_ledger (
  id bigserial primary key,
  session_id uuid,
  machine_id text,
  project_path text,
  recorded_at timestamptz,
  input_tokens int,
  output_tokens int,
  cache_read_tokens int,
  cache_write_tokens int,
  cost_usd numeric(10,6),
  model text
);
```

### RLS patterns (Sprint 1+)

- Users can `select` sessions only for machines in `orchestrator.machines` where they are the owner OR are in a shared-access list.
- Only the control plane service role can `insert` into `audit.events` and `metrics.cost_ledger`.
- `orchestrator.commands` inserts allowed for authenticated users against their own machines; all mutations set `issued_by` via trigger.
- pgTAP tests live in `supabase/tests`; run in CI on every migration.

---

## Component: Dashboard

**Repo:** `orchestrator-dashboard`
**Runtime:** Next.js 15 on Vercel. App Router, React Server Components where they fit, client components for realtime views.

### MVP views

1. **Fleet overview** (`/`) — grid of session cards. Status badge, last message preview, "needs input" indicator. Live via Supabase Realtime subscription on `sessions`. Document title shows count of blocked sessions.
2. **Session detail** (`/s/[id]`) — tailed transcript, prompt input, approve/deny buttons. Commands written to `commands` table; Realtime drives updates.
3. **Settings** (`/settings`) — ntfy topic, shared secret for MVP.

### Sprint 3 views

4. **Approval queue** (`/queue`) — every session awaiting input, sorted by wait time. Keyboard-first.
5. **Project dashboards** (`/p/[path]`) — sessions + cost grouped by project path.
6. **Audit log** (`/audit`) — searchable history.
7. **Cost** (`/cost`) — daily/weekly/monthly spend by project and model.

### Realtime model

Dashboard subscribes once per page to the relevant Supabase channel. Supabase Realtime pushes row changes over a WebSocket. No polling anywhere. The control plane never pushes directly to the dashboard — it goes through Supabase so that multiple dashboard tabs, multiple users, and multiple devices all see the same state.

---

## Component: Dotfiles

**Repo:** `orchestrator-dotfiles` (public)

```
orchestrator-dotfiles/
├── install.sh           # entrypoint, run by Codespaces automatically
├── .claude/
│   └── settings.json    # optional: global Claude Code hook config
└── README.md
```

### `install.sh` responsibilities

1. **Detect Codespaces. Fail fast on anything else** (for MVP). Check for `CODESPACE_NAME`; exit with a clear message if absent. Sprint 4 removes this gate.
2. Read `CONTROL_PLANE_URL`, `AGENT_SECRET` (MVP) or cert bundle path (Sprint 1+), and `ANTHROPIC_API_KEY` from env.
3. Download pinned supervisor tarball from a GitHub Release in `orchestrator-control`. Verify checksum.
4. Install supervisor to `~/.orchestrator/supervisor`.
5. Install systemd-user unit or background-process wrapper.
6. Start it. Log first successful heartbeat to stdout for Codespaces postCreate log.

Dotfiles stays small and public. The supervisor binary it downloads is built from the private `orchestrator-control` repo.

### Codespaces secrets

Two tiers: account-level orchestrator secrets (shared across all Codespaces) and per-repo API key secrets (scoped to one project).

**Account-level** (Settings → Codespaces → Secrets, available to all repos):

- `AGENT_SECRET` (MVP) — shared secret header value
- `CONTROL_PLANE_URL` — `wss://control.orchestrator.internal` or similar
- `ORCHESTRATOR_CERT_BUNDLE` (Sprint 1+) — base64 PEM bundle
- `ORCHESTRATOR_CA_FINGERPRINT` (Sprint 1+) — for pinning

**Per-repo** (same Settings page, scoped to a single repo):

- `ANTHROPIC_API_KEY` — a project-specific key created in the Anthropic Console for that project. Clean cost attribution; leak blast radius limited to one project.

Supervisor reads `ANTHROPIC_API_KEY` from env at startup and tags all cost-ledger rows with the `project_path` so spend rolls up per project without any extra work.

---

## Data flows

### Flow 1: Agent blocks on permission; operator approves

1. Claude calls a tool → SDK invokes `canUseTool` in supervisor.
2. Supervisor auto-deny check passes. Creates `decisionId`, sends `permission_request` over WS.
3. Control plane writes to `sessions.awaiting = 'permission'` and `sessions.awaiting_detail = { toolName, toolInput }`.
4. Supabase Realtime pushes change to dashboard; card flips red. ntfy push fires.
5. Operator clicks Approve on dashboard. Dashboard writes `commands` row of type `permission_decision` with `decisionId` and `{ behavior: 'allow' }`.
6. Control plane (LISTEN/NOTIFY) sees the new command, finds the machine's WS, sends it.
7. Supervisor resolves the pending decision; `canUseTool` returns `{ behavior: 'allow' }`.
8. SDK proceeds. `PostToolUse` hook fires, which audit-logs the execution result and clears `sessions.awaiting`.
9. Command row updated to `executed`.

### Flow 2: Operator sends a new prompt mid-session

1. Operator types in session detail input, hits enter. Dashboard writes `commands` row of type `prompt`.
2. Control plane forwards to supervisor. Supervisor calls `session.send(text)`.
3. SDK streams output; supervisor forwards each message to control plane; control plane writes transcript fragments to `audit.events` and updates `sessions.last_message`.
4. Dashboard sees realtime updates and appends to tailed transcript.

### Flow 3: Codespace pauses mid-session

1. Codespace suspends. WS closes. Control plane marks machine `offline` after heartbeat timeout.
2. Any `commands` in `delivered` status for that machine stay in `delivered` (not expired — machine might come back).
3. Codespace resumes. supervisor restarts (systemd-user). Reconnects with exponential backoff.
4. Control plane sees reconnect, re-sends any `delivered`-status commands in order.
5. Supervisor deduplicates on `command.id`. Executes any it hasn't already.
6. SDK session is resumed via `unstable_v2_resumeSession(sdk_session_id)` if the session was mid-turn.

---

## Security model

### Threat model

**In scope:** compromised network between Codespace and control plane; compromised dashboard user credentials; runaway agent making excessive or destructive tool calls; accidental leak of secrets via transcript.

**Out of scope:** fully compromised Codespace host (if that happens, the blast radius is already the Codespace and its connected services); state actor with physical access; supply-chain attack on the SDK itself.

### Controls

- **Transport:** TLS on all connections. mTLS between supervisor and control plane from Sprint 1.
- **Auth:** No shared secrets past Sprint 1. Supabase JWTs short-lived with refresh. API keys rotated on schedule.
- **Authorization:** RLS on all tables. Dashboard can only see + command machines it owns or has explicit shared access to.
- **Audit:** Every human action and every permission decision logged, append-only, to `audit.events`. Sprint 2 adds immutable trace IDs.
- **Permission defaults:** `permissionMode: "default"` everywhere. `bypassPermissions` disabled by supervisor refusing to start with that mode.
- **Hard deny list:** Destructive patterns refused locally without asking the dashboard.
- **Secret handling:** API keys via Codespaces secrets only. Never in dotfiles. Never in transcripts (redaction hook in Sprint 2).
- **Dependency hygiene:** Renovate bot + weekly `npm audit` in Sprint 4.

---

## Observability (Sprint 2+)

### Metrics (Prometheus)

- `orchestrator_sessions_active` (gauge, labeled by machine + project)
- `orchestrator_commands_total` (counter, labeled by type + status)
- `orchestrator_permission_decision_latency_seconds` (histogram)
- `orchestrator_tool_use_total` (counter, labeled by tool + decision)
- `orchestrator_cost_usd_total` (counter, labeled by project + model)
- `orchestrator_supervisor_heartbeat_age_seconds` (gauge per machine)
- `orchestrator_ws_errors_total` (counter)

### Traces (OpenTelemetry)

Spans:
- `dashboard.command.issue` → `control.command.route` → `supervisor.command.execute` → `sdk.tool.use`
- `supervisor.permission.request` → `control.permission.fanout` → `dashboard.permission.render` → `dashboard.permission.decide` → `supervisor.permission.resolve`

Trace IDs propagated end-to-end via WS message envelope.

### Logs

Structured JSON everywhere. Shipped to Grafana Cloud (or self-hosted Loki in Sprint 4 if volume justifies).

### Alerts

- Daily cost > threshold (configurable per project).
- Session awaiting > 15 min (someone forgot).
- Machine offline > 5 min while session was active.
- Control plane 5xx rate > 1% over 5 min.
- Permission decision p95 latency > 5s over 10 min.

---

## Locked decisions

These were open questions; the operator has resolved them. Do not re-litigate without explicit approval.

1. **MVP is single-user (me, Jared).** Sprint 1 introduces multi-user via Supabase Auth + RLS. MVP auth can be a shared secret; don't waste weekend effort on user management.
2. **API keys are scoped per-project.** Each project gets its own Anthropic API key, stored as a Codespaces secret scoped to that project's repo. This gives clean cost attribution from day one and limits blast radius if a key leaks. Supervisor reads the key from env at startup.
3. **Channels integration stays in Sprint 3.** Do not pull Telegram/Discord/iMessage forward. ntfy.sh is the MVP alert sink; web push is added in Sprint 3 alongside Channels. Keeping the MVP focused matters more than alert diversity.
4. **MVP supports Codespaces only.** Dotfiles installer may assume Codespaces env vars (`CODESPACE_NAME`, `GITHUB_WORKSPACE`, etc.) and fail fast elsewhere. Sprint 4 broadens to local dev + Cowork + remote VMs. The supervisor code itself should stay environment-agnostic so that broadening is a dotfiles change, not a rewrite.

---

## Reference: SDK surfaces we depend on

Pinning knowledge for when something breaks:

- `unstable_v2_createSession({ model, settingSources, cwd, permissionMode, maxTurns, maxBudgetUsd, hooks, canUseTool })`
- `unstable_v2_resumeSession(sdk_session_id)`
- `session.send(text)`, `session.stream()`, `session.interrupt()`, `session.setPermissionMode()`, `session.close()`
- Hook event types: `PreToolUse`, `PostToolUse`, `Notification`, `Stop`, `SessionStart`, `SessionEnd`, `PermissionRequest`, `PostToolUseFailure`, `SubagentStart`, `SubagentStop`, `TaskCompleted`, `PreCompact`
- Message types from `session.stream()`: `SDKSystemMessage`, `SDKAssistantMessage`, `SDKUserMessage`, `SDKResultMessage` (has `usage` + `total_cost_usd`), `SDKPartialAssistantMessage`, `SDKCompactBoundaryMessage`, `SDKPermissionDenial`

V2 is in preview. Pin the exact SDK version in `package.json` and wrap all SDK calls behind a thin internal `AgentSession` interface so a V2→stable migration touches one file.
