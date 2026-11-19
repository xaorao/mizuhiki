/** The public origin of this deployment, the same on the server and in the browser (no hydration drift). */
export const SITE_URL = (process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000").replace(/\/+$/, "");
export const SITE_HOST = new URL(SITE_URL).host;
export const pageUrl = (name: string): string => `${SITE_URL}/@${name}`;
