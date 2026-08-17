import { NextResponse } from "next/server";
import { checkLabSecret, LAB_ACCESS_COOKIE } from "@/lib/test-lab-gate";

/** Sets the Lab access cookie iff the submitted passphrase matches RENTER_BOT_LAB_SECRET. */
export async function POST(req: Request) {
  let secret = "";
  try {
    const body = (await req.json()) as { secret?: string };
    secret = body.secret ?? "";
  } catch {
    return NextResponse.json({ ok: false, error: "bad_json" }, { status: 400 });
  }

  if (!checkLabSecret(secret)) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  const res = NextResponse.json({ ok: true });
  res.cookies.set(LAB_ACCESS_COOKIE, secret, {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    maxAge: 60 * 60 * 8,
    path: "/",
  });
  return res;
}
