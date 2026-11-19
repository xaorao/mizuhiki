import { ImageResponse } from "next/og";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { normalizeNameInput } from "@mizuhiki/core";
import { lookupPage } from "@/lib/server-api";

export const alt = "A Mizuhiki page";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

const black = readFile(join(process.cwd(), "public/fonts/MPLUSRounded1c-Black.ttf"));
const bold = readFile(join(process.cwd(), "public/fonts/MPLUSRounded1c-Bold.ttf"));

export default async function Image({ params }: { params: Promise<{ name: string }> }) {
  const { name: raw } = await params;
  const name = normalizeNameInput(decodeURIComponent(raw));
  const page = await lookupPage(name);
  const m = page.state === "ok" ? page.record.body : null;
  const title = m?.displayName ?? `@${name}`;
  const a = m?.theme.wallpaper.a ?? "#ffc4d0";
  return new ImageResponse(
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        background: "#fff8ef",
        fontFamily: "Rounded",
        color: "#2b2340",
      }}
    >
      <div
        style={{
          width: 380,
          height: "100%",
          background: a,
          borderRight: "8px solid #2b2340",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <div
          style={{
            width: 220,
            height: 220,
            borderRadius: 220,
            background: "#ffe3d6",
            border: "8px solid #2b2340",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontSize: 92,
            color: "#c2300f",
            fontWeight: 900,
          }}
        >
          {title
            .split(/\s+/)
            .slice(0, 2)
            .map((w) => w.charAt(0).toUpperCase())
            .join("")}
        </div>
      </div>
      <div
        style={{
          flex: 1,
          display: "flex",
          flexDirection: "column",
          justifyContent: "center",
          padding: "0 64px",
          gap: 18,
        }}
      >
        <div style={{ fontSize: 28, color: "#c2300f", fontWeight: 700, letterSpacing: 6 }}>
          ひとつのリンクで、ぜんぶ秘密に
        </div>
        <div style={{ fontSize: 72, fontWeight: 900, lineHeight: 1.05 }}>{title}</div>
        <div style={{ fontSize: 34, fontWeight: 700, color: "#5b4a62" }}>{"@" + name}</div>
        <div
          style={{
            display: "flex",
            marginTop: 24,
            alignSelf: "flex-start",
            background: "#e2483d",
            color: "#fff",
            border: "5px solid #2b2340",
            borderRadius: 999,
            padding: "14px 30px",
            fontSize: 30,
            fontWeight: 900,
          }}
        >
          Send me something sealed
        </div>
        <div style={{ marginTop: 18, fontSize: 26, fontWeight: 700, color: "#7a5a6e" }}>mizuhiki 水引</div>
      </div>
    </div>,
    {
      ...size,
      fonts: [
        { name: "Rounded", data: await black, style: "normal", weight: 900 },
        { name: "Rounded", data: await bold, style: "normal", weight: 700 },
      ],
    },
  );
}
