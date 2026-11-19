/**
 * The web app's client for services/api. Every failure becomes an ApiFailure
 * whose message says what happened to the person's data first.
 */
import { configureChain } from "@mizuhiki/chain";

export const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://127.0.0.1:4000";

// Browsers reach QoreChain's native-lane REST through the API's allowlisted relay
// (the public endpoint sends no CORS headers). EVM JSON-RPC is called directly.
if (typeof window !== "undefined") configureChain({ rest: `${API_URL}/chain` });

export class ApiFailure extends Error {
  readonly status: number;
  readonly code: string;
  readonly dataState: string;
  constructor(status: number, code: string, message: string, dataState: string) {
    super(message);
    this.name = "ApiFailure";
    this.status = status;
    this.code = code;
    this.dataState = dataState;
  }
}

export interface ApiOpts {
  token?: string | undefined;
  signal?: AbortSignal | undefined;
}

async function request<T>(method: string, path: string, body: unknown, o: ApiOpts, raw = false): Promise<T> {
  const headers: Record<string, string> = {};
  if (o.token) headers.authorization = `Bearer ${o.token}`;
  let payload: BodyInit | undefined;
  if (body instanceof Uint8Array) {
    headers["content-type"] = "application/octet-stream";
    payload = new Blob([body as Uint8Array<ArrayBuffer>]);
  } else if (body !== undefined) {
    headers["content-type"] = "application/json";
    payload = JSON.stringify(body);
  }
  let res: Response;
  try {
    res = await fetch(`${API_URL}${path}`, { method, headers, body: payload ?? null, signal: o.signal ?? null });
  } catch (e) {
    if (o.signal?.aborted) throw e;
    throw new ApiFailure(0, "OFFLINE", "Mizuhiki could not be reached. Check your connection.", "unknown");
  }
  if (!res.ok) {
    const j = (await res.json().catch(() => ({}))) as {
      error?: { code?: string; message?: string; dataState?: string };
    };
    throw new ApiFailure(
      res.status,
      j.error?.code ?? `HTTP_${res.status}`,
      j.error?.message ?? `Mizuhiki answered with an error (${res.status}).`,
      j.error?.dataState ?? "unknown",
    );
  }
  if (raw) return new Uint8Array(await res.arrayBuffer()) as T;
  return (await res.json()) as T;
}

export const api = {
  get: <T>(path: string, o: ApiOpts = {}) => request<T>("GET", path, undefined, o),
  post: <T>(path: string, body: unknown, o: ApiOpts = {}) => request<T>("POST", path, body, o),
  put: <T>(path: string, body: unknown, o: ApiOpts = {}) => request<T>("PUT", path, body, o),
  patch: <T>(path: string, body: unknown, o: ApiOpts = {}) => request<T>("PATCH", path, body, o),
  del: <T>(path: string, o: ApiOpts = {}) => request<T>("DELETE", path, undefined, o),
  bytes: (path: string, o: ApiOpts = {}) => request<Uint8Array>("GET", path, undefined, o, true),
};

export const mediaUrl = (hash: string): string => `${API_URL}/media/${hash}`;
