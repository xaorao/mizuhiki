/**
 * Runs in the browser before the app becomes interactive (Next.js instrumentation-client convention).
 *
 * zod's fast path compiles validators with `new Function`, after probing whether that is allowed. Our
 * Content-Security-Policy refuses JavaScript eval (proxy.ts), so the probe would log a violation on every page
 * that validates anything. jitless makes zod validate by interpretation and never try.
 */
import { config } from "zod";

config({ jitless: true });
