# WallE character asset

## Source
**Custom inline SVG + CSS keyframes** — authored in-house for rental-manager-v2.

## Why not a vendored Rive / Lottie file?

We surveyed five candidates before committing:

| Candidate | Source | Bundle | License | Fit | Verdict |
|---|---|---|---|---|---|
| JcToon "Cute Robot" (Rive) | rive.app/marketplace/3364-7075 | ~80 KB .riv + 90 KB runtime | Community CC0-ish, ambiguous attribution | 5/5 cute, multi-skin, state machine | Rejected — file download requires Rive account auth |
| telegivcom "Cute Interactive Robot" (Rive) | rive.app/marketplace/5308-11093 | ~60 KB .riv | Community | 5/5 cursor tracking + head rig | Rejected — same auth requirement, mascot leans corporate |
| LottieFiles "Voice Assistant / AI Chatbot" | lottiefiles.com/free-animation/voice-assistant-ai-chatbot-TU0uS5jXMP | 3.5 KB JSON + 30 KB lottie-web | Lottie Simple License (free commercial) | 3/5 abstract not a character | Rejected — too abstract, no distinct character |
| LottieFiles "Eva AI Robot" pack | lottiefiles.com/free-animations/walle | ~12 Lottie files, ~80 KB | Lottie Simple License | 4/5 character-led | Rejected — multi-file pack, larger bundle, IP-adjacent to Pixar |
| icons8 "3D friendly cute robot" | icons8.com/illustrations/illustration/friendly-cute-robot--animated | ~400 KB JSON | Free with link-back attribution required | 4/5 polished 3D | Rejected — required visible attribution is awkward in widget |
| **Custom SVG + CSS** (chosen) | (in-house) | ~6 KB inline + 0 runtime deps | MIT (this repo) | 5/5 control over every state | **Chosen** |

## Picked: custom inline SVG character

A boxy expressive bot inspired by Wall-E's silhouette (binocular goggle-eyes,
chunky treads, antenna) but stylized as an original mascot — no IP risk, no
attribution requirement, total animation control via CSS variables.

### Idle animations (all CSS-driven)
- Breathe: 3.6 s `transform: translateY` on body + scale-Y on torso
- Blink: 4.4 s eyelid scale-Y with randomized phase
- Eye glance: 7 s eye-pupil x/y nudge cycle
- Antenna sway: 2.8 s rotate
- Tread hum: 0.9 s subtle scaleX
- Idle bob: 5 s combined body rotate + translate

### Mood states drive CSS custom properties
- `--walle-body`, `--walle-screen`, `--walle-eye`, `--walle-glow`
- Mood transitions are interpolated by `transition: <color> 600ms`
- Alert mood adds an extra anxious `shake` keyframe + red glow halo
- Celebrating mood adds a `wave` keyframe on the right arm + green halo

### Click input
- `<button>` wrapper around the SVG so keyboard activation works
- `aria-label="WallE character. Click to talk."`

## File layout
- `walle-bot.svg.tsx` — the SVG markup as a React component
- `walle-bot.css` — keyframes + mood mapping
- `LICENSE` — MIT (same as rental-manager-v2)
