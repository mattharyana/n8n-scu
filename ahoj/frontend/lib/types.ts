// Types that mirror the API contract in the frontend brief (v2).
// Do not rename or restructure these without telling Sam.

export type Length = 15 | 30 | 60;
export type Shape = "vertical" | "landscape";

/** Returned by POST /style. Treated as opaque: displayed, then passed back unchanged. */
export interface StyleProfile {
  summary: string;
  avgShotLength: number;
  cutStyle: string;
  captionStyle: string;
  colorMood: string;
  musicMood: string;
  structure: string;
  [key: string]: unknown;
}

export interface StyleResponse {
  style: StyleProfile;
  /** false = the backend could not read the video in time and returned its default style. */
  analysed?: boolean;
}

export interface Brand {
  name: string;
  tagline: string;
  cta: string;
}

export interface PromoClip {
  id: string; // c1, c2, c3 ... in upload order
  url: string;
  publicId: string;
  duration: number; // seconds
  width: number;
  height: number;
}

/** Body of POST /promo. */
export interface PromoRequest {
  brand: Brand;
  referenceUrl: string | null;
  style: StyleProfile | null;
  length: Length;
  shape: Shape;
  clips: PromoClip[];
}

export interface Shot {
  clipId: string;
  start: number;
  length: number;
  caption: string;
}

export interface Plan {
  /** One-sentence summary of the story the editor built. */
  story?: string;
  /** Closing line of the video. */
  endLine?: string;
  title: string;
  caption: string;
  hashtags: string[];
  shots: Shot[];
}

export interface PromoResponse {
  jobId: string;
  plan: Plan;
  director?: "claude" | "fallback";
  music?: boolean;
}

export type JobStatus = "queued" | "rendering" | "done" | "failed";

export interface StatusResponse {
  status: JobStatus;
  videoUrl: string | null;
  error: string | null;
}

// ---------- UI-only types (never sent to the backend) ----------

export interface StyleState {
  status: "idle" | "loading" | "done" | "error";
  /** True when the backend answered with its default style because it could not read the video. */
  fallback?: boolean;
  style: StyleProfile | null;
  error: string | null;
  url: string | null;
  videoId: string | null;
}

export interface ClipItem {
  key: string;
  name: string;
  size: number;
  status: "uploading" | "done" | "error";
  progress: number; // 0-100
  url?: string;
  publicId?: string;
  duration?: number;
  width?: number;
  height?: number;
  thumbUrl?: string;
  /** True in mock mode, where the thumbnail is a local video object URL. */
  thumbIsVideo?: boolean;
  error?: string;
}

export interface ClipThumb {
  thumbUrl?: string;
  thumbIsVideo?: boolean;
  name: string;
}

export const STAGES = [
  "Uploading",
  "Studying the style",
  "Scouting clips",
  "Cutting",
  "Adding music",
  "Rendering",
  "Done",
] as const;
