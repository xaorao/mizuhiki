import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import { connection } from "next/server";
import { ToastProvider } from "@mizuhiki/ui";
import { AppLinks } from "@/lib/AppLinks";
import { AccountProvider } from "@/account/AccountProvider";
import { sans, mono } from "./fonts";
import latinSlices from "./fonts-jp-latin.json";
import "./fonts-jp.css";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "Mizuhiki · one link for everything private", template: "%s · Mizuhiki" },
  description:
    "One page for payments, messages, files, forms, rooms and more, sealed on the sender's device to the people you choose.",
  applicationName: "Mizuhiki",
};

export const viewport: Viewport = {
  themeColor: "#fff8ef",
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

export default async function RootLayout({ children }: { children: ReactNode }) {
  // Every page renders per request, so Next.js can put proxy.ts's fresh CSP nonce on its own scripts.
  await connection();
  return (
    <html lang="en" className={`${sans.variable} ${mono.variable}`}>
      <head>
        {/* Headings and buttons use these weights first: their Latin slices load with the page. */}
        {latinSlices
          .filter((f) => f.family === "M PLUS Rounded 1c" && f.weight >= 800)
          .map((f) => (
            <link key={f.href} rel="preload" href={f.href} as="font" type="font/woff2" crossOrigin="anonymous" />
          ))}
      </head>
      <body>
        <ToastProvider>
          <AppLinks>
            <AccountProvider>{children}</AccountProvider>
          </AppLinks>
        </ToastProvider>
      </body>
    </html>
  );
}
