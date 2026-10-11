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
import { ItemRevenuePanel } from "../../src/components/dashboard/ItemRevenuePanel";
import { ItemCycleTracker } from "../../src/components/dashboard/ItemCycleTracker";
import { InvestmentScorecard } from "../../src/components/dashboard/InvestmentScorecard";
import { AIInvestmentInsights } from "../../src/components/dashboard/AIInvestmentInsights";
import { HealthScanner } from "../../src/components/dashboard/HealthScanner";
import { EquipmentValuePanel } from "../../src/components/dashboard/EquipmentValuePanel";
import { DEFAULT_PANEL_ORDER, DEFAULT_HIDDEN_PANELS, STAT_WIDGETS, panelLayoutClass } from "../../src/lib/dashboard/widget-registry";
declare global { interface Window { __layout: unknown } }
window.__layout = { DEFAULT_PANEL_ORDER, DEFAULT_HIDDEN_PANELS, stats: STAT_WIDGETS.map(w=>w.id), compact: ["item-revenue","item-cycle","scorecard","ai-insights","health-scanner","equipment-value"].map(id=>({id,className:panelLayoutClass(id)})) };
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
  <AutoPackingGrid className="grid-cols-1 lg:grid-cols-2 gap-3 mt-3">
    {[{id:"item-revenue",Component:ItemRevenuePanel},{id:"equipment-value",Component:EquipmentValuePanel},{id:"item-cycle",Component:ItemCycleTracker},{id:"scorecard",Component:InvestmentScorecard},{id:"ai-insights",Component:AIInvestmentInsights},{id:"health-scanner",Component:HealthScanner}].map(({id,Component})=><div key={id} data-secondary-widget={id} className={panelLayoutClass(id)}><div data-packing-content className="flow-root"><Component/></div></div>)}
  </AutoPackingGrid>
</main>);
