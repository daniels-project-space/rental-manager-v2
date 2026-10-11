import { describe, expect, it } from "vitest";
import { mergeOrder, upgradePanelOrder } from "./layout-order";
const defaults = ["stats-grid", "lifetime", "reply-inbox", "live-calendar", "return-hub", "calendar-strip", "ai-chat"];
describe("dashboard layout", () => {
  it("places the live operational panels in the requested default order", () => expect(upgradePanelOrder(undefined, defaults)).toEqual(defaults));
  it("upgrades legacy saved ordering and retains optional widgets", () => expect(upgradePanelOrder(["ai-chat", "reply-inbox", "calendar-strip", "lifetime", "stats-grid", "return-hub"], defaults)).toEqual([...defaults.slice(0,5), "ai-chat", "calendar-strip"]));
  it("preserves subsequent operator reordering", () => { const saved=["return-hub", "live-calendar", "lifetime", "stats-grid", "reply-inbox", "calendar-strip", "ai-chat"]; expect(upgradePanelOrder(saved, defaults)).toEqual(saved); });
  it("drops retired ids and keeps new widgets selectable", () => expect(mergeOrder(["retired", "lifetime"], defaults)).toEqual(defaults));
});
