"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { analyseStyle, createPromo, getStatus, parseYouTubeId } from "@/lib/api";
import { MAX_CLIPS, MAX_CLIP_BYTES, MIN_CLIPS, uploadClip } from "@/lib/cloudinary";
import type {
  Brand,
  ClipItem,
  ClipThumb,
  Length,
  Plan,
  PromoRequest,
  Shape,
  StyleState,
} from "@/lib/types";
import UploadStep from "./UploadStep";
import ProgressStep from "./ProgressStep";
import ResultStep from "./ResultStep";

const POLL_INTERVAL_MS = 3000;
// Four minutes: the first render with newly uploaded clips is slow.
const POLL_TIMEOUT_MS = 4 * 60 * 1000;

const IDLE_STYLE: StyleState = { status: "idle", style: null, error: null, url: null, videoId: null };

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

type Phase = "upload" | "progress" | "result";

interface Job {
  stage: number; // index into STAGES
  plan: Plan | null;
  error: string | null;
  videoUrl: string | null;
}

/** What the finished video was styled from, shown on the Result screen. */
export interface StyleSource {
  referenceUrl: string | null;
  videoId: string | null;
  summary: string | null;
}

// ---------- eased in-page scrolling ----------

const GLIDE_IDS = ["top", "how", "studio"];
let glideFrame = 0;

function glideTo(id: string) {
  const el = document.getElementById(id);
  if (!el) return;
  cancelAnimationFrame(glideFrame);
  const start = window.scrollY;
  const end = id === "top" ? 0 : el.getBoundingClientRect().top + start;
  const distance = end - start;
  if (Math.abs(distance) < 2) return;
  const duration = Math.min(750, Math.max(450, Math.abs(distance) * 0.25));
  const t0 = performance.now();
  const ease = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
  const step = (now: number) => {
    const p = Math.min(1, (now - t0) / duration);
    // Re-read the target every frame, so late layout changes cannot leave it short.
    const target = id === "top" ? 0 : el.getBoundingClientRect().top + window.scrollY;
    window.scrollTo(0, start + (target - start) * ease(p));
    if (p < 1) glideFrame = requestAnimationFrame(step);
    else history.replaceState(null, "", id === "top" ? location.pathname : `#${id}`);
  };
  glideFrame = requestAnimationFrame(step);
}

let keyCounter = 0;
const newKey = () => `clip-${Date.now()}-${++keyCounter}`;

export default function AhojApp() {
  const [phase, setPhase] = useState<Phase>("upload");

  // ----- form state -----
  const [brand, setBrand] = useState<Brand>({
    name: "Sam & Lukáš Travel Co.",
    tagline: "California, the long way round",
    cta: "Book your trip",
  });
  const [referenceUrl, setReferenceUrl] = useState("");
  const [styleState, setStyleState] = useState<StyleState>(IDLE_STYLE);
  const [analysisNonce, setAnalysisNonce] = useState(0);
  const [length, setLength] = useState<Length>(30);
  const [shape, setShape] = useState<Shape>("vertical");

  // ----- clips -----
  const [clips, setClips] = useState<ClipItem[]>([]);
  const [uploadErrors, setUploadErrors] = useState<string[]>([]);
  const clipsRef = useRef<ClipItem[]>([]);
  clipsRef.current = clips;
  const aborters = useRef(new Map<string, AbortController>());

  // ----- job -----
  const [job, setJob] = useState<Job>({ stage: 0, plan: null, error: null, videoUrl: null });
  const [jobThumbs, setJobThumbs] = useState<Record<string, ClipThumb>>({});
  const [styleSource, setStyleSource] = useState<StyleSource | null>(null);
  const runRef = useRef(0);

  // ---------- reference video analysis (POST /style) ----------

  const styleReq = useRef(0);

  const onReferenceUrl = useCallback((value: string) => {
    setReferenceUrl(value);
    styleReq.current++; // cancels any analysis in flight
    const url = value.trim();
    const videoId = parseYouTubeId(url);
    // A valid link goes straight to "loading" so the primary action waits for it.
    setStyleState(videoId ? { status: "loading", style: null, error: null, url, videoId } : IDLE_STYLE);
  }, []);

  useEffect(() => {
    const url = referenceUrl.trim();
    if (!url) return;
    const videoId = parseYouTubeId(url);
    const req = ++styleReq.current;

    const timer = setTimeout(
      async () => {
        if (!videoId) {
          setStyleState({
            status: "error",
            style: null,
            url,
            videoId: null,
            error: "That doesn't look like a YouTube link. Paste the full address of a public video.",
          });
          return;
        }
        try {
          const res = await analyseStyle(url);
          if (styleReq.current !== req) return;
          if (!res?.style) throw new Error("The style could not be read from this video.");
          setStyleState({
            status: "done",
            style: res.style,
            error: null,
            url,
            videoId,
            fallback: res.analysed === false,
          });
        } catch (e) {
          if (styleReq.current !== req) return;
          setStyleState({
            status: "error",
            style: null,
            url,
            videoId,
            error: e instanceof Error ? e.message : "The video could not be analysed.",
          });
        }
      },
      videoId ? 500 : 900,
    );
    return () => clearTimeout(timer);
  }, [referenceUrl, analysisNonce]);

  const retryStyle = useCallback(() => {
    const url = referenceUrl.trim();
    const videoId = parseYouTubeId(url);
    if (!videoId) return;
    setStyleState({ status: "loading", style: null, error: null, url, videoId });
    setAnalysisNonce((n) => n + 1);
  }, [referenceUrl]);

  const skipReference = useCallback(() => {
    styleReq.current++;
    setReferenceUrl("");
    setStyleState(IDLE_STYLE);
  }, []);

  // ---------- clips: add, upload, remove ----------

  const patchClip = useCallback((key: string, patch: Partial<ClipItem>) => {
    setClips((list) => list.map((c) => (c.key === key ? { ...c, ...patch } : c)));
  }, []);

  const addFiles = useCallback(
    (files: File[]) => {
      const errors: string[] = [];
      const accepted: ClipItem[] = [];
      let slots = MAX_CLIPS - clipsRef.current.length;

      for (const file of files) {
        const isVideo = file.type.startsWith("video/") || /\.(mp4|mov|m4v|webm|avi|mkv)$/i.test(file.name);
        if (!isVideo) {
          errors.push(`"${file.name}" is not a video file.`);
          continue;
        }
        if (file.size > MAX_CLIP_BYTES) {
          const mb = (file.size / (1024 * 1024)).toFixed(0);
          errors.push(`"${file.name}" is ${mb} MB. The limit is 40 MB per clip.`);
          continue;
        }
        if (slots <= 0) {
          errors.push(`"${file.name}" was skipped. ${MAX_CLIPS} clips is the maximum.`);
          continue;
        }
        slots--;

        const key = newKey();
        const controller = new AbortController();
        aborters.current.set(key, controller);
        accepted.push({ key, name: file.name, size: file.size, status: "uploading", progress: 0 });

        uploadClip(file, (progress) => patchClip(key, { progress }), controller.signal)
          .then((done) => patchClip(key, { ...done, status: "done", progress: 100 }))
          .catch((e: unknown) => {
            if (e instanceof Error && e.name === "AbortError") return;
            patchClip(key, {
              status: "error",
              error: e instanceof Error ? e.message : "Upload failed.",
            });
          })
          .finally(() => aborters.current.delete(key));
      }

      if (accepted.length) setClips((list) => [...list, ...accepted]);
      setUploadErrors(errors);
    },
    [patchClip],
  );

  const removeClip = useCallback((key: string) => {
    aborters.current.get(key)?.abort();
    aborters.current.delete(key);
    const clip = clipsRef.current.find((c) => c.key === key);
    if (clip?.url?.startsWith("blob:")) URL.revokeObjectURL(clip.url);
    setClips((list) => list.filter((c) => c.key !== key));
  }, []);

  // ---------- submit rules ----------

  const doneClips = clips.filter((c) => c.status === "done");
  const uploading = clips.some((c) => c.status === "uploading");
  const analysing = styleState.status === "loading";
  const canSubmit = doneClips.length >= MIN_CLIPS && brand.name.trim() !== "" && !analysing && !uploading;

  let submitHint = "";
  if (brand.name.trim() === "") submitHint = "Add a business name to continue.";
  else if (doneClips.length < MIN_CLIPS && !uploading) {
    const missing = MIN_CLIPS - doneClips.length;
    submitHint = `Add ${missing} more ${missing === 1 ? "clip" : "clips"} to continue.`;
  } else if (uploading) submitHint = "Waiting for your uploads to finish.";
  else if (analysing) submitHint = "Waiting for the style analysis to finish.";
  else submitHint = `${doneClips.length} clips ready. Creating the video takes two to three minutes.`;

  // ---------- the job: POST /promo once, then poll GET /promo-status ----------

  const startJob = useCallback(async () => {
    const run = ++runRef.current;
    const alive = () => runRef.current === run;
    const bump = (stage: number) => setJob((j) => ({ ...j, stage: Math.max(j.stage, stage) }));

    const ready = clipsRef.current.filter((c) => c.status === "done");
    const thumbs: Record<string, ClipThumb> = {};
    const payloadClips = ready.map((c, i) => {
      const id = `c${i + 1}`;
      thumbs[id] = { thumbUrl: c.thumbUrl, thumbIsVideo: c.thumbIsVideo, name: c.name };
      return {
        id,
        url: c.url ?? "",
        publicId: c.publicId ?? "",
        duration: c.duration ?? 0,
        width: c.width ?? 0,
        height: c.height ?? 0,
      };
    });

    const useReference = styleState.status === "done" && styleState.style !== null;

    const request: PromoRequest = {
      brand: { name: brand.name.trim(), tagline: brand.tagline.trim(), cta: brand.cta.trim() },
      referenceUrl: useReference ? styleState.url : null,
      style: useReference ? styleState.style : null,
      length,
      shape,
      clips: payloadClips,
    };

    setJobThumbs(thumbs);
    setStyleSource(
      // Only claim the reference when the backend really analysed it.
      useReference && !styleState.fallback
        ? {
            referenceUrl: styleState.url,
            videoId: styleState.videoId,
            summary: typeof styleState.style?.summary === "string" ? styleState.style.summary : null,
          }
        : null,
    );
    setJob({ stage: 1, plan: null, error: null, videoUrl: null });
    setPhase("progress");
    window.scrollTo({ top: 0 });

    // POST /promo takes about 45 seconds, so the second stage arrives part-way through.
    const scoutTimer = setTimeout(() => alive() && bump(2), 15000);

    try {
      const res = await createPromo(request);
      if (!alive()) return;
      if (!res?.jobId) throw new Error("The server did not return a job. Please try again.");
      setJob((j) => ({ ...j, plan: res.plan ?? null, stage: Math.max(j.stage, 3) }));

      const deadline = Date.now() + POLL_TIMEOUT_MS;
      let polls = 0;
      let failures = 0;

      while (true) {
        await sleep(POLL_INTERVAL_MS);
        if (!alive()) return;
        if (Date.now() > deadline) {
          throw new Error("This is taking longer than four minutes. The render may be stuck. Please try again.");
        }

        let status;
        try {
          status = await getStatus(res.jobId);
          failures = 0;
        } catch (e) {
          if (++failures >= 3) throw e; // tolerate a couple of dropped polls
          continue;
        }
        if (!alive()) return;
        polls++;

        if (status.status === "failed") {
          throw new Error(status.error || "The render failed. Please try again.");
        }
        if (status.status === "done") {
          if (!status.videoUrl) throw new Error("The render finished without a video. Please try again.");
          setJob((j) => ({ ...j, stage: 6, videoUrl: status.videoUrl }));
          await sleep(900);
          if (!alive()) return;
          setPhase("result");
          window.scrollTo({ top: 0 });
          return;
        }
        // queued / rendering: the finer stages are presentation only.
        bump(status.status === "rendering" && polls >= 3 ? 5 : polls >= 2 ? 4 : 3);
      }
    } catch (e) {
      if (!alive()) return;
      setJob((j) => ({
        ...j,
        error: e instanceof Error ? e.message : "Something went wrong. Please try again.",
      }));
    } finally {
      clearTimeout(scoutTimer);
    }
  }, [brand, length, shape, styleState]);

  const backToUpload = useCallback(() => {
    runRef.current++; // stops any polling loop
    setPhase("upload");
    window.scrollTo({ top: 0 });
  }, []);

  const makeAnother = useCallback(() => {
    runRef.current++;
    for (const clip of clipsRef.current) {
      if (clip.url?.startsWith("blob:")) URL.revokeObjectURL(clip.url);
    }
    setClips([]);
    setUploadErrors([]);
    setJob({ stage: 0, plan: null, error: null, videoUrl: null });
    setPhase("upload");
    window.scrollTo({ top: 0 });
  }, []);

  // Stop everything if the page goes away.
  useEffect(() => {
    const map = aborters.current;
    return () => {
      runRef.current++;
      map.forEach((controller) => controller.abort());
    };
  }, []);

  // ---------- header navigation ----------

  const navLinks = [
    { id: "top", label: "Overview" },
    { id: "how", label: "How it works" },
    { id: "studio", label: "Create" },
  ];
  const [activeSection, setActiveSection] = useState("top");

  useEffect(() => {
    if (phase !== "upload") return;
    const ids = ["top", "how", "studio"];
    const onScroll = () => {
      let current = ids[0];
      for (const id of ids) {
        const el = document.getElementById(id);
        if (el && el.getBoundingClientRect().top <= 140) current = id;
      }
      setActiveSection(current);
    };
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, [phase]);

  const goHome = useCallback(() => {
    if (phase === "upload") glideTo("top");
    else backToUpload();
  }, [phase, backToUpload]);

  // In-page links glide instead of jumping.
  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const link = (e.target as Element | null)?.closest?.('a[href^="#"]');
      const id = link?.getAttribute("href")?.slice(1);
      if (!id || !GLIDE_IDS.includes(id) || !document.getElementById(id)) return;
      e.preventDefault();
      glideTo(id);
    };
    const stop = () => cancelAnimationFrame(glideFrame);
    document.addEventListener("click", onClick);
    window.addEventListener("wheel", stop, { passive: true });
    window.addEventListener("touchstart", stop, { passive: true });
    return () => {
      document.removeEventListener("click", onClick);
      window.removeEventListener("wheel", stop);
      window.removeEventListener("touchstart", stop);
      stop();
    };
  }, []);

  const dark = phase !== "upload";

  return (
    <div className={dark ? "min-h-screen bg-black" : "min-h-screen bg-white"}>
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-2 focus:z-[60] focus:rounded-full focus:bg-white focus:px-4 focus:py-2 focus:text-accent"
      >
        Skip to content
      </a>

      <header
        className={`pointer-events-none fixed inset-x-0 top-3 z-50 px-3 sm:top-4 sm:px-6 ${dark ? "on-dark" : ""}`}
      >
        <nav
          aria-label="Primary"
          className={`pointer-events-auto mx-auto flex h-16 max-w-[1100px] items-center justify-between gap-4 rounded-full pl-7 pr-3 ${
            dark ? "glass-bar-dark text-white" : "glass-bar text-ink"
          }`}
        >
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={goHome}
              aria-label={phase === "upload" ? "Ahoj, back to top" : "Ahoj, back to start"}
              className="rounded text-[28px] font-semibold tracking-[-0.03em] transition-opacity duration-200 hover:opacity-70"
            >
              Ahoj
            </button>
          </div>

          <div className="flex items-center gap-2">
            {phase === "upload" && (
              <>
                {navLinks.map((link) => {
                  const active = activeSection === link.id;
                  return (
                    <a
                      key={link.id}
                      href={`#${link.id}`}
                      aria-current={active ? "location" : undefined}
                      className={`hidden h-10 items-center rounded-full px-4 text-[15px] font-medium transition-colors duration-300 md:flex ${
                        active ? "bg-black/[0.08] text-ink" : "text-ink/65 hover:bg-black/[0.04] hover:text-ink"
                      }`}
                    >
                      {link.label}
                    </a>
                  );
                })}
                <a
                  href="#studio"
                  className="inline-flex h-10 items-center rounded-full bg-accent px-5 text-[15px] font-medium text-white transition duration-200 hover:bg-[#0077ed] active:scale-[0.97]"
                >
                  Create a video
                </a>
              </>
            )}
            {phase === "progress" && (
              <>
                <span className="mr-3 hidden text-[15px] text-white/60 sm:inline">
                  {job.error ? "Stopped" : "Creating your video"}
                </span>
                <button
                  type="button"
                  onClick={backToUpload}
                  className="inline-flex h-10 items-center rounded-full border border-white/40 px-5 text-[15px] font-medium text-white transition duration-200 hover:border-white hover:bg-white/10"
                >
                  {job.error ? "Back" : "Cancel"}
                </button>
              </>
            )}
            {phase === "result" && (
              <>
                <button
                  type="button"
                  onClick={backToUpload}
                  className="mr-3 hidden text-[15px] text-white/70 transition-colors duration-200 hover:text-white sm:inline"
                >
                  Edit settings
                </button>
                <button
                  type="button"
                  onClick={makeAnother}
                  className="inline-flex h-10 items-center rounded-full bg-white px-5 text-[15px] font-medium text-ink transition duration-200 hover:bg-[#e8e8ed] active:scale-[0.97]"
                >
                  Make another
                </button>
              </>
            )}
          </div>
        </nav>
      </header>

      <main id="main">
        {phase === "upload" && (
          <UploadStep
            brand={brand}
            onBrand={setBrand}
            referenceUrl={referenceUrl}
            onReferenceUrl={onReferenceUrl}
            styleState={styleState}
            onRetryStyle={retryStyle}
            onSkipReference={skipReference}
            length={length}
            onLength={setLength}
            shape={shape}
            onShape={setShape}
            clips={clips}
            onAddFiles={addFiles}
            onRemoveClip={removeClip}
            uploadErrors={uploadErrors}
            onDismissErrors={() => setUploadErrors([])}
            canSubmit={canSubmit}
            submitHint={submitHint}
            onSubmit={startJob}
          />
        )}
        {phase === "progress" && (
          <ProgressStep
            stage={job.stage}
            plan={job.plan}
            thumbs={jobThumbs}
            shape={shape}
            error={job.error}
            onRetry={startJob}
            onBack={backToUpload}
          />
        )}
        {phase === "result" && job.videoUrl && (
          <ResultStep
            videoUrl={job.videoUrl}
            plan={job.plan}
            shape={shape}
            brandName={brand.name.trim()}
            styleSource={styleSource}
            onAgain={makeAnother}
          />
        )}
      </main>
    </div>
  );
}
