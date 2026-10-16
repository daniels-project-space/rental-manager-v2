import { createRoot } from "react-dom/client";
import { useState } from "react";
import { ReplyInbox } from "../../src/components/dashboard/ReplyInbox";
import { NotificationBell } from "../../src/components/dashboard/NotificationBell";
import { NotificationDeepLink } from "../../src/components/dashboard/NotificationDeepLink";
import { DeferredMount } from "../../src/lib/dashboard/deferred-mount";
function App() {
  const [eager, setEager] = useState(!new URL(location.href).searchParams.has("deferred"));
  (window as any).__mountInbox = () => setEager(true);
  return <><header data-manager-header style={{height:56,display:"flex",justifyContent:"space-between",alignItems:"center",position:"sticky",top:0,zIndex:40,background:"#0d151d",color:"white"}}>Rental Manager<NotificationBell /></header><NotificationDeepLink /><DeferredMount eager={eager} rootMargin="-10000px"><ReplyInbox /></DeferredMount></>;
}
createRoot(document.getElementById("root")!).render(<App />);
