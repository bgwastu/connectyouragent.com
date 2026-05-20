function env(key: string, fallback?: string): string {
  const v = process.env[key];
  if (v === undefined) {
    if (fallback !== undefined) return fallback;
    throw new Error(`Missing env var: ${key}`);
  }
  return v;
}

export const PORT = parseInt(env("PORT", "8765"), 10);
export const HOST = env("HOST", "0.0.0.0");
export const WS_URL = env("WS_URL");
export const BASE_URL = env("BASE_URL");
export const SESSION_IDLE_TIMEOUT = parseInt(env("SESSION_IDLE_TIMEOUT", "300"), 10); // seconds
export const CLEANUP_INTERVAL = parseInt(env("CLEANUP_INTERVAL", "60"), 10); // seconds
