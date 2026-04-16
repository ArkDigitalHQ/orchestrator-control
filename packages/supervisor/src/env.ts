function required(key: string): string {
  const value = process.env[key];
  if (!value) throw new Error(`Missing required env var: ${key}`);
  return value;
}

export const env = {
  CONTROL_PLANE_URL: required("CONTROL_PLANE_URL"),   // e.g. wss://my-control-plane.railway.app
  SHARED_SECRET: required("SHARED_SECRET"),
  MACHINE_ID: process.env["CODESPACE_NAME"] ?? process.env["MACHINE_ID"] ?? "local",
  MAX_BUDGET_USD: Number(process.env["MAX_BUDGET_USD"] ?? 5),
  MAX_TURNS: Number(process.env["MAX_TURNS"] ?? 40),
  PERMISSION_TIMEOUT_MS: Number(process.env["PERMISSION_TIMEOUT_MS"] ?? 10 * 60 * 1000),
  ANTHROPIC_API_KEY: required("ANTHROPIC_API_KEY"),
} as const;
