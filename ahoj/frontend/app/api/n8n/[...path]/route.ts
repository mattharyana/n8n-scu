// CORS fallback. Only used when NEXT_PUBLIC_N8N_PROXY=1.
// Forwards /api/n8n/style, /api/n8n/promo and /api/n8n/promo-status to n8n unchanged.

import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const maxDuration = 60; // /style can take about a minute

const BASE = (process.env.NEXT_PUBLIC_N8N_BASE ?? "").trim().replace(/\/+$/, "");
const ALLOWED = new Set(["style", "promo", "promo-status"]);

async function forward(req: NextRequest, path: string[]) {
  const target = path.join("/");
  if (!BASE) return NextResponse.json({ error: "NEXT_PUBLIC_N8N_BASE is not set." }, { status: 500 });
  if (!ALLOWED.has(target)) return NextResponse.json({ error: "Not found." }, { status: 404 });

  try {
    const upstream = await fetch(`${BASE}/${target}${req.nextUrl.search}`, {
      method: req.method,
      headers: req.method === "POST" ? { "Content-Type": "application/json" } : undefined,
      body: req.method === "POST" ? await req.text() : undefined,
      cache: "no-store",
    });
    const text = await upstream.text();
    return new NextResponse(text, {
      status: upstream.status,
      headers: { "Content-Type": upstream.headers.get("content-type") ?? "application/json" },
    });
  } catch {
    return NextResponse.json({ error: "Could not reach the n8n backend." }, { status: 502 });
  }
}

type Ctx = { params: Promise<{ path: string[] }> };

export async function GET(req: NextRequest, ctx: Ctx) {
  return forward(req, (await ctx.params).path);
}

export async function POST(req: NextRequest, ctx: Ctx) {
  return forward(req, (await ctx.params).path);
}
