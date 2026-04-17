#!/usr/bin/env node
/**
 * Orchestrator Supervisor — @anthropic-ai/claude-agent-sdk V2
 */
import {
  unstable_v2_createSession,
  type SDKSession,
  type CanUseTool,
  type HookCallback,
  type HookInput,
  type PreToolUseHookInput,
  type PostToolUseHookInput,
  type NotificationHookInput,
  type SessionStartHookInput,
  type SessionEndHookInput,
  type StopHookInput,
} from "@anthropic-ai/claude-agent-sdk";

import { env } from "./env.js";
import { ControlPlaneConnection } from "./connection.js";
import type {
  ControlPlaneMessage,
} from "@orchestrator/shared";
import type { HookCallbackMatcher, HookEvent } from "@anthropic-ai/claude-agent-sdk";

// ── Connection ────────────────────────────────────────────────────────────────

const conn = new ControlPlaneConnection();
let session: SDKSession | null = null;

// Pending canUseTool decisions awaiting dashboard operator.
const pendingDecisions = new Map<
  string,
  {
    resolve: (v: { behavior: "allow" | "deny"; message?: string }) => void;
    timer: ReturnType<typeof setTimeout>;
  }
>();

// ── Inbound commands from control plane ───────────────────────────────────────

conn.on("message", async (msg: ControlPlaneMessage) => {
  if (msg.type !== "command") return;
  const { command_id, command_type, payload } = msg;

  conn.send({ type: "ack", command_id, phase: "received" });

  try {
    switch (command_type) {
      case "prompt": {
        if (!session) throw new Error("No active session");
        await session.send((payload as { text: string }).text);
        break;
      }

      case "permission_decision": {
        const p = payload as {
          decision_id: string;
          decision: "allow" | "deny";
          message?: string;
        };
        const pending = pendingDecisions.get(p.decision_id);
        if (pending) {
          clearTimeout(pending.timer);
          // exactOptionalPropertyTypes: only include message when it's a string
          pending.resolve(
            p.message !== undefined
              ? { behavior: p.decision, message: p.message }
              : { behavior: p.decision },
          );
          pendingDecisions.delete(p.decision_id);
        }
        break;
      }

      case "interrupt":
      case "close": {
        // close() is synchronous in the V2 SDK.
        session?.close();
        session = null;
        conn.send({ type: "ack", command_id, phase: "executed" });
        if (command_type === "close") process.exit(0);
        // After interrupt, start a fresh session ready for the next prompt.
        startSession().catch(console.error);
        return;
      }

      default:
        console.warn(`[supervisor] unhandled command: ${command_type}`);
    }

    conn.send({ type: "ack", command_id, phase: "executed" });
  } catch (err) {
    conn.send({ type: "ack", command_id, phase: "failed", error: String(err) });
  }
});

// ── canUseTool ────────────────────────────────────────────────────────────────

const HARD_DENY_PATTERNS: RegExp[] = [
  /rm\s+-rf\s+\//,
  /dd\s+if=/,
  /mkfs/,
  /shutdown/,
  /reboot/,
];

const canUseTool: CanUseTool = async (toolName, toolInput, _options) => {
  // Hard-deny dangerous Bash patterns regardless of operator decision.
  if (toolName === "Bash") {
    const cmd = (toolInput["command"] as string | undefined) ?? "";
    if (HARD_DENY_PATTERNS.some((re) => re.test(cmd))) {
      return { behavior: "deny", message: "Blocked by supervisor auto-deny list." };
    }
  }

  // MVP: auto-allow all non-dangerous tool calls and log them to the dashboard.
  // Full operator-decision flow (ALLOW/DENY buttons) is a Sprint 1 feature.
  // Notify the dashboard so tool use is visible, but don't block on a decision.
  conn.send({
    type: "permission_request",
    machine_id: env.MACHINE_ID,
    decision_id: crypto.randomUUID(),
    tool_name: toolName,
    tool_input: toolInput,
  });

  return { behavior: "allow" };
};

// ── Hooks ─────────────────────────────────────────────────────────────────────

function hook(fn: (input: HookInput) => Promise<void>): HookCallback {
  return async (input, _toolUseID, _options) => {
    await fn(input);
    return {};
  };
}

const hooks = {
  SessionStart: [
    {
      hooks: [
        hook(async (raw) => {
          const input = raw as SessionStartHookInput;
          conn.send({
            type: "session_start",
            machine_id: env.MACHINE_ID,
            sdk_session_id: input.session_id,
            project_path: input.cwd,
          });
        }),
      ],
    },
  ],
  SessionEnd: [
    {
      hooks: [
        hook(async (raw) => {
          const input = raw as SessionEndHookInput;
          conn.send({
            type: "session_end",
            machine_id: env.MACHINE_ID,
            sdk_session_id: input.session_id,
            total_cost_usd: 0, // cost not available in SessionEnd hook; tracked separately
            total_turns: 0,
          });
        }),
      ],
    },
  ],
  PreToolUse: [
    {
      hooks: [
        hook(async (raw) => {
          const input = raw as PreToolUseHookInput;
          conn.send({
            type: "status_update",
            machine_id: env.MACHINE_ID,
            status: "running",
            awaiting: null,
            awaiting_detail: null,
            last_message: `Using tool: ${input.tool_name}`,
          });
        }),
      ],
    },
  ],
  PostToolUse: [
    {
      hooks: [
        hook(async (raw) => {
          const input = raw as PostToolUseHookInput;
          const summary =
            typeof input.tool_response === "string"
              ? input.tool_response.slice(0, 300)
              : JSON.stringify(input.tool_response).slice(0, 300);
          conn.send({
            type: "status_update",
            machine_id: env.MACHINE_ID,
            status: "running",
            awaiting: null,
            awaiting_detail: null,
            last_message: `Tool ${input.tool_name} done: ${summary}`,
          });
        }),
      ],
    },
  ],
  Notification: [
    {
      hooks: [
        hook(async (raw) => {
          const input = raw as NotificationHookInput;
          conn.send({
            type: "status_update",
            machine_id: env.MACHINE_ID,
            status: "awaiting",
            awaiting: "prompt",
            awaiting_detail: null,
            last_message: input.message,
          });
        }),
      ],
    },
  ],
  Stop: [
    {
      hooks: [
        hook(async (raw) => {
          const input = raw as StopHookInput;
          conn.send({
            type: "status_update",
            machine_id: env.MACHINE_ID,
            status: "idle",
            awaiting: null,
            awaiting_detail: null,
            last_message: input.last_assistant_message?.slice(0, 500) ?? "Session complete",
          });
        }),
      ],
    },
  ],
} satisfies Partial<Record<HookEvent, HookCallbackMatcher[]>>;

// ── Session lifecycle ─────────────────────────────────────────────────────────

async function startSession(): Promise<void> {
  try {
    session = unstable_v2_createSession({
      model: "claude-opus-4-6",
      settingSources: ["user", "project"],
      cwd: process.env["GITHUB_WORKSPACE"] ?? process.cwd(),
      permissionMode: "default",
      env: {
        ANTHROPIC_API_KEY: env.ANTHROPIC_API_KEY,
        // Max turns and budget passed as env vars read by Claude Code internals.
        CLAUDE_MAX_TURNS: String(env.MAX_TURNS),
        ANTHROPIC_MAX_BUDGET_USD: String(env.MAX_BUDGET_USD),
      },
      canUseTool,
      hooks,
    });

    conn.send({
      type: "status_update",
      machine_id: env.MACHINE_ID,
      status: "idle",
      awaiting: null,
      awaiting_detail: null,
      last_message: "Session ready — waiting for prompt",
    });

    // Drain the stream so hooks fire.
    for await (const _msg of session.stream()) {
      // Messages processed via hooks; nothing to do here.

    }

    // Stream ended naturally (Claude finished responding and is idle).
    // Reset session so the next send() gets a live consumer, then restart.
    if (session !== null) {
      session = null;
      conn.send({
        type: "status_update",
        machine_id: env.MACHINE_ID,
        status: "idle",
        awaiting: null,
        awaiting_detail: null,
        last_message: "Session ready — waiting for prompt",
      });
      // Brief pause to avoid a tight restart loop if stream ends immediately.
      await new Promise<void>((r) => setTimeout(r, 200));
      startSession().catch(console.error);
    }
  } catch (err) {
    console.error("[supervisor] session error:", err);
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

// ── Boot ──────────────────────────────────────────────────────────────────────

conn.on("open", () => {
  conn.send({
    type: "connect",
    machine_id: env.MACHINE_ID,
    sdk_session_id: null,
    project_path: process.cwd(),
  });

  startSession().catch(console.error);
});

conn.connect();

// ── Heartbeat ─────────────────────────────────────────────────────────────────

setInterval(() => {
  conn.send({
    type: "heartbeat",
    machine_id: env.MACHINE_ID,
    timestamp: new Date().toISOString(),
  });
}, 10_000);

// ── Graceful shutdown ─────────────────────────────────────────────────────────

process.on("SIGTERM", () => {
  console.log("[supervisor] SIGTERM — shutting down");
  conn.send({
    type: "status_update",
    machine_id: env.MACHINE_ID,
    status: "stopped",
    awaiting: null,
    awaiting_detail: null,
    last_message: "Supervisor stopped (SIGTERM)",
  });
  session?.close();
  conn.destroy();
  process.exit(0);
});
