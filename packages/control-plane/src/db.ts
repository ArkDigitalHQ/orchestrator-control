import { createClient } from "@supabase/supabase-js";
import { env } from "./env.js";

export const db = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
  realtime: { params: { eventsPerSecond: 100 } },
});

export async function upsertSession(
  machineId: string,
  patch: Record<string, unknown>,
): Promise<void> {
  const { error } = await db
    .from("sessions")
    .upsert({ machine_id: machineId, ...patch }, { onConflict: "machine_id" });
  if (error) throw new Error(`upsertSession: ${error.message}`);
}

export async function insertCommand(
  row: {
    machine_id: string;
    session_id: string | null;
    command_type: string;
    payload: unknown;
  },
): Promise<string> {
  const { data, error } = await db
    .from("commands")
    .insert({ ...row, status: "pending" })
    .select("id")
    .single();
  if (error) throw new Error(`insertCommand: ${error.message}`);
  return (data as { id: string }).id;
}

export async function updateCommandStatus(
  id: string,
  status: string,
  patch: Record<string, unknown> = {},
): Promise<void> {
  const { error } = await db
    .from("commands")
    .update({ status, ...patch })
    .eq("id", id);
  if (error) throw new Error(`updateCommandStatus: ${error.message}`);
}
