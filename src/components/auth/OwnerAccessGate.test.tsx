import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { getFunctionName } from "convex/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({ pathname: "/", auth: { isLoading: false, isAuthenticated: false }, owner: undefined as undefined | { authenticated: boolean; isOwner: boolean }, queries: [] as string[] }));
vi.mock("next/navigation", () => ({ usePathname: () => state.pathname }));
vi.mock("convex/react", () => ({
  useConvexAuth: () => state.auth,
  useQuery: (ref: any, args: any) => { if (args === "skip") return undefined; const name = getFunctionName(ref); state.queries.push(name); return name === "auth:state" ? state.owner : undefined; },
  useMutation: () => vi.fn(),
}));
vi.mock("@convex-dev/better-auth/react", () => ({ ConvexBetterAuthProvider: ({ children }: { children: React.ReactNode }) => children }));
vi.mock("@/lib/convex", () => ({ convex: {} }));
vi.mock("@/lib/auth-client", () => ({ authClient: { signOut: vi.fn() } }));
import { Providers } from "../../app/providers";
function render(enforce = true) { return renderToStaticMarkup(<Providers enforceOwner={enforce}><div>PRIVATE_OR_ROUTE_CONTENT</div></Providers>); }
beforeEach(() => { state.pathname = "/"; state.auth = { isLoading: false, isAuthenticated: false }; state.owner = undefined; state.queries = []; });
describe("real owner provider boundary", () => {
  it("login never mounts private operational providers, regardless of rollout", () => {
    for (const enforce of [true, false]) {
      state.pathname = "/login"; expect(render(enforce)).toContain("PRIVATE_OR_ROUTE_CONTENT"); expect(state.queries).toEqual([]);
    }
  });
  it("anonymous, loading, expired and non-owner sessions never query dashboard layout", () => {
    for (const scenario of [
      { auth: { isLoading: false, isAuthenticated: false }, owner: undefined },
      { auth: { isLoading: true, isAuthenticated: true }, owner: { authenticated: true, isOwner: true } },
      { auth: { isLoading: false, isAuthenticated: true }, owner: undefined },
      { auth: { isLoading: false, isAuthenticated: true }, owner: { authenticated: false, isOwner: true } },
      { auth: { isLoading: false, isAuthenticated: true }, owner: { authenticated: true, isOwner: false } },
    ]) {
      state.auth = scenario.auth; state.owner = scenario.owner; state.queries = [];
      expect(render()).not.toContain("PRIVATE_OR_ROUTE_CONTENT"); expect(state.queries).not.toContain("dashboardLayout:getLayout");
    }
  });
  it("only a current authenticated owner mounts operational providers and sign-out", () => {
    state.auth = { isLoading: false, isAuthenticated: true }; state.owner = { authenticated: true, isOwner: true };
    const html = render(); expect(html).toContain("PRIVATE_OR_ROUTE_CONTENT"); expect(html).toContain("Sign out"); expect(state.queries).toEqual(["auth:state", "dashboardLayout:getLayout"]);
  });
  it("preserves the existing rollout until owner onboarding is completed", () => {
    expect(render(false)).toContain("PRIVATE_OR_ROUTE_CONTENT"); expect(state.queries).toContain("dashboardLayout:getLayout");
  });
});
