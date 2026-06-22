/**
 * Background-removal cutout via Replicate BiRefNet (replaces the VPS's local
 * BiRefNet/`app.cutout_rgba`). Returns a transparent-background PNG buffer.
 *
 * REPLICATE_API_TOKEN comes from the Convex vault (service "replicate"), cached
 * per process. The model version is pinned for reproducibility.
 */
import { getVaultSecrets } from "@/lib/hygglo-auth";

// men1scus/birefnet — same BiRefNet model the VPS used locally.
const REPLICATE_VERSION =
  "f74986db0355b58403ed20963af156525e2891ea3c2d499bfbfb2a28cd87c5d7";
const POLL_MS = 1500;
const MAX_POLLS = 80; // ~2 min after the initial Prefer:wait window

let tokenPromise: Promise<string> | undefined;
async function token(): Promise<string> {
  if (!tokenPromise) {
    tokenPromise = getVaultSecrets("replicate").then((s) => {
      const t = s.REPLICATE_API_TOKEN;
      if (!t) throw new Error("vault service 'replicate' has no REPLICATE_API_TOKEN");
      return t;
    });
  }
  return tokenPromise;
}

interface Prediction {
  status: "starting" | "processing" | "succeeded" | "failed" | "canceled";
  output?: string | string[];
  error?: string | null;
  urls?: { get?: string };
}

function outputUrl(p: Prediction): string {
  const o = p.output;
  const url = Array.isArray(o) ? o[o.length - 1] : o;
  if (!url) throw new Error("birefnet returned no output url");
  return url;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Remove the background from `sourceImageUrl` and return the transparent-bg PNG
 * bytes. `sourceImageUrl` must be publicly fetchable by Replicate.
 */
export async function cutout(sourceImageUrl: string): Promise<Buffer> {
  const tok = await token();
  const auth = { Authorization: `Bearer ${tok}` };

  const res = await fetch("https://api.replicate.com/v1/predictions", {
    method: "POST",
    headers: { ...auth, "Content-Type": "application/json", Prefer: "wait" },
    body: JSON.stringify({ version: REPLICATE_VERSION, input: { image: sourceImageUrl } }),
  });
  if (!res.ok && res.status !== 201) {
    const body = await res.text().catch(() => "<unreadable>");
    throw new Error(`replicate create ${res.status}: ${body.slice(0, 300)}`);
  }
  let pred = (await res.json()) as Prediction;

  // Prefer:wait usually returns terminal; otherwise poll the get URL.
  let polls = 0;
  while (pred.status !== "succeeded" && pred.status !== "failed" && pred.status !== "canceled") {
    if (polls++ >= MAX_POLLS) throw new Error("replicate birefnet timed out");
    await sleep(POLL_MS);
    const getUrl = pred.urls?.get;
    if (!getUrl) throw new Error("replicate prediction has no poll url");
    pred = (await (await fetch(getUrl, { headers: auth })).json()) as Prediction;
  }
  if (pred.status !== "succeeded") {
    throw new Error(`replicate birefnet ${pred.status}: ${pred.error ?? ""}`);
  }

  const imgRes = await fetch(outputUrl(pred));
  if (!imgRes.ok) throw new Error(`fetch cutout ${imgRes.status}`);
  return Buffer.from(await imgRes.arrayBuffer());
}
