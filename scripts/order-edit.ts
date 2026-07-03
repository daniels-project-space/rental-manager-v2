/**
 * order-edit CLI (2026-07-03) — Trigger/Convex-independent probe + operator tool
 * for the Hygglo order-edit dispatcher. Exercises the SAME src/lib/hygglo-write
 * functions the dashboard order editor calls, so the wire shapes can be verified
 * offline before/after a deploy.
 *
 * HARD SAFETY RAIL: writes are refused for any order id not in ALLOWLIST. During
 * development the only order Daniel authorised edits on is 4075255 (leo). Reads
 * (`state`, `preview`) are allowed for any id.
 *
 * Usage (from repo root):
 *   npx tsx scripts/order-edit.ts state   [leo] [4075255]
 *   npx tsx scripts/order-edit.ts preview [leo] [4075255] <newOrderPrice>
 *   npx tsx scripts/order-edit.ts add     [leo] [4075255] <productId>  --yes
 *   npx tsx scripts/order-edit.ts remove  [leo] [4075255] <itemId>     --yes
 *   npx tsx scripts/order-edit.ts price   [leo] [4075255] <newOrderPrice> --yes
 *   npx tsx scripts/order-edit.ts dates   [leo] [4075255] <start> <end> [verb] --yes
 *
 * Omit --yes for a dry run (prints what WOULD be sent, sends nothing).
 */
import {
  getAccountCredentials,
  getHyggloAccessToken,
  hyggloAuthHeaders,
  HYGGLO_API_BASE,
} from "../src/lib/hygglo-auth";
import {
  addOrderProduct,
  removeOrderItem,
  changeOrderPrice,
  changeOrderDates,
} from "../src/lib/hygglo-write";

// Deliberate write gate — the CLI is a deliberate operator action.
process.env.ALLOW_MANUAL_ORDER_ACTIONS =
  process.env.ALLOW_MANUAL_ORDER_ACTIONS ?? "true";

const ALLOWLIST = new Set(["4075255"]);
const TZ = "Europe/London";

async function tokenFor(slug: string) {
  const creds = await getAccountCredentials(slug);
  return getHyggloAccessToken({ ...creds, accountSlug: slug });
}

async function getOrder(slug: string, id: string) {
  const token = await tokenFor(slug);
  const res = await fetch(
    `${HYGGLO_API_BASE}/v4/my/orders/${id}?timezone=${TZ}`,
    { headers: hyggloAuthHeaders(token) },
  );
  if (!res.ok) throw new Error(`order ${id} → ${res.status}`);
  return (await res.json()) as any;
}

function printState(o: any) {
  const bd = o.price?.breakdown ?? {};
  console.log(`\nOrder ${o.id}  · renter: ${o.users?.otherPart?.name?.trim()}`);
  console.log(
    `dates: ${o.rentalPeriod?.startDateUTC?.slice(0, 10)} → ${o.rentalPeriod?.endDateUTC?.slice(0, 10)}`,
  );
  console.log(
    `price: rental ${bd.orderPrice?.amountLabel ?? bd.orderPrice?.amount} · total ${bd.totalPrice?.amountLabel ?? bd.totalPrice?.amount} · earnings ${bd.lenderEarnings?.amountLabel ?? bd.lenderEarnings?.amount}`,
  );
  console.log("items:");
  for (const it of o.items ?? []) {
    if ((it.type ?? "PRODUCT") !== "PRODUCT") continue;
    console.log(
      `  · itemId=${it.itemId} productId=${it.productId} remove=${it.actions?.remove} | ${(it.name ?? "").slice(0, 60)}`,
    );
  }
  const a = o.actions ?? {};
  console.log(
    `actions: addProduct=${a.addProduct} removeItem=${a.removeItem} changePrice=${a.changePrice} changeDates=${a.changeDates} selectDates=${a.selectDates} partialRefund=${a.partialRefund}`,
  );
}

async function preview(slug: string, id: string, newPrice: number) {
  const token = await tokenFor(slug);
  const res = await fetch(
    `${HYGGLO_API_BASE}/v4/my/order-price-change-calculator/${id}?newOrderPrice=${newPrice}`,
    { headers: hyggloAuthHeaders(token) },
  );
  const j = (await res.json()) as any;
  console.log(
    `preview → rental ${j.newPriceLabels?.orderPrice} · total ${j.newPriceLabels?.orderTotal} (was ${j.oldPriceLabels?.orderTotal})`,
  );
}

function guardWrite(id: string, doIt: boolean) {
  if (!ALLOWLIST.has(id)) {
    console.error(`\n✋ REFUSED: order ${id} is not in the write allowlist ${[...ALLOWLIST].join(",")}.`);
    process.exit(2);
  }
  if (!doIt) {
    console.log("\n(dry run — pass --yes to actually send)");
    return false;
  }
  return true;
}

async function main() {
  const argv = process.argv.slice(2);
  const doIt = argv.includes("--yes");
  const [cmd, slug = "leo", id = "4075255", ...rest] = argv.filter((a) => a !== "--yes");

  if (cmd === "state") {
    printState(await getOrder(slug, id));
    return;
  }
  if (cmd === "preview") {
    await preview(slug, id, Number(rest[0]));
    return;
  }
  if (cmd === "add") {
    const productId = Number(rest[0]);
    console.log(`addProduct productId=${productId} on order ${id} (${slug})`);
    if (!guardWrite(id, doIt)) return;
    console.log(JSON.stringify(await addOrderProduct({ accountSlug: slug, hyggloOrderId: id, productId })));
    printState(await getOrder(slug, id));
    return;
  }
  if (cmd === "remove") {
    const itemId = Number(rest[0]);
    console.log(`removeItem itemId=${itemId} on order ${id} (${slug})`);
    if (!guardWrite(id, doIt)) return;
    console.log(JSON.stringify(await removeOrderItem({ accountSlug: slug, hyggloOrderId: id, itemId })));
    printState(await getOrder(slug, id));
    return;
  }
  if (cmd === "price") {
    const price = Number(rest[0]);
    console.log(`changePrice → ${price} on order ${id} (${slug})`);
    await preview(slug, id, price);
    if (!guardWrite(id, doIt)) return;
    console.log(JSON.stringify(await changeOrderPrice({ accountSlug: slug, hyggloOrderId: id, price })));
    printState(await getOrder(slug, id));
    return;
  }
  if (cmd === "dates") {
    const [start, end, verb] = rest;
    console.log(`changeDates ${start} → ${end} (verb=${verb ?? "changeDates"}) on order ${id} (${slug})`);
    if (!guardWrite(id, doIt)) return;
    console.log(
      JSON.stringify(
        await changeOrderDates({
          accountSlug: slug,
          hyggloOrderId: id,
          rentalStartDate: start,
          rentalEndDate: end,
          verb: (verb as "changeDates" | "selectDates") ?? undefined,
        }),
      ),
    );
    printState(await getOrder(slug, id));
    return;
  }
  console.log("commands: state | preview | add | remove | price | dates  (see file header)");
}

main().catch((e) => {
  console.error("FATAL", e instanceof Error ? e.message : e);
  process.exit(1);
});
