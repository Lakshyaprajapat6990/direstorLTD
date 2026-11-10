"use client";

import { useEffect, useRef } from "react";

// Counts up to an already-formatted figure (e.g. "12,345") the first time it scrolls into view. The server-rendered text is
// always the exact final value, so it is what shows without JavaScript, with reduced motion, and for anything that is not a
// plain grouped integer (dates, "—", "Unavailable", percentages): those are rendered untouched. The animation only writes
// to the DOM node (no React re-renders), runs once per page view, and the final frame is the original string verbatim.
// Screen readers get the final value from a visually hidden copy and skip the changing digits.
const PLAIN_INTEGER = /^\d{1,3}(?:([^\d\s])\d{3})*$|^\d+$/;
const DURATION_MS = 1500;

function formatLike(n: number, sep: string | undefined): string {
  const digits = String(n);
  if (!sep) return digits;
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, sep);
}

export function CountUp({ value }: { value: string }) {
  const el = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    const node = el.current;
    const match = PLAIN_INTEGER.exec(value);
    if (!node || !match) return;
    const sep = match[1];
    const target = Number(value.replace(/\D/g, ""));
    if (!Number.isSafeInteger(target) || target <= 0) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    if (typeof IntersectionObserver === "undefined") return;

    let frame = 0;
    let observer: IntersectionObserver | undefined;
    node.textContent = formatLike(0, sep);

    const run = () => {
      const start = performance.now();
      const tick = (now: number) => {
        const t = Math.min((now - start) / DURATION_MS, 1);
        const eased = 1 - Math.pow(1 - t, 3);
        node.textContent = t >= 1 ? value : formatLike(Math.round(target * eased), sep);
        if (t < 1) frame = requestAnimationFrame(tick);
      };
      frame = requestAnimationFrame(tick);
    };

    observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          observer?.disconnect();
          run();
        }
      },
      { threshold: 0.4 }
    );
    observer.observe(node);

    return () => {
      observer?.disconnect();
      cancelAnimationFrame(frame);
      node.textContent = value;
    };
  }, [value]);

  return (
    <>
      <span className="sr-only">{value}</span>
      <span ref={el} aria-hidden suppressHydrationWarning>
        {value}
      </span>
    </>
  );
}
