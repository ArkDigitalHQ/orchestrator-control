# Orchestrator

Control Claude agents running in GitHub Codespaces from a central dashboard. Send prompts, approve tool permissions, and monitor activity across multiple machines — all from one place.

## How it works

```
Codespace (supervisor)  ──WebSocket──▶  Control Plane (Railway)  ──▶  Supabase
                                                                           │
                                                                           ▼
                                              Dashboard (Vercel)  ◀── Realtime
```

- **Supervisor** — runs on any machine with Node 22+. Wraps a Claude Code session and forwards tool-permission requests to the dashboard.
- **Control Plane** — Railway WebSocket server that brokers messages between supervisors and the dashboard.
- **Dashboard** — Vercel-hosted Next.js UI. Shows connected machines, lets you send prompts and approve/deny tool use.

## Running a supervisor in a Codespace

Open a terminal in your Codespace and run:

```bash
ANTHROPIC_API_KEY=sk-ant-... bash <(curl -fsSL https://raw.githubusercontent.com/ArkDigitalHQ/orchestrator-dotfiles/main/install.sh)
```

The script will:
1. Clone and build the supervisor from this repo
2. Write credentials to `~/.orchestrator/.env`
3. Start the supervisor in the background with `nohup`

Your machine will appear in the dashboard at **https://orchestrator-dashboard-flostack-ai.vercel.app** within a few seconds.

### Check that it's running

```bash
# See live logs
tail -f ~/.orchestrator/supervisor.log

# Check the process
ps aux | grep supervisor
```

### Update to the latest version

Re-run the same install command. It will pull the latest code, rebuild, and restart the supervisor without touching your `.env`.

### Stop the supervisor

```bash
kill $(cat ~/.orchestrator/supervisor.pid)
```

## Using the dashboard

1. Open **https://orchestrator-dashboard-flostack-ai.vercel.app**
2. Connected machines appear as cards showing their current status
3. Type a prompt in the input box and press **Send** — the agent starts working
4. When Claude wants to use a tool (Bash, file writes, etc.) the card highlights and shows **Approve / Deny** buttons
5. Use **Interrupt** to stop the current run and start fresh

## Repository layout

```
packages/
  shared/          — TypeScript message types shared between supervisor and control plane
  control-plane/   — Railway WebSocket server + Supabase listener
  supervisor/      — Claude Agent SDK session wrapper
supabase/
  migrations/      — Postgres schema (sessions + commands tables)
Dockerfile         — Multi-stage build for Railway deployment
```

## Requirements

- Node.js 22+
- An Anthropic API key (`sk-ant-...`)
