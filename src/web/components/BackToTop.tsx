import { useEffect, useState } from "react";
import { prefersReducedMotion } from "../context";

/** Shown after scrolling down this far (px). */
const THRESHOLD = 600;

/**
 * Floating "Back to top" button at the lower right, inside the safe area. It appears only after the page has been
 * scrolled well down, scrolls smoothly unless reduced motion is requested, and moves focus to the page heading so
 * keyboard and screen-reader users land at the top too.
 */
export function BackToTop() {
  const [show, setShow] = useState(false);
  useEffect(() => {
    let raf = 0;
    const check = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => setShow(window.scrollY > THRESHOLD));
    };
    check();
    window.addEventListener("scroll", check, { passive: true });
    return () => {
      window.removeEventListener("scroll", check);
      cancelAnimationFrame(raf);
    };
  }, []);
  if (!show) return null;
  return (
    <button
      type="button"
      className="back-to-top"
      aria-label="Back to top"
      onClick={() => {
        window.scrollTo({ top: 0, behavior: prefersReducedMotion() ? "auto" : "smooth" });
        document.querySelector<HTMLElement>("main h1")?.focus({ preventScroll: true });
      }}
    >
      <span aria-hidden="true">↑</span> <span className="label">Top</span>
    </button>
  );
}
