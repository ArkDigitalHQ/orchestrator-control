#!/usr/bin/env node
/**
 * Orchestrator Supervisor
 *
 * Runs one Claude Agent SDK session per Codespace.
 * Bridges the SDK to the control plane via WebSocket.
 */
import { query, type SDKMessage } from "@anthropic-ai/claude-code";
import { env } from "./env.js";
import { ControlPlaneConnection } from "./connection.js";
import type { ControlPlaneMessage } from "@orchestrator/shared";

// ── Connection ────────────────────────────────────────────────────────────────

const conn = new ControlPlaneConnection();

// Pending permission requests awaiting dashboard decision.
const pendingDecisions = new Map<
  string,
  { resolve: (v: { behavior: "allow" | "deny"; message?: string }) => void; timer: ReturnType<typeof setTimeout> }
>();

// Commands from the control plane.
conn.on("message", (msg: ControlPlaneMessage) => {
  if (msg.type !== "command") return;
  const { command_id, command_type, payload } = msg;

  // Immediately ack receipt.
  conn.send({ type: "ack", command_id, phase: "received" });

  if (command_type === "permission_decision") {
    const p = payload as { decision_id: string; decision: "allow" | "deny"; message?: string };
    const pending = pendingDecisions.get(p.decision_id);
    if (pending) {
      clearTimeout(pending.timer);
      pending.resolve({ behavior: p.decision, message: p.message });
      pendingDecisions.delete(p.decision_id);
    }
    conn.send({ type: "ack", command_id, phase: "executed" });
    return;
  }

  // prompt / interrupt / close handled below via promptQueue.
  // For MVP we just log — full command dispatch comes next.
  console.log(`[supervisor] received command: ${command_type}`);
  conn.send({ type: "ack", command_id, phase: "executed" });
});

conn.on("open", () => {
  conn.send({
    type: "connect",
    machine_id: env.MACHINE_ID,
    sdk_session_id: null,
    project_path: process.cwd(),
  });
});

// ── Heartbeat ─────────────────────────────────────────────────────────────────

setInterval(() => {
  conn.send({
    type: "heartbeat",
    machine_id: env.MACHINE_ID,
    timestamp: new Date().toISOString(),
  });
}, 10_000);

// ── canUseTool ────────────────────────────────────────────────────────────────

const HARD_DENY_PATTERNS: RegExp[] = [
  /rm\s+-rf\s+\//,
  /dd\s+if=/,
  /mkfs/,
  /shutdown/,
];

function isHardDenied(toolName: string, toolInput: unknown): boolean {
  if (toolName === "Bash") {
    const cmd = (toolInput as Record<string, string>)["command"] ?? "";
    return HARD_DENY_PATTERNS.some((re) => re.test(cmd));
  }
  return false;
}

async function askControlPlane(
  toolName: string,
  toolInput: unknown,
): Promise<{ behavior: "allow" | "deny"; message?: string }> {
  if (isHardDenied(toolName, toolInput)) {
    return { behavior: "deny", message: "Blocked by supervisor auto-deny list." };
  }

  const decisionId = crypto.randomUUID();

  conn.send({
    type: "permission_request",
    machine_id: env.MACHINE_ID,
    decision_id: decisionId,
    tool_name: toolName,
    tool_input: toolInput,
  });

  conn.send({
    type: "status_update",
    machine_id: env.MACHINE_ID,
    status: "awaiting",
    awaiting: "permission",
    awaiting_detail: { decision_id: decisionId, tool_name: toolName },
    last_message: `Waiting for permission: ${toolName}`,
  });

  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pendingDecisions.delete(decisionId);
      resolve({ behavior: "deny", message: "No operator decision within timeout." });
    }, env.PERMISSION_TIMEOUT_MS);

    pendingDecisions.set(decisionId, { resolve, timer });
  });
}

// ── Run a task ────────────────────────────────────────────────────────────────

async function runTask(prompt: string): Promise<void> {
  conn.send({
    type: "status_update",
    machine_id: env.MACHINE_ID,
    status: "running",
    awaiting: null,
    awaiting_detail: null,
    last_message: prompt.slice(0, 200),
  });

  try {
    for await (const msg of query({
      prompt,
      options: {
        maxTurns: env.MAX_TURNS,
        // permissionMode handled via canUseTool approach
      },
    }) as AsyncIterable<SDKMessage>) {
      // Stream significant events to control plane.
      if (msg.type === "assistant") {
        const text = msg.message.content
          .filter((b) => b.type === "text")
          .map((b) => (b as { type: "text"; text: string }).text)
          .join("");
        if (text) {
          conn.send({
            type: "status_update",
            machine_id: env.MACHINE_ID,
            status: "running",
            awaiting: null,
            awaiting_detail: null,
            last_message: text.slice(0, 500),
          });
        }
      }

      if (msg.type === "result") {
        conn.send({
          type: "status_update",
          machine_id: env.MACHINE_ID,
          status: "idle",
          awaiting: null,
          awaiting_detail: null,
          last_message: `Done. Cost: $${msg.total_cost_usd?.toFixed(4) ?? "?"}`,
        });
      }
    }
  } catch (err) {
    console.error(`[supervisor] session error:`, err);
    conn.send({
      type: "status_update",
      machine_id: env.MACHINE_ID,
      status: "errored",
      awaiting: null,
      awaiting_detail: null,
      last_message: String(err),
    });
  }
}

// ── Entry point ───────────────────────────────────────────────────────────────

conn.connect();

// For MVP: if a prompt is passed as argv[2], run it immediately.
const initialPrompt = process.argv[2];
if (initialPrompt) {
  conn.on("open", () => {
    runTask(initialPrompt).catch(console.error);
  });
}

// Graceful shutdown.
process.on("SIGTERM", () => {
  console.log(`[supervisor] SIGTERM — shutting down`);
  conn.send({
    type: "status_update",
    machine_id: env.MACHINE_ID,
    status: "stopped",
    awaiting: null,
    awaiting_detail: null,
    last_message: "Supervisor stopped",
  });
  conn.destroy();
  process.exit(0);
});
