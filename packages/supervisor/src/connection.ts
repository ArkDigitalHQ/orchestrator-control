/**
 * Persistent WebSocket to the control plane with exponential backoff.
 * Emits typed messages and exposes a typed `send` method.
 */
import WebSocket from "ws";
import { EventEmitter } from "events";
import { env } from "./env.js";
import type { ControlPlaneMessage, SupervisorMessage } from "@orchestrator/shared";

const MIN_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 60_000;

export class ControlPlaneConnection extends EventEmitter {
  private ws: WebSocket | null = null;
  private backoff = MIN_BACKOFF_MS;
  private destroyed = false;

  connect(): void {
    if (this.destroyed) return;
    const url = env.CONTROL_PLANE_URL;
    console.log(`[supervisor] connecting to ${url}`);

    const ws = new WebSocket(url, {
      headers: {
        Authorization: `Bearer ${env.SHARED_SECRET}`,
        "X-Machine-Id": env.MACHINE_ID,
      },
    });

    ws.on("open", () => {
      console.log(`[supervisor] connected`);
      this.backoff = MIN_BACKOFF_MS;
      this.ws = ws;
      this.emit("open");
    });

    ws.on("message", (data) => {
      try {
        const msg = JSON.parse(data.toString()) as ControlPlaneMessage;
        this.emit("message", msg);
      } catch {
        console.warn(`[supervisor] unparseable message from control plane`);
      }
    });

    ws.on("close", (code, reason) => {
      console.log(`[supervisor] disconnected (${code} ${reason.toString()})`);
      this.ws = null;
      this.emit("close");
      this.scheduleReconnect();
    });

    ws.on("error", (err) => {
      console.error(`[supervisor] ws error:`, err);
    });
  }

  send(msg: SupervisorMessage): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  private scheduleReconnect(): void {
    if (this.destroyed) return;
    console.log(`[supervisor] reconnect in ${this.backoff}ms`);
    setTimeout(() => this.connect(), this.backoff);
    this.backoff = Math.min(this.backoff * 2, MAX_BACKOFF_MS);
  }

  destroy(): void {
    this.destroyed = true;
    this.ws?.close();
  }
}
