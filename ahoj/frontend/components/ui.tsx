"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { StyleProfile } from "@/lib/types";

const useIsoLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

/** Adds "is-in" the first time the element scrolls into view. Pair with the "rise" class. */
export function useInView<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [inView, setInView] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (typeof IntersectionObserver === "undefined") {
      setInView(true);
      return;
    }
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setInView(true);
          observer.disconnect();
        }
      },
      { threshold: 0.12, rootMargin: "0px 0px -6% 0px" },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return { ref, inView };
}

/** Block that fades and rises into place when it scrolls into view. */
export function Rise({
  children,
  className = "",
  delay = 0,
}: {
  children: React.ReactNode;
  className?: string;
  delay?: number;
}) {
  const { ref, inView } = useInView<HTMLDivElement>();
  return (
    <div
      ref={ref}
      className={`rise ${inView ? "is-in" : ""} ${className}`}
      style={delay ? { transitionDelay: `${delay}ms` } : undefined}
    >
      {children}
    </div>
  );
}

/**
 * Segmented control with a glass thumb that slides between options.
 * Built on real radio inputs, so arrow keys and screen readers work.
 */
export function Segmented<T extends string | number>({
  legend,
  name,
  options,
  value,
  onChange,
  hideLegend = false,
}: {
  legend: string;
  name: string;
  options: { value: T; label: string }[];
  value: T;
  onChange: (value: T) => void;
  hideLegend?: boolean;
}) {
  const labels = useRef<(HTMLLabelElement | null)[]>([]);
  const [thumb, setThumb] = useState<{ left: number; width: number } | null>(null);
  const [ready, setReady] = useState(false);
  const index = options.findIndex((o) => o.value === value);

  useIsoLayoutEffect(() => {
    const measure = () => {
      const el = labels.current[index];
      if (el) setThumb({ left: el.offsetLeft, width: el.offsetWidth });
    };
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [index, options.length]);

  // Enable the slide only after the first measurement, so it does not animate in from the corner.
  useEffect(() => {
    const id = requestAnimationFrame(() => setReady(true));
    return () => cancelAnimationFrame(id);
  }, []);

  return (
    <fieldset className="min-w-0">
      <legend className={hideLegend ? "sr-only" : "field-label"}>{legend}</legend>
      <div className="glass-track relative inline-flex max-w-full rounded-full p-1">
        {thumb && (
          <span
            aria-hidden="true"
            className={`glass-thumb absolute bottom-1 left-0 top-1 rounded-full ${ready ? "glass-thumb-slide" : ""}`}
            style={{ width: thumb.width, transform: `translateX(${thumb.left}px)` }}
          />
        )}
        {options.map((option, i) => (
          <label
            key={String(option.value)}
            ref={(el) => {
              labels.current[i] = el;
            }}
            className="relative z-10 cursor-pointer"
          >
            <input
              type="radio"
              name={name}
              value={String(option.value)}
              checked={option.value === value}
              onChange={() => onChange(option.value)}
              className="peer sr-only"
            />
            <span className="block whitespace-nowrap rounded-full px-5 py-2.5 text-[15px] font-medium text-ink/60 transition-colors duration-300 peer-checked:text-ink peer-focus-visible:ring-2 peer-focus-visible:ring-accent peer-focus-visible:ring-offset-2 hover:text-ink sm:px-6">
              {option.label}
            </span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

/** Clip thumbnail. A Cloudinary .jpg in real mode, a local video frame in mock mode. */
export function Thumb({
  thumbUrl,
  thumbIsVideo,
  alt,
  className = "",
}: {
  thumbUrl?: string;
  thumbIsVideo?: boolean;
  alt: string;
  className?: string;
}) {
  const [failed, setFailed] = useState(false);
  const [loaded, setLoaded] = useState(false);
  if (!thumbUrl || failed) {
    return <div role="img" aria-label={alt} className={`bg-[#e8e8ed] ${className}`} />;
  }
  const fade = `object-cover transition-opacity duration-700 ease-out ${loaded ? "opacity-100" : "opacity-0"}`;
  if (thumbIsVideo) {
    return (
      <video
        src={`${thumbUrl}#t=1`}
        muted
        playsInline
        preload="metadata"
        tabIndex={-1}
        aria-label={alt}
        onLoadedData={() => setLoaded(true)}
        onError={() => setFailed(true)}
        className={`${fade} ${className}`}
      />
    );
  }
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={thumbUrl}
      alt={alt}
      ref={(el) => {
        if (el?.complete && el.naturalWidth > 0) setLoaded(true);
      }}
      onLoad={() => setLoaded(true)}
      onError={() => setFailed(true)}
      className={`${fade} ${className}`}
    />
  );
}

/** Photo that fades in once decoded, so it never pops into place. */
export function FadeImage({ src, alt, className = "" }: { src: string; alt: string; className?: string }) {
  const [loaded, setLoaded] = useState(false);
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={src}
      alt={alt}
      decoding="async"
      ref={(el) => {
        if (el?.complete && el.naturalWidth > 0) setLoaded(true);
      }}
      onLoad={() => setLoaded(true)}
      className={`transition-opacity duration-1000 ease-out ${loaded ? "opacity-100" : "opacity-0"} ${className}`}
    />
  );
}

export function Spinner({ className = "" }: { className?: string }) {
  return (
    <svg className={`h-5 w-5 animate-spin ${className}`} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity="0.2" strokeWidth="2.5" />
      <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
    </svg>
  );
}

function show(value: unknown): string {
  if (value === null || value === undefined || value === "") return "Not specified";
  return String(value);
}

/** Readable summary of a style profile. Display only; the object itself is never modified. */
export function StyleSummary({ style }: { style: StyleProfile }) {
  const rows: [string, string][] = [
    ["Average shot", typeof style.avgShotLength === "number" ? `${style.avgShotLength} s` : show(style.avgShotLength)],
    ["Cuts", show(style.cutStyle)],
    ["Captions", show(style.captionStyle)],
    ["Colour", show(style.colorMood)],
    ["Music", show(style.musicMood)],
    ["Structure", show(style.structure)],
  ];
  if (style.musicGenre) rows.push(["Genre", show(style.musicGenre)]);
  if (style.bpm) rows.push(["Tempo", `${show(style.bpm)} bpm`]);
  return (
    <div>
      <p className="text-[21px] font-semibold leading-snug tracking-[-0.015em] text-ink sm:text-[24px]">
        {show(style.summary)}
      </p>
      <dl className="mt-5 grid grid-cols-2 gap-x-6 gap-y-4 sm:grid-cols-3">
        {rows.map(([term, detail]) => (
          <div key={term}>
            <dt className="text-[12px] font-semibold uppercase tracking-[0.06em] text-mute">{term}</dt>
            <dd className="mt-1 text-[15px] leading-snug text-ink">{detail}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
