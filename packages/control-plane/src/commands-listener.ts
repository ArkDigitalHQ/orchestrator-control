/**
 * Watches the `commands` table via Supabase Realtime.
 * When the dashboard inserts a new command (prompt, interrupt, etc.),
 * this module picks it up and forwards it to the correct supervisor.
 */
import { db, updateCommandStatus } from "./db.js";
import * as hub from "./hub.js";
import type { CommandType } from "@orchestrator/shared";

export function startCommandsListener(): void {
  db.channel("commands-insert")
    .on(
      "postgres_changes",
      { event: "INSERT", schema: "public", table: "commands" },
      async (payload) => {
        const row = payload.new as {
          id: string;
          machine_id: string;
          command_type: CommandType;
          payload: unknown;
          status: string;
        };

        // Only dispatch pending commands (not permission_decision ones — those go via permission_request flow).
        if (row.status !== "pending") return;
        if (row.command_type === "permission_decision") return;

        const sent = hub.send(row.machine_id, {
          type: "command",
          command_id: row.id,
          command_type: row.command_type,
          payload: row.payload,
        });

        if (sent) {
          await updateCommandStatus(row.id, "delivered", {
            delivered_at: new Date().toISOString(),
          });
        }
        // If not sent (machine offline), command stays pending — supervisor drains on reconnect.
      },
    )
    .subscribe();

  // Also watch for permission_decision commands inserted by the dashboard.
  db.channel("permission-decisions")
    .on(
      "postgres_changes",
      {
        event: "INSERT",
        schema: "public",
        table: "commands",
        filter: "command_type=eq.permission_decision",
      },
      async (payload) => {
        const row = payload.new as {
          id: string;
          machine_id: string;
          command_type: CommandType;
          payload: { decision_id: string; decision: "allow" | "deny"; message?: string };
          status: string;
        };

        const sent = hub.send(row.machine_id, {
          type: "command",
          command_id: row.id,
          command_type: row.command_type,
          payload: row.payload,
        });

        if (sent) {
          await updateCommandStatus(row.id, "delivered", {
            delivered_at: new Date().toISOString(),
          });
        }
      },
    )
    .subscribe();
}
