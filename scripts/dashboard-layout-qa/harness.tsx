import { UtilityBar } from "../../src/components/dashboard/UtilityBar";
import { AutoPackingGrid, StatPackingGrid } from "../../src/components/dashboard/StatPackingGrid";
import { useState } from "react";
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
function PackingFixture() {
  const [ids,setIds]=useState([0,1,2,3,4,5]);
  return <section data-packing-tests><button onClick={()=>setIds([0,1,2,3,4,5,6])}>Add packing card</button><button onClick={()=>setIds([0,1,2,3,4])}>Hide packing card</button><button onClick={()=>setIds([0,1,2,3,4,5])}>Reset packing cards</button><AutoPackingGrid className="grid-cols-2 gap-2.5">
    {ids.map(i=><div key={i} data-packing-fixture={i} className="row-span-1"><div data-packing-content className="flow-root" style={{height:[280,90,70,100,80,60,75][i],background:"#1d2833"}}>Packing {i}</div></div>)}
  </AutoPackingGrid></section>;
}
createRoot(document.getElementById("root")!).render(<main>
  <UtilityBar items={[{id:"vacation",label:"Vacation Mode",mobileLabel:"Vacation",summary:"Off",content:<ConversationFunnel compact />},{id:"todos",label:"To-Do",content:<ConversationFunnel compact />},{id:"insurance",label:"Insurance Claims",mobileLabel:"Claims",summary:2,content:<ConversationFunnel compact />}]} /><StatPackingGrid><div><div data-packing-content className="flow-root"><ChannelResponseRateCard /></div></div><div><div data-packing-content className="flow-root"><ConversationFunnel compact /></div></div>{Array.from({length:8},(_,i)=><div key={i} className={i===2 ? "col-span-2" : ""}><div data-packing-content className="flow-root">{i%2 ? <ChannelResponseRateCard /> : <ConversationFunnel compact />}</div></div>)}</StatPackingGrid>
  <PackingFixture />
  <LifetimeRevenue /><div className="my-3"><ReplyInbox /></div><LiveCalendar /><div className="mt-3"><ReturnHub /></div>
</main>);
