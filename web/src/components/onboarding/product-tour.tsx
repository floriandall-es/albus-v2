"use client";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";

/**
 * Guided tour rendered on every /admin visit until the admin
 * explicitly opts out. The dismissal model is intentionally
 * "loud" — Skip / X / Esc / Terminar all simply close for now;
 * only the "No volver a mostrar este tour" checkbox in the
 * footer flips the persistent flag. Rationale: a fresh admin
 * who misses or accidentally closes the tour the first time
 * around should still get a second chance, instead of having
 * the most important onboarding surface vanish silently.
 *
 * Anchors via `data-tour-id` attributes on existing UI elements
 * so the steps can move with the layout. No external library —
 * keeps the JS bundle lean and the styling consistent with the
 * rest of the app.
 *
 * Design choices:
 *
 *   - Spotlight = full-screen backdrop + a transparent "hole"
 *     around the target rect, rendered with a `clip-path`. The
 *     backdrop is click-through over the hole so the anchor stays
 *     visible (and the popover can sit on top).
 *
 *   - Popover position auto-flips when the preferred placement
 *     would push it off-screen. Recomputed on scroll + resize via
 *     a layout effect so it follows the anchor.
 *
 *   - Steps whose anchor isn't found in the DOM are SKIPPED, not
 *     errored. That's the right behaviour for the ViewSwitcher
 *     stop, which renders only for dual-role users.
 *
 *   - Skip = close-but-not-dismiss. The persistent flag only
 *     flips when the admin actively ticks the "No volver a
 *     mostrar" checkbox before closing. Without it, the tour
 *     comes back on the next /admin load.
 *
 * Persistence is the caller's job. This component just renders
 * and reports back via `onClose(dismissPermanently)`; the
 * wrapper decides whether to stamp localStorage.
 */

export type TourStep = {
  /** Value of `data-tour-id` on the target element. Pass null for
   * a centered "modal" step with no spotlight (used for the
   * Welcome stop where we don't want to highlight any single
   * element). */
  tourId: string | null;
  title: string;
  body: string;
  /** Preferred placement relative to the anchor. Auto-flipped if
   * it doesn't fit. Defaults to "bottom"; ignored when tourId is
   * null (centered). */
  placement?: "top" | "bottom" | "left" | "right";
};

const POPOVER_WIDTH = 320;
const POPOVER_OFFSET = 12; // gap between popover and anchor
const VIEWPORT_PADDING = 12; // min gap from popover to viewport edge

type AnchorRect = { top: number; left: number; width: number; height: number };

export function ProductTour({
  steps,
  onClose,
}: {
  steps: TourStep[];
  /** Called when the user finishes the last step or hits Skip /
   * close. The `dismissPermanently` flag is true ONLY when the
   * admin ticked the "No volver a mostrar" checkbox before
   * closing. The caller uses it to decide whether to stamp the
   * persistent "tour seen" flag in localStorage. */
  onClose: (dismissPermanently: boolean) => void;
}) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  // Step filter — drop any steps whose anchor is missing in the
  // current DOM (e.g. ViewSwitcher for non-dual-role admins). Done
  // once on mount because the anchored elements don't appear /
  // disappear mid-tour. Re-running on every render would be a
  // small but real perf footgun.
  const visibleSteps = useMemo(() => {
    if (!mounted) return [];
    return steps.filter((s) => {
      if (s.tourId === null) return true;
      return document.querySelector(`[data-tour-id="${s.tourId}"]`) !== null;
    });
  }, [mounted, steps]);

  const [idx, setIdx] = useState(0);
  const step = visibleSteps[idx] ?? null;

  // Live anchor rect (or null for centered steps). Recomputes on
  // scroll/resize and when the step changes.
  const [rect, setRect] = useState<AnchorRect | null>(null);
  useLayoutEffect(() => {
    if (!step || step.tourId === null) {
      setRect(null);
      return;
    }
    const compute = () => {
      const el = document.querySelector<HTMLElement>(
        `[data-tour-id="${step.tourId}"]`,
      );
      if (!el) {
        setRect(null);
        return;
      }
      const r = el.getBoundingClientRect();
      setRect({ top: r.top, left: r.left, width: r.width, height: r.height });
      // Scroll the target into view if it's clipped. `nearest`
      // does the right thing — won't yank the page if the target
      // is already comfortably visible.
      el.scrollIntoView({ behavior: "smooth", block: "nearest" });
    };
    compute();
    window.addEventListener("scroll", compute, true);
    window.addEventListener("resize", compute);
    return () => {
      window.removeEventListener("scroll", compute, true);
      window.removeEventListener("resize", compute);
    };
  }, [step]);

  // "No volver a mostrar" — when checked at close time, the
  // caller stamps localStorage. Lives in component state because
  // the choice only matters for the upcoming onClose call.
  const [dismissPermanently, setDismissPermanently] = useState(false);
  // Stable closer that always reads the latest checkbox value
  // without forcing the keydown effect to re-bind on every render.
  const dismissRef = useRef(false);
  useEffect(() => {
    dismissRef.current = dismissPermanently;
  }, [dismissPermanently]);
  const closeWithFlag = useCallback(() => {
    onClose(dismissRef.current);
  }, [onClose]);

  // Escape closes the tour. Whether it dismisses persistently
  // depends solely on the checkbox state at the moment Esc fires.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeWithFlag();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [closeWithFlag]);

  const next = useCallback(() => {
    if (idx >= visibleSteps.length - 1) {
      closeWithFlag();
    } else {
      setIdx((i) => i + 1);
    }
  }, [idx, visibleSteps.length, closeWithFlag]);
  const back = useCallback(() => setIdx((i) => Math.max(0, i - 1)), []);

  if (!mounted || !step || visibleSteps.length === 0) return null;

  const isFirst = idx === 0;
  const isLast = idx === visibleSteps.length - 1;
  const popoverPos = computePopoverPosition(rect, step.placement ?? "bottom");

  return createPortal(
    <div
      className="fixed inset-0 z-[100]"
      role="dialog"
      aria-modal="true"
      aria-label="Tour de Trivu"
    >
      {/* Spotlight backdrop. Two halves so the cutout's underlying
          pixels remain clickable in principle (we still intercept
          clicks on the backdrop itself to nudge users toward the
          buttons rather than letting an errant click skip past a
          step). When there's no rect, render a plain dim layer. */}
      <SpotlightBackdrop rect={rect} />

      {/* Popover card. Either positioned next to the anchor or
          centered in the viewport for tourId === null steps. */}
      <div
        className="absolute rounded-xl bg-white shadow-2xl ring-1 ring-black/10 p-4 text-sm"
        style={{
          width: POPOVER_WIDTH,
          top: popoverPos.top,
          left: popoverPos.left,
        }}
      >
        <button
          type="button"
          onClick={closeWithFlag}
          aria-label="Cerrar tour"
          className="absolute right-2 top-2 rounded-md p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-700"
        >
          <X className="h-4 w-4" />
        </button>
        <div className="pr-6">
          <div className="mb-1 text-[11px] font-medium uppercase tracking-wide text-brand-600">
            Paso {idx + 1} de {visibleSteps.length}
          </div>
          <div className="text-base font-semibold text-gray-900">
            {step.title}
          </div>
          <p className="mt-1.5 text-gray-600 leading-relaxed">
            {step.body}
          </p>
        </div>
        <div className="mt-4 space-y-3">
          {/* Slim progress bar instead of per-step dots: with the
              19-stop sidebar walkthrough, a dot row blew past the
              popover width and pushed Siguiente off-screen. The
              bar always fits any step count, and "Paso X de Y"
              above already communicates the discrete count.
              `aria-hidden` because the textual counter above is
              the semantic source of truth. */}
          <div
            aria-hidden
            className="h-1 rounded-full bg-gray-200 overflow-hidden"
          >
            <div
              className="h-full bg-brand-600 transition-all duration-200"
              style={{
                width: `${((idx + 1) / visibleSteps.length) * 100}%`,
              }}
            />
          </div>
          {/* Opt-in persistent dismiss. Default unchecked so an
              accidental Skip / X / Esc keeps the tour available
              on the next /admin visit. The admin has to actively
              tick this before closing to silence the tour
              permanently. Sits above the action row so the
              choice is visible whenever any close action is
              about to fire. */}
          <label className="flex items-center gap-2 text-xs text-gray-600 select-none cursor-pointer">
            <input
              type="checkbox"
              checked={dismissPermanently}
              onChange={(e) => setDismissPermanently(e.target.checked)}
              className="h-3.5 w-3.5 accent-brand-600"
            />
            No volver a mostrar este tour
          </label>
          <div className="flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={closeWithFlag}
              className="text-xs text-gray-500 hover:text-gray-700"
            >
              {dismissPermanently ? "Cerrar" : "Saltar"}
            </button>
            {!isFirst && (
              <button
                type="button"
                onClick={back}
                className="rounded-md border border-gray-300 bg-white px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50"
              >
                Atrás
              </button>
            )}
            <button
              type="button"
              onClick={next}
              className="rounded-md bg-brand-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-brand-700"
            >
              {isLast ? "Terminar" : "Siguiente"}
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}

/** Backdrop with a transparent rectangular hole over `rect`. Uses
 * the `box-shadow` outset trick so we don't need clip-path support
 * (which Safari was historically iffy about). Padding adds a few
 * pixels around the cutout so the highlight reads as a soft halo
 * instead of a tight crop. */
function SpotlightBackdrop({ rect }: { rect: AnchorRect | null }) {
  if (!rect) {
    return <div className="absolute inset-0 bg-black/50" />;
  }
  const pad = 6;
  return (
    <div
      className="absolute rounded-lg pointer-events-none"
      style={{
        top: rect.top - pad,
        left: rect.left - pad,
        width: rect.width + pad * 2,
        height: rect.height + pad * 2,
        boxShadow: "0 0 0 9999px rgba(0,0,0,0.55)",
      }}
    />
  );
}

/** Pick the popover's top/left in viewport coordinates. Centers
 * when no anchor. Otherwise lays it adjacent to the rect on the
 * preferred side, then flips to the opposite side if it would go
 * off-screen, then clamps to viewport bounds as a last resort. */
function computePopoverPosition(
  rect: AnchorRect | null,
  placement: "top" | "bottom" | "left" | "right",
): { top: number; left: number } {
  const vw = typeof window === "undefined" ? 1024 : window.innerWidth;
  const vh = typeof window === "undefined" ? 768 : window.innerHeight;
  // Approximate popover height — we don't measure it (would require
  // a second render pass). 180px covers the typical 2-line title +
  // 3-line body + buttons. Off by a bit is harmless.
  const ph = 180;

  if (!rect) {
    return {
      top: Math.max(VIEWPORT_PADDING, (vh - ph) / 2),
      left: Math.max(VIEWPORT_PADDING, (vw - POPOVER_WIDTH) / 2),
    };
  }

  const candidates: Record<
    "top" | "bottom" | "left" | "right",
    { top: number; left: number }
  > = {
    bottom: {
      top: rect.top + rect.height + POPOVER_OFFSET,
      left: rect.left + rect.width / 2 - POPOVER_WIDTH / 2,
    },
    top: {
      top: rect.top - POPOVER_OFFSET - ph,
      left: rect.left + rect.width / 2 - POPOVER_WIDTH / 2,
    },
    right: {
      top: rect.top + rect.height / 2 - ph / 2,
      left: rect.left + rect.width + POPOVER_OFFSET,
    },
    left: {
      top: rect.top + rect.height / 2 - ph / 2,
      left: rect.left - POPOVER_OFFSET - POPOVER_WIDTH,
    },
  };
  const opposite: Record<typeof placement, typeof placement> = {
    top: "bottom",
    bottom: "top",
    left: "right",
    right: "left",
  };

  const fits = (p: { top: number; left: number }) =>
    p.top >= VIEWPORT_PADDING
    && p.left >= VIEWPORT_PADDING
    && p.top + ph <= vh - VIEWPORT_PADDING
    && p.left + POPOVER_WIDTH <= vw - VIEWPORT_PADDING;

  let chosen = candidates[placement];
  if (!fits(chosen)) chosen = candidates[opposite[placement]];

  // Clamp to viewport as a defensive fallback. Better to overlap
  // the anchor a hair than to render half off-screen.
  return {
    top: Math.min(
      Math.max(VIEWPORT_PADDING, chosen.top),
      vh - ph - VIEWPORT_PADDING,
    ),
    left: Math.min(
      Math.max(VIEWPORT_PADDING, chosen.left),
      vw - POPOVER_WIDTH - VIEWPORT_PADDING,
    ),
  };
}
