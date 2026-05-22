/**
 * WallEBotLazy — code-split entry for the character.
 *
 * The character itself is small (~6 KB inline SVG + CSS), but dynamic import
 * keeps it consistent with the previous orb pattern and isolates the
 * character-vendor CSS so initial paint doesn't drag it in.
 */
"use client";

import dynamic from "next/dynamic";
import type { WallEBotProps } from "./WallEBot";

const WallEBotLazy = dynamic<WallEBotProps>(() => import("./WallEBot"), {
  ssr: false,
  loading: () => (
    <div
      className="bg-card/60 animate-pulse-glow rounded-2xl"
      style={{ width: "100%", height: "100%" }}
      aria-hidden="true"
    />
  ),
});

export default WallEBotLazy;
