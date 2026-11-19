import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import { ToastProvider } from "@mizuhiki/ui";
import { AppLinks } from "@/lib/AppLinks";
import { AccountProvider } from "@/account/AccountProvider";
import { round, sans, jp, mono } from "./fonts";
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

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${round.variable} ${sans.variable} ${jp.variable} ${mono.variable}`}>
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
