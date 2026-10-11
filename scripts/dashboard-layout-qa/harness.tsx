import { StatPackingGrid } from "../../src/components/dashboard/StatPackingGrid";
import { createRoot } from "react-dom/client";
import { LifetimeRevenue } from "../../src/components/dashboard/LifetimeRevenue";
import { ChannelResponseRateCard } from "../../src/components/dashboard/ChannelResponseRateCard";
import { ConversationFunnel } from "../../src/components/dashboard/ConversationFunnel";
import { LiveCalendar } from "../../src/components/dashboard/LiveCalendar";
import { ReturnHub } from "../../src/components/dashboard/ReturnHub";
import { ReplyInbox } from "../../src/components/dashboard/ReplyInbox";
import { DEFAULT_PANEL_ORDER, DEFAULT_HIDDEN_PANELS, STAT_WIDGETS } from "../../src/lib/dashboard/widget-registry";
declare global { interface Window { __layout: unknown } }
window.__layout = { DEFAULT_PANEL_ORDER, DEFAULT_HIDDEN_PANELS, stats: STAT_WIDGETS.map(w=>w.id) };
createRoot(document.getElementById("root")!).render(<main>
  <StatPackingGrid><div><ChannelResponseRateCard /></div><div><ConversationFunnel compact /></div>{Array.from({length:8},(_,i)=><div key={i} className={i===2 ? "col-span-2" : ""}>{i%2 ? <ChannelResponseRateCard /> : <ConversationFunnel compact />}</div>)}</StatPackingGrid>
  <LifetimeRevenue /><div className="my-3"><ReplyInbox /></div><LiveCalendar /><div className="mt-3"><ReturnHub /></div>
</main>);
