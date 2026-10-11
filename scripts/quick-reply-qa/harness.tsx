import { createRoot } from "react-dom/client";
import { useState } from "react";
import { ReplyInbox } from "../../src/components/dashboard/ReplyInbox";
import { DeferredMount } from "../../src/lib/dashboard/deferred-mount";
function ColdInbox() {
  const [eager, setEager] = useState(false);
  (window as any).__mountInbox = () => setEager(true);
  return <DeferredMount eager={eager} rootMargin="-10000px"><ReplyInbox /></DeferredMount>;
}
createRoot(document.getElementById("root")!).render(
  new URL(window.location.href).searchParams.has("deferred") ? <ColdInbox /> : <ReplyInbox />,
);
