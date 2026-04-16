import type WebSocket from "ws";
import type { ControlPlaneMessage } from "@orchestrator/shared";

// Tracks one WebSocket connection per machine_id.
const connections = new Map<string, WebSocket>();

export function register(machineId: string, ws: WebSocket): void {
  const prev = connections.get(machineId);
  if (prev && prev.readyState === prev.OPEN) {
    prev.close(1000, "superseded by new connection");
  }
  connections.set(machineId, ws);
}

export function unregister(machineId: string, ws: WebSocket): void {
  if (connections.get(machineId) === ws) {
    connections.delete(machineId);
  }
}

export function send(machineId: string, msg: ControlPlaneMessage): boolean {
  const ws = connections.get(machineId);
  if (!ws || ws.readyState !== ws.OPEN) return false;
  ws.send(JSON.stringify(msg));
  return true;
}

export function connectedMachines(): string[] {
  return [...connections.keys()];
}
