# WallE character asset (vendored Lottie)

## Source
- **File:** `robot.json` (also served from `/public/walle-vendor/robot.json`)
- **Origin:** `https://raw.githubusercontent.com/LottieFiles/dotlottie-web/main/fixtures/lottie/lolo.json`
- **Author:** LottieFiles — internal animation name `13_Like a boss Lolo`, generator metadata `LottieFiles AE 3.0.2`.
- **License:** MIT (LottieFiles/dotlottie-web repository, Copyright (c) 2023 LottieFiles.com — see https://github.com/LottieFiles/dotlottie-web/blob/main/LICENSE). Commercial reuse permitted.
- **Swap history:** Previously vendored `guy-codette/Lottie-Robot-Animation` error-404 robot. Swapped 2026-05-23 because the visible "404" digits read as broken to Daniel.

## Format
- Raw Lottie JSON (Bodymovin v4.8.0) — NOT a `.lottie` dotLottie zip. The dotLottie-react player accepts both `.json` and `.lottie` URLs via the `src` prop.
- 51.9 KB on disk, 512×512 logical canvas, 60 fps, 146-frame loop (~2.4 s), friendly round mascot with body / eyes / mouth / two hands + sparkle stars.
- Verified via `head -c 200 robot.json` → starts with `{"v":"4.8.0","meta":{"g":"LottieFiles AE 3.0.2"...,"nm":"13_Like a boss Lolo"`.

## Player
`@lottiefiles/dotlottie-react` (MIT, WASM ThorVG renderer). Picked over Rive because:
- Rive Community asset downloads require account auth (rejected in the 2026-05-22 asset audit).
- LottieFiles JSON files are small and the dotlottie-react ref API exposes `setSpeed`, `setSegment`, `play`, `pause` for our mood + speaking choreography.

## Idle composition (handled in `WallEBot.tsx`)
- Base Lottie loop runs at speed 1.0 (idle mood).
- `walle.idle.ts` flags drive *container* framer-motion transforms:
  - `blink` (140 ms) → eyelid shutter overlay scales open/closed over the eye region.
  - `glanceLeft / glanceRight` (700 ms) → container `translateX(±6px)`.
  - `headTilt` (1.4 s) → container `rotate(4deg)`.
  - `yawn` (1.2 s) → container `scaleY(0.94)` + Lottie playback slows ×0.6.
  - `antennaTwitch` (220 ms) → container `rotate(-2deg)`.
  - Cursor parallax — pupils-equivalent translate of up to ±3 px from pointer position.
- Mood → `dotLottie.setSpeed`: idle 1.0, listening 1.15, thinking 0.65, alert 1.6, celebrating 1.4.
- `speaking` adds +0.2 to whatever the mood speed resolved to + halo pulse on the outer wrapper.

## Why we dropped the hand-rolled SVG (2026-05-22 polish pass)
The previous custom inline SVG (`walle-bot.css`) read as "a robot a junior LLM might draw" — flat, no real anim depth, identifiable as AI-generated. A real LottieFiles asset is a skeletal animation with shading, secondary motion, and personality, while still being a single ~52 KB asset with zero JS runtime beyond the player wasm chunk.

## Legacy files (kept for now)
- `walle-bot.css` — no longer imported by `WallEBot.tsx`. Safe to delete in a follow-up.
- `robot.lottie` — earlier 404-robot asset; kept on disk for one cycle in case rollback is needed. Safe to delete after 2026-06-01.
