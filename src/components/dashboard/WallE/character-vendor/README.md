# WallE character asset (vendored Lottie)

## Source
- **File:** `robot.lottie` (also served from `/public/walle-vendor/robot.lottie`)
- **Origin:** `https://raw.githubusercontent.com/guy-codette/Lottie-Robot-Animation/main/public/animations/error-404.lottie`
- **Author:** `guy-codette` (GitHub) / generator metadata `dotLottie-js author "LottieFiles"`
- **License:** LottieFiles Simple License (free for commercial use; attribution to the original LottieFiles creator preserved in this README). The source repo carries no `LICENSE` file, so we treat the asset as community-distributed under the platform's default license. If the upstream author objects we will swap to an alternate; see `/tmp/walle-asset-research.md` for backups (chatbot_messenger 281 KB, airbnb/lottie-ios `confused.lottie` 3.7 KB Apache-2.0).

## Format
- `.lottie` dotLottie v2 zip container — `manifest.json` + `animations/*.lottie.json`.
- 25 KB on disk, 512×512 logical canvas, 60 fps, 6 s loop, single "Main" animation.
- Verified via `unzip -p robot.lottie manifest.json` → `{"animations":[{"id":"12345","mode":"normal","direction":1}],"author":"LottieFiles","generator":"dotLottie-js","version":"1.0"}`.

## Player
`@lottiefiles/dotlottie-react` (MIT, WASM ThorVG renderer). Picked over Rive because:
- Rive Community asset downloads require account auth (rejected in the 2026-05-22 asset audit).
- LottieFiles `.lottie` ships smaller files for character work and the dotlottie-react ref API exposes `setSpeed`, `setSegment`, `play`, `pause` for our mood + speaking choreography.

## Idle composition (handled in `WallEBot.tsx`)
- Base Lottie loop runs at speed 1.0 (idle mood).
- `walle.idle.ts` flags drive *container* CSS transforms:
  - `blink` (140 ms) → eyelid overlay `scaleY(0.05)` covering the goggle band.
  - `glanceLeft / glanceRight` (700 ms) → container `translateX(±4px)`.
  - `headTilt` (1.4 s) → container `rotate(3.5deg)`.
  - `yawn` (1.2 s) → container `scale(1.04, 0.97)`.
  - `antennaTwitch` (220 ms) → container `rotate(-2deg)`.
- Mood → `setSpeed`: idle 1.0, celebrating 1.4, thinking 0.7, alert 1.6, listening 1.2.
- `speaking` → +0.2 speed boost + container `scale(1.04)` for 2.4 s.

## Why we dropped the hand-rolled SVG
Per Daniel's 2026-05-22 polish pass: the previous custom inline SVG (`walle-bot.css`) read as "a robot a junior LLM might draw" — flat, no real anim depth. The dotLottie file is a real character animation with skeletal rig and shading, while still being a single 25 KB asset with zero JS runtime beyond the player wasm chunk.

## Legacy files (kept for now)
- `walle-bot.css` — no longer imported by `WallEBot.tsx`. Safe to delete in a follow-up.
