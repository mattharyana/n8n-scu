// Every network call to n8n lives in this file.
// NEXT_PUBLIC_N8N_BASE empty  ->  mock mode (no backend needed).

import type { PromoRequest, PromoResponse, StatusResponse, StyleProfile, StyleResponse } from "./types";

const N8N_BASE = (process.env.NEXT_PUBLIC_N8N_BASE ?? "").trim().replace(/\/+$/, "");

/** True when there is no backend configured. */
export const IS_MOCK = N8N_BASE === "";

/** Set NEXT_PUBLIC_N8N_PROXY=1 if CORS blocks the browser from calling n8n directly. */
const USE_PROXY = process.env.NEXT_PUBLIC_N8N_PROXY === "1";

// /style can take 70 s and /promo about 45 s, so neither is cut off before this.
const SLOW_TIMEOUT_MS = 120_000;
const STATUS_TIMEOUT_MS = 20_000;

// ---------- real calls ----------

async function request<T>(path: string, init: RequestInit | undefined, timeoutMs: number): Promise<T> {
  const url = USE_PROXY ? `/api/n8n/${path}` : `${N8N_BASE}/${path}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let res: Response;
  let text = "";
  try {
    res = await fetch(url, { ...init, signal: controller.signal });
    text = await res.text();
  } catch {
    throw new Error(
      controller.signal.aborted
        ? "The server took too long to answer. Please try again."
        : "Could not reach the server. Check your connection and try again.",
    );
  } finally {
    clearTimeout(timer);
  }

  // The gateway answers with an HTML page on a timeout, so never assume JSON.
  let data: unknown = null;
  try {
    data = JSON.parse(text);
  } catch {
    data = null;
  }
  // n8n sometimes wraps a single item in an array.
  if (Array.isArray(data) && data.length === 1) data = data[0];

  if (!res.ok) {
    const message =
      data && typeof data === "object" && typeof (data as { error?: unknown }).error === "string"
        ? (data as { error: string }).error
        : res.status === 504 || res.status === 502 || res.status === 524
          ? "The server took too long to answer. Please try again."
          : `The server returned an error (${res.status}). Please try again.`;
    throw new Error(message);
  }
  if (data === null || typeof data !== "object") {
    throw new Error("The server sent a response we could not read. Please try again.");
  }
  return data as T;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// ---------- mock data ----------

const SAMPLE_STYLE: StyleProfile = {
  summary: "Fast travel montage with bold centred captions",
  avgShotLength: 1.4,
  cutStyle: "hard cuts",
  captionStyle: "large, uppercase, centred",
  colorMood: "warm, high contrast",
  musicMood: "upbeat",
  structure: "hook, montage, end card",
};

const SAMPLE_SHOT_CAPTIONS = ["Big Sur", "Highway 1", "Golden Gate", "Yosemite", "Joshua Tree", "Venice Beach"];

// Any public sample MP4.
const SAMPLE_VIDEO = "https://res.cloudinary.com/demo/video/upload/du_12,w_720,q_auto/sea_turtle.mp4";

const mockPolls = new Map<string, number>();

// ---------- public API ----------

/** POST /style */
export async function analyseStyle(referenceUrl: string): Promise<StyleResponse> {
  if (IS_MOCK) {
    await sleep(3000);
    return { style: { ...SAMPLE_STYLE }, analysed: true };
  }
  return request<StyleResponse>(
    "style",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ referenceUrl }),
    },
    SLOW_TIMEOUT_MS,
  );
}

/** POST /promo. Called once per job; never retried automatically. */
export async function createPromo(req: PromoRequest): Promise<PromoResponse> {
  if (IS_MOCK) {
    await sleep(3000);
    const count = Math.max(1, Math.min(6, req.clips.length * 2));
    return {
      jobId: "d2b46ed6-998a-4d6b-9d91-b8cf0193a655-" + Date.now(),
      plan: {
        story: "A week on the California coast, from the bridge to the beach.",
        title: req.brand.tagline || "California, the long way round",
        endLine: req.brand.cta || "Book your trip",
        caption: "One week, six stops, zero regrets.",
        hashtags: ["#california", "#roadtrip"],
        shots: Array.from({ length: count }, (_, i) => ({
          clipId: req.clips[i % req.clips.length]?.id ?? "c1",
          start: 3.0,
          length: 2.0,
          caption: SAMPLE_SHOT_CAPTIONS[i % SAMPLE_SHOT_CAPTIONS.length],
        })),
      },
      director: "fallback",
      music: true,
    };
  }
  return request<PromoResponse>(
    "promo",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(req),
    },
    SLOW_TIMEOUT_MS,
  );
}

/** GET /promo-status?jobId= */
export async function getStatus(jobId: string): Promise<StatusResponse> {
  if (IS_MOCK) {
    await sleep(300);
    const n = (mockPolls.get(jobId) ?? 0) + 1;
    mockPolls.set(jobId, n);
    if (n <= 4) return { status: "rendering", videoUrl: null, error: null };
    return { status: "done", videoUrl: SAMPLE_VIDEO, error: null };
  }
  return request<StatusResponse>(`promo-status?jobId=${encodeURIComponent(jobId)}`, undefined, STATUS_TIMEOUT_MS);
}

/** Extracts the 11-character video id from the common YouTube URL forms. */
export function parseYouTubeId(input: string): string | null {
  const match = input
    .trim()
    .match(
      /^(?:https?:\/\/)?(?:www\.|m\.|music\.)?(?:youtube\.com\/(?:watch\?(?:.*&)?v=|shorts\/|embed\/|live\/)|youtu\.be\/)([A-Za-z0-9_-]{11})(?:[?&#/].*)?$/,
    );
  return match ? match[1] : null;
}
