import { describe, it, expect } from "vitest";
import { bindRenterToolArgs, withRenterToolScope } from "./renter-tool-scope";
describe("trusted tool request scope", () => {
  it("does not let the model switch accounts or query another conversation", () => {
    const result = withRenterToolScope({ threadId: "thread-one", accountSlug: "leo" }, () => bindRenterToolArgs("renter_bot_tools:check_availability", { thread_id: "someone-else", account_slug: "diogo", item_name: "Sony FX3" }));
    expect(result).toMatchObject({ thread_id: "thread-one", account_slug: "leo", item_name: "Sony FX3" });
  });
  it("fills omitted pricing account and stock exclusion thread", () => {
    const scope = { threadId: "one", accountSlug: "leo" };
    expect(bindRenterToolArgs("renter_bot_tools:lookup_pricing", {}, scope)).toEqual({ account_slug: "leo" });
    expect(bindRenterToolArgs("renter_bot_tools:check_availability", {}, scope)).toEqual({ thread_id: "one" });
    expect(bindRenterToolArgs("settings:get", {}, scope)).toEqual({});
  });
  it("keeps concurrent threads isolated across async tool calls", async () => {
    const run = (threadId: string, accountSlug: string) => withRenterToolScope({ threadId, accountSlug }, async () => { await new Promise((resolve) => setTimeout(resolve, 1)); return bindRenterToolArgs("renter_bot_tools:lookup_pricing", { thread_id: "untrusted" }); });
    expect(await Promise.all([run("one", "leo"), run("two", "diogo")])).toEqual([{ account_slug: "leo", thread_id: "one" }, { account_slug: "diogo", thread_id: "two" }]);
  });
});
