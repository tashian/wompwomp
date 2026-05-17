import { NextResponse } from "next/server";
import { buildChatsPayload } from "@/lib/payload";
import { hasApiKey } from "@/lib/haiku";

export const dynamic = "force-dynamic";

export async function GET() {
  const chats = await buildChatsPayload();
  return NextResponse.json({ chats, hasApiKey: hasApiKey() });
}
