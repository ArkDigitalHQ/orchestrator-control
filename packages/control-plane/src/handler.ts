import type WebSocket from "ws";
import type {
  SupervisorMessage,
  PermissionDecisionPayload,
} from "@orchestrator/shared";
import { db, upsertSession, updateCommandStatus } from "./db.js";
import * as hub from "./hub.js";

export async function handleMessage(
  machineId: string,
  raw: string,
  ws: WebSocket,
): Promise<void> {
  let msg: SupervisorMessage;
  try {
    msg = JSON.parse(raw) as SupervisorMessage;
  } catch {
    console.warn(`[${machineId}] unparseable message`);
    return;
  }

  switch (msg.type) {
    case "connect": {
      await upsertSession(machineId, {
        sdk_session_id: msg.sdk_session_id,
        project_path: msg.project_path,
        status: "idle",
        awaiting: null,
        last_event_at: new Date().toISOString(),
      });
      break;
    }

    case "heartbeat": {
      await upsertSession(machineId, {
        last_event_at: msg.timestamp,
      });
      // Deliver any pending commands now that we know the connection is alive.
      await drainPendingCommands(machineId);
      break;
    }

    case "session_start": {
      await upsertSession(machineId, {
        sdk_session_id: msg.sdk_session_id,
        project_path: msg.project_path,
        status: "running",
        awaiting: null,
        last_event_at: new Date().toISOString(),
      });
      break;
    }

    case "session_end": {
      await upsertSession(machineId, {
        status: "stopped",
        awaiting: null,
        last_event_at: new Date().toISOString(),
      });
      break;
    }

    case "status_update": {
      await upsertSession(machineId, {
        status: msg.status,
        awaiting: msg.awaiting,
        awaiting_detail: msg.awaiting_detail,
        last_message: msg.last_message,
        last_event_at: new Date().toISOString(),
      });
      break;
    }

    case "permission_request": {
      // Persist as a pending command so the dashboard can answer it.
      const { data: sessionRow } = await db
        .from("sessions")
        .select("id")
        .eq("machine_id", machineId)
        .single();

      const sessionId = (sessionRow as { id: string } | null)?.id ?? null;

      const { error } = await db.from("commands").insert({
        machine_id: machineId,
        session_id: sessionId,
        command_type: "permission_decision",
        payload: {
          decision_id: msg.decision_id,
          tool_name: msg.tool_name,
          tool_input: msg.tool_input,
        },
        status: "pending",
      });
      if (error) console.error(`permission_request insert error: ${error.message}`);
      break;
    }

    case "ack": {
      const phase = msg.phase;
      if (phase === "received") {
        await updateCommandStatus(msg.command_id, "acked", {
          acked_at: new Date().toISOString(),
        });
      } else if (phase === "executed") {
        await updateCommandStatus(msg.command_id, "executed", {
          result: { ok: true },
        });
      } else {
        await updateCommandStatus(msg.command_id, "failed", {
          result: { error: msg.error ?? "unknown" },
        });
      }
      break;
    }

    default: {
      console.warn(`[${machineId}] unknown message type: ${(msg as { type: string }).type}`);
    }
  }
}

async function drainPendingCommands(machineId: string): Promise<void> {
  const { data: rows, error } = await db
    .from("commands")
    .select("*")
    .eq("machine_id", machineId)
    .in("status", ["pending"])
    .neq("command_type", "permission_decision")
    .order("created_at", { ascending: true })
    .limit(10);

  if (error || !rows) return;

  for (const row of rows as Array<{
    id: string;
    command_type: string;
    payload: PermissionDecisionPayload | Record<string, unknown>;
  }>) {
    const sent = hub.send(machineId, {
      type: "command",
      command_id: row.id,
      command_type: row.command_type as never,
      payload: row.payload,
    });
    if (sent) {
      await updateCommandStatus(row.id, "delivered", {
        delivered_at: new Date().toISOString(),
      });
    }
  }
}
