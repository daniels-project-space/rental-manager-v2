/**
 * WallEOrbLazy — code-split entry point for the orb.
 *
 * Three.js + @react-three/fiber + the orb's shader/texture together weigh
 * ~600KB+ gzipped. Loading them eagerly would block the StatsGrid first
 * paint. We dynamic-import here with `ssr:false` so:
 *   1. Initial server-rendered HTML ships zero three.js bytes.
 *   2. The dashboard skeleton renders immediately.
 *   3. Orb chunk hydrates after the dashboard is interactive.
 *
 * Use this from WallE.tsx (Phase 8 wires it into StatsGrid). Skeleton uses
 * existing design tokens: rounded card surface + pulse-glow keyframe from
 * src/app/globals.css. No new CSS required.
 */
"use client";

import dynamic from 'next/dynamic';
import type { WallEOrbProps } from './WallEOrb';

const WallEOrbLazy = dynamic<WallEOrbProps>(
  () => import('./WallEOrb'),
  {
    ssr: false,
    loading: () => (
      <div
        className="bg-card animate-pulse-glow rounded-full"
        style={{ width: 240, height: 240 }}
        aria-hidden="true"
      />
    ),
  },
);

export default WallEOrbLazy;
