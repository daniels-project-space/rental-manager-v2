import { HeaderBar } from "@/components/dashboard/HeaderBar";
import { PANEL_WIDGETS } from "@/lib/dashboard/widget-registry";

export default function DashboardPage() {
  return (
    <div style={{ background: "#070910", minHeight: "100dvh" }}>
      <HeaderBar />
      <main
        className="mx-auto px-4 md:px-6 py-5"
        style={{ maxWidth: "1440px" }}
      >
        {PANEL_WIDGETS.map(({ id, component: Component }) => (
          <section key={id} className="mb-4" data-widget-id={id}>
            <Component />
          </section>
        ))}
      </main>
    </div>
  );
}
