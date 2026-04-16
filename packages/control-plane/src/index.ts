import { WebSocketServer } from "ws";
import type WebSocket from "ws";
import type { IncomingMessage } from "http";
import { env } from "./env.js";
import * as hub from "./hub.js";
import { handleMessage } from "./handler.js";
import { startCommandsListener } from "./commands-listener.js";

const wss = new WebSocketServer({ port: env.PORT });

console.log(`[control-plane] WebSocket server listening on :${env.PORT}`);

wss.on("connection", (ws: WebSocket, req: IncomingMessage) => {
  // ── Auth ────────────────────────────────────────────────────────────────────
  const authHeader = req.headers["authorization"] ?? "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
  if (token !== env.SHARED_SECRET) {
    ws.close(1008, "Unauthorized");
    return;
  }

  // ── Machine ID ──────────────────────────────────────────────────────────────
  const machineId = (req.headers["x-machine-id"] as string | undefined) ?? "unknown";
  console.log(`[control-plane] ${machineId} connected`);

  hub.register(machineId, ws);

  ws.on("message", (data) => {
    handleMessage(machineId, data.toString(), ws).catch((err: unknown) => {
      console.error(`[${machineId}] handleMessage error:`, err);
    });
  });

  ws.on("close", () => {
    console.log(`[control-plane] ${machineId} disconnected`);
    hub.unregister(machineId, ws);
  });

  ws.on("error", (err) => {
    console.error(`[control-plane] ${machineId} ws error:`, err);
  });
});

// ── Health check (Railway uses HTTP health checks) ───────────────────────────
import { createServer } from "http";

const http = createServer((req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        ok: true,
        connected: hub.connectedMachines().length,
        machines: hub.connectedMachines(),
      }),
    );
  } else {
    res.writeHead(404);
    res.end();
  }
});

http.listen(env.PORT + 1, () => {
  console.log(`[control-plane] HTTP health on :${env.PORT + 1}/health`);
});

// ── Supabase Realtime listener for dashboard → supervisor commands ────────────
startCommandsListener();
