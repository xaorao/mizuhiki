/**
 * Content Security Policy with a fresh nonce on every page request (Next.js CSP
 * guide, THREAT_MODEL A1). Scripts run only from this origin with the nonce,
 * and whatever they load ('strict-dynamic'); nothing else, so an injected
 * script tag cannot read the unlocked keys. Connections are limited to this
 * site, the Mizuhiki API and the QoreChain EVM endpoint the browser reads keys
 * from. Inline style attributes are allowed (the design system sets per-element
 * colours and sizes); styles cannot run code.
 */
import { NextResponse, type NextRequest } from "next/server";
import { NETWORK } from "@mizuhiki/chain";

const API = (process.env.NEXT_PUBLIC_API_URL ?? "http://127.0.0.1:4000").replace(/\/+$/, "");
const API_WS = API.replace(/^http/, "ws");

/** Published forms are made to be embedded on owners' own sites (spec 5.9); everything else may not be framed. */
const EMBEDDABLE = /^\/(@[^/]+|p\/[^/]+)\/f\/[a-z0-9-]{1,48}\/?$/;

export function proxy(request: NextRequest) {
  const nonce = Buffer.from(crypto.randomUUID()).toString("base64");
  const dev = process.env.NODE_ENV === "development";
  // Upgrade stray http:// subresources only on a page that came over HTTPS (directly or through a TLS proxy).
  // On plain http, Safari would upgrade even localhost and every stylesheet and font would fail.
  const https =
    request.nextUrl.protocol === "https:" ||
    request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim() === "https";
  const csp = [
    "default-src 'self'",
    // 'wasm-unsafe-eval' lets WebAssembly compile and nothing else: HarfBuzz subsets fonts for the PDFs the app makes
    // (lib/fontSubset.ts). JavaScript eval stays blocked. Dev mode adds 'unsafe-eval' for React's debugging tools only.
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic' 'wasm-unsafe-eval'${dev ? " 'unsafe-eval'" : ""}`,
    "style-src 'self' 'unsafe-inline'",
    `img-src 'self' blob: data: ${API}`,
    "font-src 'self'",
    `connect-src 'self' ${API} ${API_WS} ${NETWORK.evmRpc}${dev ? " ws:" : ""}`,
    "worker-src 'self'",
    "manifest-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    `frame-ancestors ${EMBEDDABLE.test(request.nextUrl.pathname) ? "*" : "'none'"}`,
    ...(https ? ["upgrade-insecure-requests"] : []),
  ].join("; ");

  const headers = new Headers(request.headers);
  headers.set("x-nonce", nonce);
  headers.set("Content-Security-Policy", csp);
  const response = NextResponse.next({ request: { headers } });
  response.headers.set("Content-Security-Policy", csp);
  return response;
}

export const config = {
  matcher: [
    {
      source: "/((?!_next/static|_next/image|favicon.ico|icon.svg|apple-icon.png|fonts/|sw.js|embed.js|vendor/).*)",
      missing: [
        { type: "header", key: "next-router-prefetch" },
        { type: "header", key: "purpose", value: "prefetch" },
      ],
    },
  ],
};
