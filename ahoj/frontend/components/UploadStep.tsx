"use client";

import { useRef, useState } from "react";
import { MAX_CLIPS, MIN_CLIPS } from "@/lib/cloudinary";
import type { Brand, ClipItem, Length, Shape, StyleState } from "@/lib/types";
import PhoneReel from "./PhoneReel";
import { FadeImage, Segmented, Spinner, StyleSummary, Thumb, useInView } from "./ui";

interface Props {
  brand: Brand;
  onBrand: (brand: Brand) => void;
  referenceUrl: string;
  onReferenceUrl: (url: string) => void;
  styleState: StyleState;
  onRetryStyle: () => void;
  onSkipReference: () => void;
  length: Length;
  onLength: (length: Length) => void;
  shape: Shape;
  onShape: (shape: Shape) => void;
  clips: ClipItem[];
  onAddFiles: (files: File[]) => void;
  onRemoveClip: (key: string) => void;
  uploadErrors: string[];
  onDismissErrors: () => void;
  canSubmit: boolean;
  submitHint: string;
  onSubmit: () => void;
}

/** Photo tile with the text set inside the picture. */
function PhotoTile({
  src,
  alt,
  label,
  title,
  body,
  className = "",
  delay = 0,
}: {
  src: string;
  alt: string;
  label: string;
  title: string;
  body: string;
  className?: string;
  delay?: number;
}) {
  const { ref, inView } = useInView<HTMLLIElement>();
  return (
    <li
      ref={ref}
      style={delay ? { transitionDelay: `${delay}ms` } : undefined}
      className={`rise ${inView ? "is-in" : ""} group relative isolate overflow-hidden rounded-[28px] bg-ink text-white ${className}`}
    >
      <div className="absolute inset-0 -z-20 transition-transform duration-[1600ms] ease-[cubic-bezier(0.22,1,0.36,1)] group-hover:scale-[1.05]">
        <FadeImage src={src} alt={alt} className="h-full w-full object-cover" />
      </div>
      <div className="absolute inset-0 -z-10 bg-gradient-to-b from-black/65 via-black/15 to-transparent" />
      <div className="p-7 sm:p-9">
        <p className="text-[13px] font-semibold uppercase tracking-[0.08em] text-white/75">{label}</p>
        <h3 className="mt-2 max-w-[14ch] text-[30px] font-semibold leading-[1.05] tracking-[-0.03em] sm:text-[38px]">
          {title}
        </h3>
        <p className="mt-3 max-w-[30ch] text-[17px] leading-snug text-white/85">{body}</p>
      </div>
    </li>
  );
}

/** Group heading in the builder: bold lead, quiet follow-up. */
function GroupTitle({ lead, rest }: { lead: string; rest: string }) {
  return (
    <h3 className="text-[24px] font-semibold leading-tight tracking-[-0.022em] sm:text-[28px]">
      {lead} <span className="text-mute">{rest}</span>
    </h3>
  );
}

export default function UploadStep(props: Props) {
  const {
    brand,
    onBrand,
    referenceUrl,
    onReferenceUrl,
    styleState,
    onRetryStyle,
    onSkipReference,
    length,
    onLength,
    shape,
    onShape,
    clips,
    onAddFiles,
    onRemoveClip,
    uploadErrors,
    onDismissErrors,
    canSubmit,
    submitHint,
    onSubmit,
  } = props;

  const howTitle = useInView<HTMLHeadingElement>();
  const theatre = useInView<HTMLDivElement>();
  const studioTitle = useInView<HTMLHeadingElement>();
  const studioGrid = useInView<HTMLDivElement>();
  const fileInput = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const full = clips.length >= MAX_CLIPS;
  const doneClips = clips.filter((c) => c.status === "done");
  const firstClip = doneClips[0];

  const styleLabel =
    styleState.status === "done" && !styleState.fallback
      ? "Reference video"
      : styleState.status === "loading"
        ? "Analysing the video"
        : "Default";

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (canSubmit) onSubmit();
      }}
      noValidate
    >
      {/* ---------- Hero: full-bleed photo, headline bottom left, actions bottom right ---------- */}
      <section
        id="top"
        className="on-dark relative isolate flex min-h-[100svh] items-end overflow-hidden bg-black text-white"
        aria-labelledby="hero-title"
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src="/img/golden-gate.jpg"
          alt="A red suspension bridge crossing a bright blue bay"
          className="hero-zoom absolute inset-0 -z-20 h-full w-full object-cover"
        />
        <div className="absolute inset-0 -z-10 bg-gradient-to-t from-black/80 via-black/20 to-black/5" />

        <div className="mx-auto flex w-full max-w-[1440px] flex-col gap-8 px-5 pb-10 sm:px-10 sm:pb-14 lg:flex-row lg:items-end lg:justify-between">
          <div className="reveal">
            <h1
              id="hero-title"
              className="max-w-[13ch] text-[46px] font-semibold leading-[0.98] tracking-[-0.045em] sm:text-[76px] lg:text-[88px]"
            >
              Turn phone clips into a promo video.
            </h1>
            <p className="mt-5 max-w-[36ch] text-[19px] font-medium leading-snug text-white/90 sm:text-[24px]">
              Upload 3 to 20 clips, choose a style, and download one finished video a few minutes later.
            </p>
          </div>
          <div className="reveal reveal-2 flex shrink-0 flex-wrap items-center gap-3">
            <a href="#how" className="btn-ghost-dark">
              How it works
            </a>
            <a href="#studio" className="btn-light">
              Create a video
            </a>
          </div>
        </div>
      </section>

      {/* ---------- How it works: photo bento ---------- */}
      <section id="how" className="scroll-mt-[52px] bg-white" aria-labelledby="how-title">
        <div className="wrap py-20 sm:py-28">
          <h2
            id="how-title"
            ref={howTitle.ref}
            className={`rise ${howTitle.inView ? "is-in" : ""} max-w-[17ch] text-[40px] font-semibold leading-[1.03] tracking-[-0.04em] sm:text-[64px]`}
          >
            How it works. <span className="text-mute">Four steps from raw clips to a finished video.</span>
          </h2>

          <ul className="mt-12 grid gap-4 lg:grid-cols-12">
            <PhotoTile
              className="h-[400px] sm:h-[520px] lg:col-span-7"
              src="/img/yosemite.jpg"
              alt="A river valley between granite cliffs at dusk"
              label="Step 1"
              title="Upload your clips"
              body="Add 3 to 20 videos from your phone, up to 40 MB each. You don't need to trim or sort them."
            />
            <PhotoTile
              className="h-[400px] sm:h-[520px] lg:col-span-5"
              delay={140}
              src="/img/desert-road.jpg"
              alt="An empty road running through red desert rock"
              label="Step 2"
              title="Choose a style"
              body="Paste a link to a YouTube video you like. Ahoj studies how it is edited and cuts yours the same way."
            />
            <PhotoTile
              className="h-[400px] sm:h-[460px] lg:col-span-5"
              src="/img/coast.jpg"
              alt="Waves meeting a sandy shoreline, seen from above"
              label="Step 3"
              title="Pick length and shape"
              body="15, 30 or 60 seconds. Vertical for phone feeds, landscape for wide screens."
            />
            <PhotoTile
              className="h-[400px] sm:h-[460px] lg:col-span-7"
              delay={140}
              src="/img/beach.jpg"
              alt="Calm surf on a beach at sunset"
              label="Step 4"
              title="Download your video"
              body="You get one MP4 file, plus a caption and hashtags you can copy for the post."
            />
          </ul>
        </div>
      </section>

      {/* ---------- Theatre: the product in motion ---------- */}
      <section className="on-dark overflow-hidden bg-black text-white" aria-labelledby="theatre-title">
        <div
          ref={theatre.ref}
          className={`rise ${theatre.inView ? "is-in" : ""} wrap grid items-center gap-14 py-20 sm:py-32 lg:grid-cols-[auto_minmax(0,1fr)] lg:gap-24`}
        >
          <PhoneReel brandName={brand.name.trim()} tagline={brand.tagline.trim()} />
          <div>
            <p className="text-[13px] font-semibold uppercase tracking-[0.08em] text-white/55">What you get</p>
            <h2
              id="theatre-title"
              className="mt-3 max-w-[14ch] text-[40px] font-semibold leading-[1.02] tracking-[-0.04em] sm:text-[60px]"
            >
              An edited video with captions, music and your brand.
            </h2>
            <p className="mt-6 max-w-[42ch] text-[19px] leading-relaxed text-white/70 sm:text-[21px]">
              Ahoj picks the best moments from each clip and arranges them to match the style you chose. It
              adds captions and music, and ends the video with your business name and call to action.
            </p>
            <dl className="mt-10 grid max-w-[520px] grid-cols-3 gap-6 border-t border-white/15 pt-8">
              {(
                [
                  ["3–20", "clips you upload"],
                  ["2–3 min", "to create it"],
                  ["1", "video you download"],
                ] as [string, string][]
              ).map(([figure, label]) => (
                <div key={label} className="flex flex-col-reverse">
                  <dt className="mt-1 text-[14px] text-white/55">{label}</dt>
                  <dd className="text-[30px] font-semibold tracking-[-0.03em] sm:text-[40px]">{figure}</dd>
                </div>
              ))}
            </dl>
          </div>
        </div>
      </section>

      {/* ---------- Studio: sticky preview left, options right ---------- */}
      <section id="studio" className="scroll-mt-[52px] bg-fog" aria-labelledby="studio-title">
        <div className="wrap py-20 sm:py-28">
          <h2
            id="studio-title"
            ref={studioTitle.ref}
            className={`rise ${studioTitle.inView ? "is-in" : ""} text-[40px] font-semibold leading-[1.03] tracking-[-0.04em] sm:text-[64px]`}
          >
            Create your video
          </h2>

          <div
            ref={studioGrid.ref}
            style={{ transitionDelay: "120ms" }}
            className={`rise ${studioGrid.inView ? "is-in" : ""} mt-12 grid gap-12 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)] lg:gap-16`}
          >
            {/* ----- Preview and primary action ----- */}
            <aside className="order-last lg:order-first" aria-label="Preview and summary">
              <div className="[@media(min-height:720px)]:lg:sticky [@media(min-height:720px)]:lg:top-[100px]">
                <div className="rounded-[28px] bg-white p-6">
                  <div
                    className={`relative isolate mx-auto overflow-hidden rounded-[22px] bg-ink text-white ${
                      shape === "vertical" ? "aspect-[9/16] w-[56%] max-w-[200px]" : "aspect-video w-full"
                    }`}
                  >
                    {firstClip ? (
                      <Thumb
                        thumbUrl={firstClip.thumbUrl}
                        thumbIsVideo={firstClip.thumbIsVideo}
                        alt="Your first clip"
                        className="absolute inset-0 -z-20 h-full w-full"
                      />
                    ) : (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src="/img/beach.jpg"
                        alt=""
                        className="absolute inset-0 -z-20 h-full w-full object-cover"
                      />
                    )}
                    <div className="absolute inset-0 -z-10 bg-gradient-to-t from-black/75 via-black/10 to-black/20" />
                    <span className="absolute left-3 top-3 rounded-full bg-black/50 px-2.5 py-1 text-[11px] font-medium tabular-nums backdrop-blur">
                      {length} s
                    </span>
                    <div className="absolute inset-x-0 bottom-0 p-4 text-center">
                      <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-white/80">
                        {brand.name.trim() || "Your business"}
                      </p>
                      <p className="mt-1 text-[18px] font-semibold leading-tight tracking-[-0.02em]">
                        {brand.tagline.trim() || "Your tagline"}
                      </p>
                      {brand.cta.trim() && (
                        <span className="mt-3 inline-block rounded-full bg-white px-3.5 py-1.5 text-[12px] font-medium text-ink">
                          {brand.cta.trim()}
                        </span>
                      )}
                    </div>
                  </div>
                  <p className="mt-4 text-center text-[12px] text-mute">Rough preview of the closing frame. The finished video will look different.</p>

                  <dl className="mt-4 divide-y divide-[#e8e8ed] border-t border-[#e8e8ed] text-[15px]">
                    {(
                      [
                        ["Style", styleLabel],
                        ["Length", `${length} seconds`],
                        ["Shape", shape === "vertical" ? "Vertical 9:16" : "Landscape 16:9"],
                        ["Clips", doneClips.length < MIN_CLIPS ? `${doneClips.length} of ${MIN_CLIPS} needed` : `${doneClips.length} ready`],
                      ] as [string, string][]
                    ).map(([term, detail]) => (
                      <div key={term} className="flex items-baseline justify-between gap-4 py-2.5">
                        <dt className="text-mute">{term}</dt>
                        <dd className="text-right font-medium text-ink">{detail}</dd>
                      </div>
                    ))}
                  </dl>

                  <button type="submit" className="btn-primary mt-6 min-h-[54px] w-full text-[18px]" disabled={!canSubmit}>
                    Create video
                  </button>
                  <p className="mt-3 text-center text-[14px] text-mute" aria-live="polite">
                    {submitHint}
                  </p>
                </div>
              </div>
            </aside>

            {/* ----- Options ----- */}
            <div className="min-w-0">
              {/* Brand */}
              <div className="pb-12">
                <GroupTitle lead="Your business." rest="These appear in the video." />
                <div className="mt-6 grid gap-5 sm:grid-cols-2">
                  <div className="sm:col-span-2">
                    <label htmlFor="brand-name" className="field-label">
                      Business name
                    </label>
                    <input
                      id="brand-name"
                      className="field"
                      type="text"
                      required
                      aria-required="true"
                      autoComplete="organization"
                      placeholder="Sam & Lukáš Travel Co."
                      value={brand.name}
                      onChange={(e) => onBrand({ ...brand, name: e.target.value })}
                    />
                  </div>
                  <div>
                    <label htmlFor="brand-tagline" className="field-label">
                      Tagline
                    </label>
                    <input
                      id="brand-tagline"
                      className="field"
                      type="text"
                      placeholder="California, the long way round"
                      value={brand.tagline}
                      onChange={(e) => onBrand({ ...brand, tagline: e.target.value })}
                    />
                  </div>
                  <div>
                    <label htmlFor="brand-cta" className="field-label">
                      Call to action
                    </label>
                    <input
                      id="brand-cta"
                      className="field"
                      type="text"
                      placeholder="Book your trip"
                      value={brand.cta}
                      onChange={(e) => onBrand({ ...brand, cta: e.target.value })}
                    />
                  </div>
                </div>
              </div>

              {/* Look */}
              <div className="border-t border-hair py-12">
                <GroupTitle lead="Style." rest="Optional." />
                <p className="mt-2 text-[15px] text-mute">
                  Paste a link to a YouTube video and Ahoj copies its editing style. If you skip this, Ahoj uses
                  its default style.
                </p>

                {(
                  <div className="mt-6">
                    <label htmlFor="reference-url" className="field-label">
                      YouTube link
                    </label>
                    <input
                      id="reference-url"
                      className="field"
                      type="url"
                      inputMode="url"
                      autoComplete="off"
                      spellCheck={false}
                      placeholder="https://www.youtube.com/watch?v=..."
                      value={referenceUrl}
                      onChange={(e) => onReferenceUrl(e.target.value)}
                      aria-describedby="reference-status"
                      aria-invalid={styleState.status === "error" ? true : undefined}
                    />

                    <div id="reference-status" aria-live="polite" className="mt-4">
                      {styleState.status === "idle" && (
                        <p className="text-[14px] text-mute">Public videos only. Analysis can take a little over a minute.</p>
                      )}

                      {styleState.status === "loading" && (
                        <div className="reveal flex items-center gap-4 rounded-[22px] bg-white p-6">
                          <Spinner className="shrink-0 text-accent" />
                          <div>
                            <p className="text-[17px] font-medium">Analysing the video</p>
                            <p className="text-[14px] text-mute">
                              Reading its pacing, cuts, captions and colour. This can take a little over a minute.
                            </p>
                          </div>
                        </div>
                      )}

                      {styleState.status === "error" && (
                        <div className="reveal rounded-[22px] bg-[#fff2f2] p-6" role="alert">
                          <p className="text-[17px] font-medium text-[#b3261e]">We couldn&apos;t read that video.</p>
                          <p className="mt-1 text-[15px] text-ink">{styleState.error}</p>
                          <div className="mt-4 flex flex-wrap items-center gap-x-6 gap-y-2">
                            {styleState.videoId && (
                              <button type="button" className="link-arrow" onClick={onRetryStyle}>
                                Try again <span aria-hidden="true">›</span>
                              </button>
                            )}
                            <button type="button" className="link-arrow" onClick={onSkipReference}>
                              Continue without a reference <span aria-hidden="true">›</span>
                            </button>
                          </div>
                        </div>
                      )}

                      {styleState.status === "done" && styleState.style && styleState.fallback && (
                        <div className="reveal rounded-[22px] bg-[#fff8e6] p-6">
                          <p className="text-[17px] font-medium text-ink">
                            We couldn&apos;t read that video, so we&apos;ll use the default style.
                          </p>
                          <p className="mt-1 text-[15px] text-mute">
                            You can continue, or try a different public YouTube link.
                          </p>
                          <div className="mt-4 flex flex-wrap items-center gap-x-6 gap-y-2">
                            <button type="button" className="link-arrow" onClick={onRetryStyle}>
                              Try again <span aria-hidden="true">›</span>
                            </button>
                            <button type="button" className="link-arrow" onClick={onSkipReference}>
                              Remove link <span aria-hidden="true">›</span>
                            </button>
                          </div>
                        </div>
                      )}

                      {styleState.status === "done" && styleState.style && !styleState.fallback && (
                        <div className="reveal overflow-hidden rounded-[22px] bg-white">
                          {styleState.videoId && (
                            // eslint-disable-next-line @next/next/no-img-element
                            <img
                              src={`https://img.youtube.com/vi/${styleState.videoId}/hqdefault.jpg`}
                              alt="Thumbnail of the reference video"
                              className="h-44 w-full object-cover sm:h-56"
                            />
                          )}
                          <div className="p-6 sm:p-8">
                            <p className="eyebrow mb-2">Style profile</p>
                            <StyleSummary style={styleState.style} />
                            <button type="button" className="link-arrow mt-5 text-[15px]" onClick={onSkipReference}>
                              Remove reference <span aria-hidden="true">›</span>
                            </button>
                          </div>
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </div>

              {/* Format */}
              <div className="border-t border-hair py-12">
                <GroupTitle lead="Format." rest="Length and shape of the video." />
                <div className="mt-6 flex flex-wrap gap-x-12 gap-y-6">
                  <Segmented<Length>
                    legend="Length"
                    name="length"
                    value={length}
                    onChange={onLength}
                    options={[
                      { value: 15, label: "15 s" },
                      { value: 30, label: "30 s" },
                      { value: 60, label: "60 s" },
                    ]}
                  />
                  <Segmented<Shape>
                    legend="Shape"
                    name="shape"
                    value={shape}
                    onChange={onShape}
                    options={[
                      { value: "vertical", label: "Vertical 9:16" },
                      { value: "landscape", label: "Landscape 16:9" },
                    ]}
                  />
                </div>
              </div>

              {/* Clips */}
              <div className="border-t border-hair pt-12">
                <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2">
                  <GroupTitle lead="Clips." rest="Add 3 to 20 videos." />
                  <p className="text-[14px] tabular-nums text-mute" aria-live="polite">
                    {doneClips.length} ready · up to 40 MB each
                  </p>
                </div>

                <input
                  ref={fileInput}
                  id="clip-input"
                  type="file"
                  accept="video/*"
                  multiple
                  className="sr-only"
                  tabIndex={-1}
                  aria-hidden="true"
                  onChange={(e) => {
                    if (e.target.files?.length) onAddFiles(Array.from(e.target.files));
                    e.target.value = "";
                  }}
                />

                <div
                  onDragEnter={(e) => {
                    e.preventDefault();
                    setDragging(true);
                  }}
                  onDragOver={(e) => {
                    e.preventDefault();
                    setDragging(true);
                  }}
                  onDragLeave={(e) => {
                    if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false);
                  }}
                  onDrop={(e) => {
                    e.preventDefault();
                    setDragging(false);
                    if (e.dataTransfer.files?.length) onAddFiles(Array.from(e.dataTransfer.files));
                  }}
                  className={`mt-6 flex flex-col items-start gap-5 rounded-[22px] border-2 border-dashed p-6 transition duration-300 ease-out sm:flex-row sm:items-center sm:justify-between sm:p-8 ${
                    dragging ? "scale-[1.01] border-accent bg-accent/5" : "border-hair bg-white"
                  }`}
                >
                  <div className="flex items-center gap-4">
                    <svg
                      className="h-10 w-10 shrink-0 text-mute"
                      viewBox="0 0 48 48"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      aria-hidden="true"
                    >
                      <rect x="6" y="11" width="26" height="26" rx="6" />
                      <path d="M32 21l10-6v18l-10-6" />
                      <path d="M19 30V19m0 0l-4.5 4.5M19 19l4.5 4.5" />
                    </svg>
                    <div>
                      <p className="text-[19px] font-semibold tracking-[-0.015em]">
                        {full ? "You've added 20 clips, the maximum" : "Drag your clips here"}
                      </p>
                      <p className="text-[14px] text-mute">
                        {full ? "Remove a clip to add a different one." : "MP4 or MOV files, up to 40 MB each."}
                      </p>
                    </div>
                  </div>
                  <button
                    type="button"
                    className="btn-secondary shrink-0 disabled:cursor-not-allowed disabled:opacity-40"
                    disabled={full}
                    onClick={() => fileInput.current?.click()}
                  >
                    Choose files
                  </button>
                </div>

                {uploadErrors.length > 0 && (
                  <div className="reveal mt-4 rounded-[22px] bg-[#fff2f2] p-5" role="alert">
                    <div className="flex items-start justify-between gap-4">
                      <ul className="space-y-1 text-[15px] text-[#b3261e]">
                        {uploadErrors.map((message, i) => (
                          <li key={i}>{message}</li>
                        ))}
                      </ul>
                      <button type="button" className="link-arrow shrink-0 text-[15px]" onClick={onDismissErrors}>
                        Dismiss
                      </button>
                    </div>
                  </div>
                )}

                {clips.length > 0 && (
                  <ul className="mt-6 grid grid-cols-2 gap-4 sm:grid-cols-3" aria-label="Your clips">
                    {clips.map((clip, index) => (
                      <li
                        key={clip.key}
                        className="reveal relative overflow-hidden rounded-[18px] bg-white transition duration-300 ease-out hover:scale-[1.02]"
                      >
                        <div className="relative aspect-[4/5] w-full bg-[#e8e8ed]">
                          {clip.status === "done" ? (
                            <Thumb
                              thumbUrl={clip.thumbUrl}
                              thumbIsVideo={clip.thumbIsVideo}
                              alt={`Thumbnail of clip ${index + 1}`}
                              className="absolute inset-0 h-full w-full"
                            />
                          ) : (
                            <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 px-4">
                              {clip.status === "uploading" ? (
                                <>
                                  <span className="text-[24px] font-semibold tabular-nums tracking-[-0.02em]">
                                    {clip.progress}%
                                  </span>
                                  <div
                                    className="h-1 w-full overflow-hidden rounded-full bg-hair"
                                    role="progressbar"
                                    aria-label={`Uploading ${clip.name}`}
                                    aria-valuemin={0}
                                    aria-valuemax={100}
                                    aria-valuenow={clip.progress}
                                  >
                                    <div
                                      className="h-full rounded-full bg-accent transition-[width] duration-300 ease-out"
                                      style={{ width: `${clip.progress}%` }}
                                    />
                                  </div>
                                  <span className="text-[13px] text-mute">Uploading</span>
                                </>
                              ) : (
                                <p className="text-center text-[13px] text-[#b3261e]" role="alert">
                                  {clip.error ?? "Upload failed."} Remove it and try again.
                                </p>
                              )}
                            </div>
                          )}

                          <span className="absolute left-2 top-2 rounded-full bg-black/55 px-2.5 py-1 text-[12px] font-medium tabular-nums text-white backdrop-blur">
                            {index + 1}
                          </span>
                          <button
                            type="button"
                            onClick={() => onRemoveClip(clip.key)}
                            aria-label={`Remove clip ${index + 1}, ${clip.name}`}
                            className="absolute right-2 top-2 flex h-8 w-8 items-center justify-center rounded-full bg-black/55 text-white backdrop-blur transition duration-200 hover:bg-black/80"
                          >
                            <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
                              <path d="M3.5 3.5l9 9m0-9l-9 9" />
                            </svg>
                          </button>
                        </div>
                        <div className="flex items-center justify-between gap-2 px-3 py-2.5">
                          <span className="truncate text-[13px] text-ink" title={clip.name}>
                            {clip.name}
                          </span>
                          {clip.status === "done" && typeof clip.duration === "number" && clip.duration > 0 && (
                            <span className="shrink-0 text-[12px] tabular-nums text-mute">
                              {clip.duration.toFixed(1)} s
                            </span>
                          )}
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
          </div>
        </div>
      </section>
    </form>
  );
}
