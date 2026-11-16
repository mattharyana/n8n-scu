"use client";

import { useEffect, useRef, useState } from "react";

// Stand-in footage: five free stock clips (Mixkit), cut together in the browser with captions,
// so the phone shows moving, edited video. Replace with a real Ahoj render via SAMPLE_VIDEO below.
const SLIDES = [
  { src: "/video/palms.mp4", caption: "Golden hour" },
  { src: "/video/pier.mp4", caption: "The pier" },
  { src: "/video/waves.mp4", caption: "Blue water" },
  { src: "/video/hills.mp4", caption: "Open hills" },
  { src: "/video/rocks.mp4", caption: "Wild coast" },
];

const SLIDE_MS = 3600;
const FADE_MS = 900;

// Real edited video shown in the phone. Put a vertical MP4 in public/video/ and set its path here,
// for example "/video/sample.mp4". While this is empty, the photo slideshow below plays instead.
const SAMPLE_VIDEO = "";

const shadow = "[filter:drop-shadow(0_1px_3px_rgba(0,0,0,0.6))]";
const textShadow = "[text-shadow:0_1px_6px_rgba(0,0,0,0.65)]";

function RailButton({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-0.5">
      <svg viewBox="0 0 24 24" className={`h-7 w-7 ${shadow}`} fill="currentColor">
        {children}
      </svg>
      <span className={`text-[10px] font-semibold ${textShadow}`}>{label}</span>
    </div>
  );
}

/**
 * A phone showing the finished video in a short-video feed, the way a viewer would meet it.
 * A generic feed layout with sample numbers. Decorative.
 */
export default function PhoneReel({ brandName, tagline }: { brandName: string; tagline: string }) {
  const [index, setIndex] = useState(0);
  const [videoReady, setVideoReady] = useState(false);
  const [videoFailed, setVideoFailed] = useState(false);
  const [videoProgress, setVideoProgress] = useState(0);
  const useVideo = SAMPLE_VIDEO !== "" && !videoFailed;
  const showSlides = !useVideo || !videoReady;

  const clips = useRef<(HTMLVideoElement | null)[]>([]);

  useEffect(() => {
    if (!showSlides) return;
    const id = setInterval(() => setIndex((i) => (i + 1) % SLIDES.length), SLIDE_MS);
    return () => clearInterval(id);
  }, [showSlides]);

  // Only the visible clip decodes. The outgoing one keeps playing through the dissolve, then pauses.
  useEffect(() => {
    if (!showSlides) return;
    clips.current[index]?.play().catch(() => {});
    const timer = setTimeout(() => {
      clips.current.forEach((clip, i) => {
        if (clip && i !== index) clip.pause();
      });
    }, FADE_MS + 100);
    return () => clearTimeout(timer);
  }, [index, showSlides]);

  const name = brandName || "Your business";
  const handle = name.toLowerCase().normalize("NFD").replace(/[^a-z0-9]/g, "").slice(0, 18) || "yourbusiness";
  const initial = name.trim().charAt(0).toUpperCase() || "A";

  return (
    <div
      role="img"
      aria-label="A phone showing an edited travel video playing in a short-video feed, with sample likes and comments"
      className="relative mx-auto aspect-[9/19] w-[270px] rounded-[48px] bg-[#2c2c2e] p-[10px] shadow-[0_40px_120px_rgba(255,255,255,0.1),inset_0_0_0_1.5px_rgba(255,255,255,0.18)] sm:w-[310px]"
    >
      <div
        className="relative flex h-full w-full flex-col overflow-hidden rounded-[38px] bg-black text-white"
        aria-hidden="true"
      >
        {/* ---------- The video ---------- */}
        <div className="relative min-h-0 flex-1 overflow-hidden">
          {useVideo && (
            <video
              src={SAMPLE_VIDEO}
              autoPlay
              muted
              loop
              playsInline
              tabIndex={-1}
              onLoadedData={() => setVideoReady(true)}
              onError={() => setVideoFailed(true)}
              onTimeUpdate={(e) => {
                const v = e.currentTarget;
                if (v.duration > 0) setVideoProgress(v.currentTime / v.duration);
              }}
              className={`absolute inset-0 z-[1] h-full w-full object-cover transition-opacity duration-700 ${
                videoReady ? "opacity-100" : "opacity-0"
              }`}
            />
          )}
          {showSlides && SLIDES.map((slide, i) => (
            <video
              key={slide.src}
              ref={(el) => {
                clips.current[i] = el;
              }}
              src={slide.src}
              muted
              loop
              playsInline
              preload="auto"
              tabIndex={-1}
              style={{ transitionDuration: `${FADE_MS}ms` }}
              className={`absolute inset-0 h-full w-full object-cover transition-opacity ease-in-out [transform:translateZ(0)] ${
                i === index ? "opacity-100" : "opacity-0"
              }`}
            />
          ))}
          <div className="absolute inset-0 z-[2] bg-gradient-to-t from-black/70 via-transparent to-black/40" />

          {/* Feed tabs */}
          <div className={`absolute inset-x-0 top-5 z-[3] flex items-center justify-center gap-4 text-[13px] ${textShadow}`}>
            <span className="font-medium text-white/65">Following</span>
            <span className="relative font-bold">
              For You
              <span className="absolute -bottom-1.5 left-1/2 h-[2.5px] w-6 -translate-x-1/2 rounded-full bg-white" />
            </span>
          </div>

          {/* Burned-in caption of the current shot */}
          <div className={`absolute inset-x-0 top-[38%] z-[3] px-12 text-center ${showSlides ? "" : "hidden"}`}>
            <p
              key={index}
              className="swap-in text-[24px] font-extrabold uppercase leading-none text-white [text-shadow:0_2px_14px_rgba(0,0,0,0.7)] sm:text-[27px]"
            >
              {SLIDES[index].caption}
            </p>
          </div>

          {/* Right rail */}
          <div className="absolute bottom-3 right-2.5 z-[3] flex flex-col items-center gap-3.5">
            <div className="relative mb-1.5">
              <span className="flex h-10 w-10 items-center justify-center rounded-full border-2 border-white bg-[#1d1d1f] text-[15px] font-bold">
                {initial}
              </span>
              <span className="absolute -bottom-2 left-1/2 flex h-4 w-4 -translate-x-1/2 items-center justify-center rounded-full bg-[#ff3b5c] text-[12px] font-bold leading-none">
                +
              </span>
            </div>
            <RailButton label="12.4K">
              <path d="M12 21s-7.5-4.6-9.6-9.3C.9 8.200 3 4.500 6.600 4.500c2 0 3.600 1.100 5.400 3.200 1.800-2.100 3.400-3.200 5.400-3.200 3.600 0 5.700 3.700 4.200 7.200C19.500 16.400 12 21 12 21z" />
            </RailButton>
            <RailButton label="318">
              <path d="M12 3.500c-5 0-9 3.400-9 7.700 0 2.400 1.300 4.600 3.300 6l-.8 3.300 3.700-1.900c.9.200 1.800.300 2.800.300 5 0 9-3.400 9-7.700s-4-7.700-9-7.700z" />
            </RailButton>
            <RailButton label="Share">
              <path d="M13.500 4.500 21 11.300l-7.500 6.800v-4.200c-4.600-.2-7.800 1.100-10 4.600.6-5.400 3.800-9.300 10-9.900V4.500z" />
            </RailButton>
            <span className="reel-disc mt-0.5 flex h-8 w-8 items-center justify-center rounded-full border-[5px] border-[#2c2c2e] bg-[#636366] text-[9px]">
              ♪
            </span>
          </div>

          {/* Account, caption, sound */}
          <div className={`absolute bottom-3 left-3.5 right-[58px] z-[3] text-left ${textShadow}`}>
            <p className="truncate text-[13px] font-bold">@{handle}</p>
            <p className="mt-1 line-clamp-2 text-[12px] leading-snug">
              {tagline || "One week, six stops, zero regrets."}{" "}
              <span className="font-semibold">#california #roadtrip</span>
            </p>
            <p className="mt-1.5 flex items-center gap-1.5 text-[11px]">
              <span>♪</span>
              <span className="truncate">Original sound · {name}</span>
            </p>
          </div>
        </div>

        {/* Playback progress */}
        <div className="h-[2px] w-full bg-white/20">
          <div
            className={`h-full bg-white ease-linear ${showSlides ? "transition-[width] duration-[3600ms]" : ""}`}
            style={{ width: `${(showSlides ? (index + 1) / SLIDES.length : videoProgress) * 100}%` }}
          />
        </div>

        {/* Tab bar */}
        <div className="flex h-[52px] shrink-0 items-start justify-between bg-black px-4 pt-2 text-[9px] font-medium text-white/60">
          <span className="flex w-10 flex-col items-center gap-0.5 text-white">
            <svg viewBox="0 0 24 24" className="h-5 w-5" fill="currentColor">
              <path d="M12 3.200 3 10.700V21h6.200v-6h5.600v6H21V10.700L12 3.200z" />
            </svg>
            Home
          </span>
          <span className="flex w-10 flex-col items-center gap-0.5">
            <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <circle cx="11" cy="11" r="6.500" />
              <path d="m16 16 4.500 4.500" />
            </svg>
            Discover
          </span>
          <span className="mt-0.5 flex h-7 w-11 items-center justify-center rounded-[9px] bg-white text-[20px] font-medium leading-none text-black">
            +
          </span>
          <span className="flex w-10 flex-col items-center gap-0.5">
            <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round">
              <path d="M4 5.500h16v10.500H9.500L5.500 19.500V16H4V5.500z" />
            </svg>
            Inbox
          </span>
          <span className="flex w-10 flex-col items-center gap-0.5">
            <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <circle cx="12" cy="8.500" r="3.700" />
              <path d="M4.500 20c1.200-3.700 4-5.500 7.500-5.500s6.300 1.800 7.500 5.500" />
            </svg>
            Profile
          </span>
        </div>
      </div>
    </div>
  );
}
