import { NextResponse } from "next/server";
import { dispatchResume } from "@/lib/resume";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  let body: { id?: string; cwd?: string } = {};
  try {
    body = await req.json();
  } catch {
    return new NextResponse("bad body", { status: 400 });
  }
  const { id, cwd } = body;
  if (!id || !/^[a-zA-Z0-9-]+$/.test(id)) {
    return new NextResponse("bad id", { status: 400 });
  }
  dispatchResume(id, cwd);
  return new NextResponse(null, { status: 204 });
}
