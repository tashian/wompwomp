import { NextResponse } from "next/server";
import { buildOneChatPayload } from "@/lib/payload";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  if (!/^[a-zA-Z0-9-]+$/.test(id)) {
    return new NextResponse("bad id", { status: 400 });
  }
  const payload = await buildOneChatPayload(id);
  if (!payload) return new NextResponse("not found", { status: 404 });
  return NextResponse.json(payload);
}
