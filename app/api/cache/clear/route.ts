import { NextResponse } from "next/server";
import { clearCache } from "@/lib/cache";
import { clearInFlight } from "@/lib/haiku";
import { invalidateSnapshot } from "@/lib/payload";

export const dynamic = "force-dynamic";

export async function POST() {
  await clearCache();
  clearInFlight();
  invalidateSnapshot();
  return NextResponse.json({ ok: true });
}
