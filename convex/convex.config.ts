// convex/convex.config.ts
import { defineApp } from "convex/server";
import rateLimiter from "@convex-dev/rate-limiter/convex.config.js";
import betterAuth from "@convex-dev/better-auth/convex.config";

const app = defineApp();
app.use(rateLimiter);
app.use(betterAuth);

export default app;
