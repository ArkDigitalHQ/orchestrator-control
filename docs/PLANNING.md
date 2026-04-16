# Agent Orchestrator — Planning Doc

**Owner:** Jared
**Status:** Greenfield. No code written yet.
**Prepared:** April 16, 2026

---

## Problem

I run multiple GitHub Codespaces in parallel, each with Claude Code working on different client projects or my own SaaS work. I have no visibility into which machine needs my input at any moment, and no way to respond without switching contexts into each terminal. I want a universal orchestrator: a single dashboard that shows every agent's state across every machine, pings me when any agent is blocked, and lets me approve/deny/prompt from the dashboard itself.

## Goal

Ship an MVP this weekend that solves the core problem for me personally. Then harden it over 8 weeks (four two-week sprints) into an enterprise-grade system that a small team could operate confidently — real auth, observability, cost controls, audit trail, runbooks, the works.

## Non-goals

- Replacing Claude Code's UI. The supervisor runs the Agent SDK directly; the dashboard is a control/observability layer, not a general-purpose coding IDE.
- Supporting non-Anthropic models. Single-provider by design.
- Multi-tenant SaaS. This is internal tooling. Security posture is "small team I trust," not "public SaaS with untrusted users."
- Native mobile apps. Web push + ntfy/Channels fallback is sufficient.

## Stack decisions (locked)

| Layer | Choice | Why |
|---|---|---|
| Agent runtime | `@anthropic-ai/claude-agent-sdk` (TypeScript) | First-class `canUseTool`, typed hooks, session API, budget caps. Not the Claude Code CLI — we want programmatic control. |
| Per-machine supervisor | Node/TypeScript | Shared types with control plane + dashboard. |
| Control plane | Railway (Node/TypeScript, WebSocket server) | Needs persistent connections; Edge Functions won't fit. |
| Database + realtime | Supabase | Postgres + Realtime + Auth + RLS in one. |
| Dashboard | Vercel (Next.js 15, App Router) | Matches existing stack. |
| Agent host | GitHub Codespaces | Already where the work happens. |
| Bootstrap | Dotfiles repo | Codespaces native; every new Codespace auto-configures. |

## Stack decisions (deferred to Sprint 1)

- **Internal CA for mTLS** — leaning `smallstep/step-ca`, confirm in Sprint 1.
- **Observability stack** — OpenTelemetry + Grafana Cloud, but Sentry alone is fine through MVP.
- **Push notifications** — web push for primary, ntfy.sh for MVP phone alerts, Channels (Telegram/Discord) as Sprint 3 polish.

## Repos

Three separate repos, created fresh:

1. **`orchestrator-dotfiles`** — public. Installer script + minimal supervisor bootstrap. Codespaces auto-clones and runs `install.sh` on every new Codespace.
2. **`orchestrator-control`** — private. Node/TS control plane that runs on Railway. WebSocket server, command dispatch, Supabase integration.
3. **`orchestrator-dashboard`** — private. Next.js dashboard that runs on Vercel.

The actual supervisor binary lives in `orchestrator-control` under a `packages/supervisor` workspace and is published as a pinned tarball that `orchestrator-dotfiles` downloads and runs. This keeps dotfiles tiny and public-safe while the supervisor logic stays alongside the control plane it talks to.

## Success criteria

**MVP (end of weekend):** I can open one browser tab, see all my running Codespaces, get a phone ping when any Claude blocks on input, and send a prompt or approve/deny from the dashboard. Shared-secret auth is fine. No one else uses it yet.

**Sprint 1 end:** Another developer could use it. mTLS, Supabase Auth, RLS, idempotent command delivery, reconnect-survives-pause.

**Sprint 2 end:** I can answer "what happened on that session and what did it cost?" for any session in history. Alerts fire before I notice problems.

**Sprint 3 end:** I prefer the dashboard over watching terminals. Managing 5+ agents feels comfortable.

**Sprint 4 end:** I could hand this to another engineer and they could operate it. Disaster recovery has been drilled, not just documented.

## Locked decisions (as of April 16, 2026)

1. MVP is single-user. Multi-user in Sprint 1.
2. API keys scoped per-project, stored as per-repo Codespaces secrets.
3. Channels integration stays in Sprint 3. ntfy.sh is the MVP alert sink.
4. MVP supports GitHub Codespaces only. Broadens in Sprint 4.

See ARCHITECTURE.md § Locked decisions for the full reasoning.

---

## MVP — This Weekend

**Scope:** 1–3 Codespaces reporting in, one dashboard page showing live status, phone push on "needs input," prompt/approve/deny commands work end-to-end. Shared-secret header auth — disposable, will be replaced Sprint 1.

### Saturday

**Morning (3–4 hrs) — Foundation**
- Create the three repos.
- Provision Supabase project. Migration for minimum schema: `sessions` and `commands` tables (see ARCHITECTURE.md §MVP Schema). Enable Realtime on both.
- Provision Railway project. Deploy a Node/TS skeleton with WebSocket server + shared-secret auth check.
- Provision Vercel project. Deploy blank Next.js page that reads from Supabase.

**Afternoon (3–4 hrs) — Supervisor**
- Write ~150-line supervisor in `orchestrator-control/packages/supervisor`. Uses `@anthropic-ai/claude-agent-sdk` V2 session API (`createSession`, `send`, `stream`), `settingSources: ["user", "project"]`, `canUseTool` callback, `Notification` + `Stop` + `PreToolUse` hooks.
- Outbound WebSocket to control plane. Basic reconnect with exponential backoff.
- Inbound commands: `prompt`, `approve`, `deny`, `interrupt`.
- Publish tarball. Write `orchestrator-dotfiles/install.sh` that downloads it, pins version, starts it as a background process.

**Evening (2–3 hrs) — Wire it up**
- Control plane forwards WS events → Supabase, and Supabase `commands` inserts → WS.
- Dashboard subscribes to `sessions` via Supabase Realtime. One card per session. Red border when `awaiting != null`. Text input and Approve/Deny buttons write to `commands`.
- End-to-end test on one Codespace.

### Sunday

**Morning (2–3 hrs) — Multi-machine + alerts**
- Enable dotfiles in GitHub account settings. Verify fresh Codespace auto-installs.
- Test with 2–3 Codespaces concurrently.
- Add ntfy.sh push on `Notification` events. Subscribe to topic on phone.
- Document title badge count for unread "needs input" sessions.

**Afternoon (2–3 hrs) — Polish**
- Session detail view: live tail of messages for one session.
- Quick actions: "Allow always for this tool," "Stop session," keyboard shortcuts on approval.
- Dogfood on real client work for 2 hours. Write down every annoyance — that's Sprint 1's punch list.

**Exit:** Working orchestrator I'd use Monday morning.

---

## Sprint 1 (Weeks 1–2) — Reliability & Security Foundation

**Theme:** Stop pretending the weekend build is production.

**Deliverables**
- Replace shared-secret auth with mTLS. Internal CA (step-ca), per-Codespace client certs distributed via Codespaces secrets, rotation schedule.
- Supabase Auth on dashboard. JWT validation on control plane. RLS on every table, tested with pgTAP.
- Idempotent command delivery. Command ID + status machine (`pending → delivered → acked → executed`). Redelivery of unacked commands on reconnect.
- Reliable reconnect: exponential backoff with jitter, state survives Codespace pause/resume.
- `max_budget_usd` and `max_turns` enforced in supervisor and surfaced on dashboard.
- CI on all three repos: lint, typecheck, tests, migration validation.
- Sentry on control plane, supervisor, dashboard.

**Exit:** A second team member can use it on their Codespaces. No shared secrets in code. Kill a Codespace mid-session and reconnect resumes cleanly.

---

## Sprint 2 (Weeks 3–4) — Observability & Cost Control

**Theme:** "What happened, when, and how much did it cost?" is answerable.

**Deliverables**
- `audit.events` append-only log. Every tool call pre/post, every permission decision, every command with issuer.
- `metrics.cost_ledger`. Parse `SDKResultMessage.usage` and `total_cost_usd`. Aggregates per session/project/day.
- Dashboard: running burn rate, cost by project, daily/weekly/monthly breakdowns.
- OpenTelemetry traces: dashboard request → control plane → supervisor → SDK, all correlated.
- Prometheus metrics: active sessions, commands/min, p50/p95 approval round-trip latency, error rates.
- Alert rules: daily cost threshold, agent-stuck > N minutes, supervisor offline > N seconds, control plane 5xx rate.
- Audit log search UI.

**Exit:** Audit trail pullable for any session. Alerts fire on real problems before I notice.

---

## Sprint 3 (Weeks 5–6) — Operator Experience

**Theme:** The dashboard is where I live all day. Make it excellent.

**Deliverables**
- Approval queue view. Blocked sessions ranked by wait time. Keyboard shortcuts: `y` approve, `n` deny, `a` allow-always, `e` explain-and-redirect, `j/k` navigate, `.` open detail.
- Rich session detail: live transcript rendered like Claude Code, tool call inspector with JSON diffs, turn/budget gauges, inline Sentry errors.
- Destructive tool guardrails. Auto-deny list (`rm -rf`, `git push --force`, secrets) via `PreToolUse` hook. Overridable only by explicit per-command approval.
- Per-project dashboards: group by project path, roll up cost and active work.
- Web push notifications. Optional Channels (Telegram/Discord/iMessage) as alert fallback.
- Global + per-project kill switches.
- Session fork/resume: pick up any past session by ID.

**Exit:** I prefer the dashboard to the terminal. 5+ agents feels comfortable.

---

## Sprint 4 (Weeks 7–8) — Production Hardening & Launch

**Theme:** Operate this like a product.

**Deliverables**
- Supervisor semver. Control plane advertises minimum version on handshake; auto-upgrades clients.
- Blue/green deploys on Railway. Supabase branching for migrations. Playwright E2E on dashboard against preview deploys.
- Runbooks: agent stuck, cost spike, control plane down, Codespace paused mid-task, Supabase incident, API key rotation, cert rotation.
- Automated API key + mTLS cert rotation, no-downtime cutover.
- Dependency hygiene: Renovate bot, weekly audit, SBOM on release.
- Load test: 20 concurrent sessions. Verify no event drops, responsive dashboard, Supabase handles write rate.
- Disaster recovery drill — actually run it, not just write it.
- Docs: architecture diagram, onboarding guide, contributor guide.

**Exit:** Another engineer could operate it. New Codespace online in < 5 minutes with zero manual steps beyond enabling the secret. DR drill has been run, not just planned.

---

## Risks & mitigations

| Risk | Mitigation |
|---|---|
| Agent SDK V2 is still preview; APIs may shift. | Pin SDK version. Wrap in a thin internal interface so a migration touches one file. |
| `canUseTool` round-trip latency feels sluggish. | Measure in Sprint 2 observability work. Target p95 < 2s. If higher, investigate WebSocket routing or move control plane region closer to Codespace regions. |
| Cost blowup from a runaway agent before Sprint 2 cost controls ship. | `maxBudgetUsd: 5` hard cap per session enforced in supervisor from day one of MVP. |
| Codespaces pause/resume breaks WebSocket state. | Sprint 1 reconnect work targets this specifically. MVP accepts "restart supervisor on resume" as known limitation. |
| Single-operator bottleneck on me during MVP → Sprint 1 transition. | Plan explicitly calls this out: MVP is solo, Sprint 1 is when it becomes shareable. |
| Supabase Realtime bottleneck at fleet scale. | Unlikely at < 20 concurrent sessions. Load test in Sprint 4 will confirm. If it becomes an issue, fall back to control-plane-driven WebSocket fan-out. |

## Working agreements with Cowork

- **Read ARCHITECTURE.md before writing code.** Every design decision is there.
- **One feature branch per sprint deliverable.** No monolithic PRs.
- **Migrations are versioned in `supabase/migrations`. Never edit an applied migration.**
- **Never commit secrets. Use Codespaces/Vercel/Railway secret stores.**
- **When in doubt about scope, cut features, not quality.** A smaller feature set shipped well beats a big set shipped half-done.
- **Ask before adding dependencies.** Prefer small, well-maintained libraries over frameworks that impose structure.
- **Write tests for anything that handles money, permissions, or persistence.** Dashboard polish can lean on manual QA.

## First session in Cowork

1. Read PLANNING.md and ARCHITECTURE.md.
2. Create the three empty repos.
3. Provision Supabase, Railway, Vercel projects; store credentials in Codespaces secrets.
4. Write Supabase migration 0001 with the MVP schema.
5. Scaffold Next.js dashboard + Railway control-plane skeleton + supervisor package. All three deploy "hello world" successfully before any feature work begins.

That's the whole Saturday morning. Stop there and check in before building features.
