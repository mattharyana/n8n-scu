"use client";

import { STAGES } from "@/lib/types";
import type { ClipThumb, Plan, Shape } from "@/lib/types";
import { Thumb } from "./ui";

interface Props {
  stage: number;
  plan: Plan | null;
  thumbs: Record<string, ClipThumb>;
  shape: Shape;
  error: string | null;
  onRetry: () => void;
  onBack: () => void;
}

export default function ProgressStep({ stage, plan, thumbs, shape, error, onRetry, onBack }: Props) {
  const last = STAGES.length - 1;
  const percent = Math.round((stage / last) * 100);
  const tileAspect = shape === "vertical" ? "aspect-[9/16]" : "aspect-video";
  const tileWidth = shape === "vertical" ? "w-[150px] sm:w-[176px]" : "w-[240px] sm:w-[300px]";

  return (
    <div className="on-dark min-h-[100svh] bg-black text-white">
      <section aria-labelledby="progress-title">
        <div className="wrap grid gap-12 pb-14 pt-32 sm:pt-40 lg:grid-cols-[minmax(0,1fr)_280px] lg:items-end lg:gap-20">
          <div>
            <p className="reveal text-[13px] font-semibold uppercase tracking-[0.08em] text-white/55">
              {error ? "Something went wrong" : "In progress"}
            </p>
            <h1
              id="progress-title"
              className="reveal reveal-1 mt-3 text-[46px] font-semibold leading-[0.98] tracking-[-0.045em] sm:text-[80px]"
            >
              {error ? (
                "The video could not be created"
              ) : stage >= last ? (
                "Your video is ready"
              ) : (
                <>
                  Creating
                  <br />
                  your video
                </>
              )}
            </h1>

            {error ? (
              <div className="reveal reveal-2 mt-6 max-w-[520px]" role="alert">
                <p className="text-[19px] leading-relaxed text-white/70">{error}</p>
                <div className="mt-8 flex flex-wrap items-center gap-x-8 gap-y-4">
                  <button type="button" className="btn-light" onClick={onRetry}>
                    Try again
                  </button>
                  <button
                    type="button"
                    className="inline-flex items-center gap-1 rounded text-[17px] text-[#2997ff] underline-offset-4 hover:underline"
                    onClick={onBack}
                  >
                    Back to your clips <span aria-hidden="true">›</span>
                  </button>
                </div>
              </div>
            ) : (
              <div className="reveal reveal-2 mt-6 max-w-[520px]">
                <p className="text-[21px] text-white/70 sm:text-[24px]" role="status" aria-live="polite">
                  {STAGES[stage]}
                  {stage < last ? "…" : "."}
                </p>
                <div
                  className="mt-8 h-1 overflow-hidden rounded-full bg-white/15"
                  role="progressbar"
                  aria-label="Overall progress"
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={percent}
                >
                  <div
                    className="h-full rounded-full bg-white transition-[width] duration-1000 ease-out"
                    style={{ width: `${Math.max(percent, 4)}%` }}
                  />
                </div>
                <p className="mt-3 text-[13px] text-white/45">This usually takes two to three minutes. Please keep this tab open.</p>
              </div>
            )}
          </div>

          {!error && (
            <ol className="reveal reveal-3 space-y-3.5" aria-label="Stages">
              {STAGES.map((name, i) => {
                const done = i < stage || stage >= last;
                const current = i === stage && stage < last;
                return (
                  <li key={name} aria-current={current ? "step" : undefined} className="flex items-center gap-3.5">
                    <span
                      className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full transition-colors duration-500 ${
                        done
                          ? "bg-white text-black"
                          : current
                            ? "pulse-ring-light border-2 border-white"
                            : "border-2 border-white/25"
                      }`}
                      aria-hidden="true"
                    >
                      {done && (
                        <svg viewBox="0 0 12 12" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M2.5 6.5l2.5 2.5 4.5-5.5" />
                        </svg>
                      )}
                    </span>
                    <span
                      className={`text-[17px] transition-colors duration-500 ${
                        current ? "font-semibold text-white" : done ? "text-white/70" : "text-white/35"
                      }`}
                    >
                      {name}
                      <span className="sr-only">
                        {done ? " (complete)" : current ? " (in progress)" : " (waiting)"}
                      </span>
                    </span>
                  </li>
                );
              })}
            </ol>
          )}
        </div>
      </section>

      {/* ---------- Planned shots ---------- */}
      {(!error || plan) && (
        <section className="border-t border-white/10" aria-labelledby="plan-title">
          <div className="wrap py-12 sm:py-16">
            <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1">
              <h2 id="plan-title" className="text-[28px] font-semibold tracking-[-0.025em] sm:text-[34px]">
                {plan?.title ? plan.title : "Planning the shots"}
              </h2>
              {plan && (
                <p className="text-[15px] tabular-nums text-white/55">
                  {plan.shots.length} {plan.shots.length === 1 ? "shot" : "shots"}, in order
                </p>
              )}
            </div>
            {plan?.story && (
              <p className="reveal mt-3 max-w-[60ch] text-[19px] leading-relaxed text-white/70">{plan.story}</p>
            )}

            {plan ? (
              <ol className="no-scrollbar -mx-5 mt-8 flex snap-x gap-4 overflow-x-auto px-5 pb-4 sm:-mx-8 sm:px-8">
                {plan.shots.map((shot, i) => {
                  const thumb = thumbs[shot.clipId];
                  return (
                    <li
                      key={i}
                      className={`reveal shrink-0 snap-start ${tileWidth}`}
                      style={{ animationDelay: `${Math.min(i, 8) * 70}ms` }}
                    >
                      <div className={`relative overflow-hidden rounded-[18px] bg-[#1d1d1f] ${tileAspect}`}>
                        <Thumb
                          thumbUrl={thumb?.thumbUrl}
                          thumbIsVideo={thumb?.thumbIsVideo}
                          alt={`Shot ${i + 1}, from clip ${shot.clipId}`}
                          className="absolute inset-0 h-full w-full"
                        />
                        <span className="absolute left-2.5 top-2.5 rounded-full bg-black/55 px-2.5 py-1 text-[12px] font-medium tabular-nums text-white backdrop-blur">
                          {i + 1}
                        </span>
                      </div>
                      <p
                        className="mt-3 line-clamp-2 min-h-[1.3em] text-[15px] font-semibold leading-snug tracking-[-0.01em]"
                        title={shot.caption || undefined}
                      >
                        {shot.caption}
                      </p>
                      <p className="text-[13px] tabular-nums text-white/55">
                        {typeof shot.length === "number" ? `${shot.length.toFixed(1)} s` : ""}
                      </p>
                    </li>
                  );
                })}
              </ol>
            ) : (
              <div className="mt-8 flex gap-4 overflow-hidden" aria-hidden="true">
                {Array.from({ length: 6 }, (_, i) => (
                  <div key={i} className={`shrink-0 ${tileWidth}`}>
                    <div className={`skeleton-dark rounded-[18px] ${tileAspect}`} />
                    <div className="skeleton-dark mt-3 h-4 w-3/4 rounded-full" />
                    <div className="skeleton-dark mt-2 h-3 w-1/3 rounded-full" />
                  </div>
                ))}
              </div>
            )}
          </div>
        </section>
      )}
    </div>
  );
}
