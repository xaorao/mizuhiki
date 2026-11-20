import { ImageResponse } from "next/og";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { SITE_HOST } from "@/lib/site";

export const alt = "Mizuhiki: one link for everything private";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

const black = readFile(join(process.cwd(), "public/fonts/MPLUSRounded1c-Black.ttf"));
const bold = readFile(join(process.cwd(), "public/fonts/MPLUSRounded1c-Bold.ttf"));
const knot = readFile(join(process.cwd(), "app/icon.svg"), "utf8");

/** The social card: the hero's words on washi, the knot mark and the claim pill. */
export default async function Image() {
  const mark = `data:image/svg+xml;base64,${Buffer.from(await knot).toString("base64")}`;
  return new ImageResponse(
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        justifyContent: "space-between",
        padding: "64px 72px",
        background: "linear-gradient(160deg, #ffeef2 0%, #fff6f0 60%, #e4f1fb 100%)",
        color: "#3a1730",
        fontFamily: "Round",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 16, fontSize: 40, fontWeight: 900, color: "#2b2340" }}>
        <img src={mark} width={64} height={64} alt="" />
        mizuhiki
      </div>
      <div style={{ display: "flex", flexDirection: "column" }}>
        <div
          style={{
            fontSize: 92,
            fontWeight: 900,
            lineHeight: 1.02,
            letterSpacing: -3,
            display: "flex",
            flexWrap: "wrap",
          }}
        >
          One link for everything&nbsp;<span style={{ color: "#e2483d" }}>private.</span>
        </div>
        <div style={{ fontSize: 32, fontWeight: 700, marginTop: 24, color: "#5b3550" }}>
          Sealed on the sender&apos;s device with post-quantum keys. Only you can open it.
        </div>
      </div>
      <div style={{ display: "flex" }}>
        <div
          style={{
            display: "flex",
            background: "#e2483d",
            color: "#fff",
            borderRadius: 999,
            padding: "18px 34px",
            fontSize: 30,
            fontWeight: 900,
          }}
        >
          {SITE_HOST}/@yourname
        </div>
      </div>
    </div>,
    {
      ...size,
      fonts: [
        { name: "Round", data: await black, style: "normal", weight: 900 },
        { name: "Round", data: await bold, style: "normal", weight: 700 },
      ],
    },
  );
}
