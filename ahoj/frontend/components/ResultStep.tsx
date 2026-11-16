"use client";

import { useState } from "react";
import type { Plan, Shape } from "@/lib/types";
import type { StyleSource } from "./AhojApp";
import { Spinner } from "./ui";

interface Props {
  videoUrl: string;
  plan: Plan | null;
  shape: Shape;
  brandName: string;
  styleSource: StyleSource | null;
  onAgain: () => void;
}

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Fallback for browsers or contexts without the async clipboard API.
    try {
      const area = document.createElement("textarea");
      area.value = text;
      area.style.position = "fixed";
      area.style.opacity = "0";
      document.body.appendChild(area);
      area.select();
      const ok = document.execCommand("copy");
      area.remove();
      return ok;
    } catch {
      return false;
    }
  }
}

const eyebrow = "text-[13px] font-semibold uppercase tracking-[0.08em] text-white/55";

export default function ResultStep({ videoUrl, plan, shape, brandName, styleSource, onAgain }: Props) {
  const [downloading, setDownloading] = useState(false);
  const [copied, setCopied] = useState<"idle" | "ok" | "failed">("idle");

  const vertical = shape === "vertical";
  const caption = plan?.caption ?? "";
  // The backend may send hashtags with or without the leading #.
  const hashtags = (plan?.hashtags ?? [])
    .map((tag) => String(tag).trim())
    .filter(Boolean)
    .map((tag) => (tag.startsWith("#") ? tag : `#${tag}`));
  const copyPayload = [caption, hashtags.join(" ")].filter(Boolean).join("\n\n");

  async function download() {
    setDownloading(true);
    try {
      // Fetch as a blob so the file saves instead of opening, even across origins.
      const res = await fetch(videoUrl);
      if (!res.ok) throw new Error("download failed");
      const blobUrl = URL.createObjectURL(await res.blob());
      const link = document.createElement("a");
      link.href = blobUrl;
      link.download = "ahoj-promo.mp4";
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(blobUrl), 10_000);
    } catch {
      window.open(videoUrl, "_blank", "noopener,noreferrer");
    } finally {
      setDownloading(false);
    }
  }

  async function copy() {
    const ok = await copyText(copyPayload);
    setCopied(ok ? "ok" : "failed");
    setTimeout(() => setCopied("idle"), 2200);
  }

  const video = (
    <video
      key={videoUrl}
      src={videoUrl}
      controls
      autoPlay
      muted
      loop
      playsInline
      aria-label="Your finished promo video"
      className={`reveal rounded-[28px] bg-[#1d1d1f] object-contain ${
        vertical
          ? "mx-auto aspect-[9/16] h-[72svh] max-h-[760px] min-h-[420px] max-w-full"
          : "aspect-video w-full"
      }`}
    />
  );

  const headline = (
    <div className="reveal reveal-1">
      <p className={eyebrow}>{brandName || "Your video"}</p>
      <h1
        id="result-title"
        className="mt-3 text-[40px] font-semibold leading-[1.0] tracking-[-0.04em] sm:text-[64px]"
      >
        {plan?.title || "Your video is ready"}
      </h1>
    </div>
  );

  const actions = (
    <div className="reveal reveal-2 flex flex-wrap items-center gap-3">
      <button type="button" className="btn-light" onClick={download} disabled={downloading}>
        {downloading && <Spinner />}
        {downloading ? "Preparing" : "Download video"}
      </button>
      {copyPayload && (
        <button type="button" className="btn-ghost-dark" onClick={copy}>
          {copied === "ok" ? "Copied" : copied === "failed" ? "Copy failed" : "Copy caption"}
        </button>
      )}
      <p className="sr-only" role="status" aria-live="polite">
        {copied === "ok" ? "Caption copied to clipboard." : copied === "failed" ? "Could not copy the caption." : ""}
      </p>
    </div>
  );

  const captionBlock = (
    <div className="reveal reveal-2">
      <p className={eyebrow}>Caption</p>
      <p className="mt-2 text-[21px] font-medium leading-snug tracking-[-0.015em] sm:text-[24px]">
        {caption || "No caption was generated."}
      </p>
      {hashtags.length > 0 && (
        <ul className="mt-4 flex flex-wrap gap-2" aria-label="Hashtags">
          {hashtags.map((tag) => (
            <li key={tag} className="rounded-full bg-white/10 px-3.5 py-1.5 text-[15px] text-[#2997ff]">
              {tag}
            </li>
          ))}
        </ul>
      )}
    </div>
  );

  const styleBlock = (
    <div className="reveal reveal-3">
      <p className={eyebrow}>Style</p>
      {styleSource?.referenceUrl ? (
        <a
          href={styleSource.referenceUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="group mt-3 flex items-center gap-4 rounded-[18px] bg-white/[0.07] p-3 transition duration-300 hover:bg-white/[0.12]"
        >
          {styleSource.videoId && (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={`https://img.youtube.com/vi/${styleSource.videoId}/hqdefault.jpg`}
              alt=""
              className="aspect-video w-32 shrink-0 rounded-[12px] object-cover"
            />
          )}
          <span className="min-w-0">
            <span className="block text-[17px] font-medium">Style copied from this video</span>
            {styleSource.summary && (
              <span className="mt-0.5 block text-[14px] text-white/60">{styleSource.summary}</span>
            )}
            <span className="mt-1 block truncate text-[14px] text-[#2997ff] group-hover:underline">
              {styleSource.referenceUrl} <span aria-hidden="true">›</span>
              <span className="sr-only"> (opens in a new tab)</span>
            </span>
          </span>
        </a>
      ) : (
        <p className="mt-2 text-[17px] text-white/60">Made with the default Ahoj style.</p>
      )}
    </div>
  );

  const again = (
    <p className="reveal reveal-4">
      <button
        type="button"
        onClick={onAgain}
        className="inline-flex items-center gap-1 rounded text-[17px] text-[#2997ff] underline-offset-4 hover:underline"
      >
        Make another <span aria-hidden="true">›</span>
      </button>
    </p>
  );

  return (
    <section className="on-dark min-h-[100svh] bg-black text-white" aria-labelledby="result-title">
      {vertical ? (
        // Vertical: video left, everything else beside it.
        <div className="wrap grid items-center gap-10 pb-10 pt-28 sm:pb-16 sm:pt-32 lg:grid-cols-[auto_minmax(0,1fr)] lg:gap-20">
          {video}
          <div className="space-y-9">
            {headline}
            {actions}
            {captionBlock}
            {styleBlock}
            {again}
          </div>
        </div>
      ) : (
        // Landscape: headline, wide video, details in two columns underneath.
        <div className="wrap pb-10 pt-28 sm:pb-16 sm:pt-32">
          <div className="flex flex-wrap items-end justify-between gap-6">
            {headline}
            {actions}
          </div>
          <div className="mt-8">{video}</div>
          <div className="mt-10 grid gap-10 sm:grid-cols-2 sm:gap-16">
            {captionBlock}
            <div className="space-y-8">
              {styleBlock}
              {again}
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
