"use client";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";

export function PageHeader({
  title,
  action,
}: {
  /** String OR JSX. Use JSX when the title needs an inline hint or
   * any non-text adornment. */
  title: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="flex items-center justify-between mb-6">
      <h1 className="text-2xl font-semibold tracking-tight text-gray-900 inline-flex items-center">
        {title}
      </h1>
      {action}
    </div>
  );
}

export function Card({ children }: { children: ReactNode }) {
  return (
    <div className="rounded-xl bg-white shadow-soft ring-1 ring-gray-200">
      {children}
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return (
    <div className="rounded-xl bg-white shadow-soft ring-1 ring-gray-200 p-8 text-center text-sm text-gray-500">
      {children}
    </div>
  );
}

// Richer empty state: icon + headline + optional sub-line + optional CTA.
// Used everywhere a list is empty to give the user a visible next step.
export function EmptyState({
  icon,
  title,
  description,
  action,
}: {
  icon?: ReactNode;
  title: string;
  description?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="rounded-xl bg-white shadow-soft ring-1 ring-gray-200 p-10 text-center">
      {icon && (
        <div className="mx-auto mb-3 inline-flex h-10 w-10 items-center justify-center rounded-full bg-brand-50 text-brand-600">
          {icon}
        </div>
      )}
      <div className="text-sm font-medium text-gray-800">{title}</div>
      {description && (
        <div className="mt-1 text-sm text-gray-500">{description}</div>
      )}
      {action && <div className="mt-4 flex justify-center">{action}</div>}
    </div>
  );
}

export function Button({
  children,
  onClick,
  type = "button",
  variant = "primary",
  disabled,
}: {
  children: ReactNode;
  onClick?: () => void;
  type?: "button" | "submit";
  variant?: "primary" | "secondary" | "danger";
  disabled?: boolean;
}) {
  const base =
    "inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-400 focus-visible:ring-offset-1 disabled:opacity-50 disabled:cursor-not-allowed";
  const styles = {
    primary: "bg-brand-600 text-white hover:bg-brand-700 shadow-soft",
    secondary:
      "ring-1 ring-gray-300 bg-white text-gray-800 hover:bg-gray-50",
    danger:
      "ring-1 ring-rose-300 text-rose-700 bg-white hover:bg-rose-50",
  }[variant];
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      className={`${base} ${styles}`}
    >
      {children}
    </button>
  );
}

// Standardised status pill — pass a `tone` and it picks the right palette.
// Avoids the ad-hoc bg-amber-100/text-amber-800 sprinkled across pages.
export function StatusPill({
  tone,
  children,
}: {
  tone: "success" | "warning" | "danger" | "info" | "neutral";
  children: ReactNode;
}) {
  const styles = {
    success: "bg-emerald-50 text-emerald-700 ring-emerald-200",
    warning: "bg-amber-50 text-amber-800 ring-amber-200",
    danger: "bg-rose-50 text-rose-700 ring-rose-200",
    info: "bg-sky-50 text-sky-700 ring-sky-200",
    neutral: "bg-gray-100 text-gray-700 ring-gray-200",
  }[tone];
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium ring-1 ${styles}`}
    >
      {children}
    </span>
  );
}

export function TextField({
  label,
  hint,
  value,
  onChange,
  type = "text",
  placeholder,
  required,
  autoComplete,
  name,
}: {
  label: string;
  /** Optional (?) badge with hover/focus tooltip rendered next to
   * the label. Pass a string or any JSX. */
  hint?: ReactNode;
  value: string;
  onChange: (v: string) => void;
  type?: string;
  placeholder?: string;
  required?: boolean;
  /** Standard HTML autocomplete token (e.g. "given-name",
   * "family-name", "new-password", "email", "off"). Set
   * explicitly on every field used in account-creation forms so
   * Chrome doesn't dump random saved values into unlabelled
   * inputs (we hit this on the invite-accept form, where empty
   * apellidos got autofilled with the operator's saved email). */
  autoComplete?: string;
  /** Optional name attribute. Mostly useful when paired with
   * autoComplete to give the browser a stable field identity. */
  name?: string;
}) {
  return (
    <label className="block">
      <span className="text-sm font-medium text-gray-700">
        {label}
        {hint && <InfoHint>{hint}</InfoHint>}
      </span>
      <input
        type={type}
        value={value}
        placeholder={placeholder}
        required={required}
        autoComplete={autoComplete}
        name={name}
        onChange={(e) => onChange(e.target.value)}
        className="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
      />
    </label>
  );
}

export function NumberField({
  label,
  value,
  onChange,
  min,
  max,
}: {
  label: string;
  value: number | "";
  onChange: (v: number | "") => void;
  min?: number;
  max?: number;
}) {
  return (
    <label className="block">
      <span className="text-sm font-medium text-gray-700">{label}</span>
      <input
        type="number"
        value={value}
        min={min}
        max={max}
        onChange={(e) => {
          const v = e.target.value;
          onChange(v === "" ? "" : Number(v));
        }}
        className="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
      />
    </label>
  );
}

export function Select<T extends string | number>({
  label,
  hint,
  value,
  onChange,
  options,
}: {
  label: string;
  /** Optional (?) badge with hover/focus tooltip rendered next to
   * the label. Pass a string or any JSX. */
  hint?: ReactNode;
  value: T | "";
  onChange: (v: T | "") => void;
  options: { value: T | ""; label: string }[];
}) {
  return (
    <label className="block">
      <span className="text-sm font-medium text-gray-700">
        {label}
        {hint && <InfoHint>{hint}</InfoHint>}
      </span>
      <select
        value={String(value)}
        onChange={(e) => {
          const v = e.target.value;
          if (v === "") onChange("");
          else onChange((typeof options[0]?.value === "number" ? Number(v) : (v as T)) as T);
        }}
        className="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 text-sm bg-white"
      >
        {options.map((o, i) => (
          <option key={i} value={String(o.value)}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}

export function Modal({
  open,
  onClose,
  title,
  children,
  size = "md",
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  /** "md" (~512px, default) for forms; "lg" (~720px) for wider content
   *  like CSV import flows. */
  size?: "md" | "lg";
}) {
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;
  const widthClass = size === "lg" ? "max-w-3xl" : "max-w-lg";
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4">
      {/* Cap the modal at viewport height (minus the backdrop's 1rem
          padding on each side) and turn the body into the scroll
          container. The header stays sticky so the title and × are
          always reachable, no matter how tall the form is. */}
      <div
        className={
          "flex max-h-[calc(100vh-2rem)] w-full flex-col rounded-lg bg-white shadow-lg "
          + widthClass
        }
      >
        <div className="flex items-center justify-between border-b px-4 py-3 shrink-0">
          <h2 className="text-base font-semibold">{title}</h2>
          <button
            onClick={onClose}
            className="text-gray-500 hover:text-gray-800 text-lg leading-none"
            aria-label="Cerrar"
          >
            ×
          </button>
        </div>
        <div className="p-4 overflow-y-auto">{children}</div>
      </div>
    </div>
  );
}

export function ErrorText({ children }: { children: ReactNode }) {
  if (!children) return null;
  return <p className="text-sm text-red-600">{children}</p>;
}

/**
 * Small "(?)" badge that reveals a plain-language explanation on
 * hover/focus. Use next to technical labels (Modo de plantilla,
 * Grupo de equidad, etc.) so a jefe de servicio reading the form
 * for the first time isn't expected to know the jargon.
 *
 * The popover is positioned ABOVE the badge by default; pass
 * `position="below"` when the field sits near the top of a modal
 * and there's no headroom for the popover.
 */
/**
 * "?" tooltip badge. Renders the popover via React portal to
 * document.body with position: fixed so it escapes any clipping
 * parent (modal with overflow:auto, scroll containers, etc.).
 * Previously the popover used CSS `position: absolute` relative
 * to the trigger, which got cut off inside the slot editor modal
 * — that's the bug this rewrite fixes.
 *
 * Position computation: read the trigger's bounding rect on open
 * (and on scroll/resize), then anchor the popover above or below.
 * If the chosen side overflows the viewport, flip to the other.
 * Horizontal centring clamps to within 8px of the viewport edges
 * so labels near the right edge don't render off-screen.
 *
 * `position` is a HINT — the actual side may flip if the
 * hint-side has no room.
 */
const TOOLTIP_WIDTH = 256; // matches w-64
const VIEWPORT_PADDING = 8;
const ARROW_OFFSET = 8;

export function InfoHint({
  children,
  position = "above",
}: {
  children: ReactNode;
  position?: "above" | "below";
}) {
  const triggerRef = useRef<HTMLSpanElement | null>(null);
  const tooltipRef = useRef<HTMLDivElement | null>(null);
  const [open, setOpen] = useState(false);
  const [coords, setCoords] = useState<{
    top: number;
    left: number;
    placement: "above" | "below";
  } | null>(null);

  const computePosition = useCallback(() => {
    const trigger = triggerRef.current;
    if (!trigger) return;
    const rect = trigger.getBoundingClientRect();
    // Measure the actual tooltip if it's already mounted (more
    // accurate for vertical flip detection); fall back to a
    // sensible estimate before first render.
    const tipHeight =
      tooltipRef.current?.offsetHeight ?? 80;

    // Centre horizontally on the trigger, then clamp to viewport.
    let left =
      rect.left + rect.width / 2 - TOOLTIP_WIDTH / 2;
    const maxLeft =
      window.innerWidth - TOOLTIP_WIDTH - VIEWPORT_PADDING;
    if (left > maxLeft) left = maxLeft;
    if (left < VIEWPORT_PADDING) left = VIEWPORT_PADDING;

    // Pick vertical side. Hint = `position` prop; flip if no room.
    let placement: "above" | "below" = position;
    const spaceAbove = rect.top;
    const spaceBelow = window.innerHeight - rect.bottom;
    if (
      placement === "above"
      && spaceAbove < tipHeight + ARROW_OFFSET + VIEWPORT_PADDING
      && spaceBelow > spaceAbove
    ) {
      placement = "below";
    } else if (
      placement === "below"
      && spaceBelow < tipHeight + ARROW_OFFSET + VIEWPORT_PADDING
      && spaceAbove > spaceBelow
    ) {
      placement = "above";
    }
    const top =
      placement === "above"
        ? rect.top - tipHeight - ARROW_OFFSET
        : rect.bottom + ARROW_OFFSET;
    setCoords({ top, left, placement });
  }, [position]);

  // Compute on open. Use useLayoutEffect so the popover renders
  // at the correct coords on the same frame as mount — otherwise
  // there's a one-frame flash at (0,0).
  useLayoutEffect(() => {
    if (!open) {
      setCoords(null);
      return;
    }
    computePosition();
  }, [open, computePosition]);

  // Re-position on scroll / resize while open. Close on Escape
  // for keyboard users.
  useEffect(() => {
    if (!open) return;
    const onAny = () => computePosition();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("scroll", onAny, true);
    window.addEventListener("resize", onAny);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("scroll", onAny, true);
      window.removeEventListener("resize", onAny);
      window.removeEventListener("keydown", onKey);
    };
  }, [open, computePosition]);

  const arrowHorizontalLeft = coords
    ? (() => {
        // Centre the arrow on the trigger's x-midpoint relative
        // to the tooltip's left edge — clamps when the tooltip
        // had to slide because of viewport clamping.
        const trigger = triggerRef.current;
        if (!trigger) return TOOLTIP_WIDTH / 2;
        const rect = trigger.getBoundingClientRect();
        const triggerCentre = rect.left + rect.width / 2;
        const tipLeft = coords.left;
        return Math.max(8, Math.min(triggerCentre - tipLeft, TOOLTIP_WIDTH - 8));
      })()
    : TOOLTIP_WIDTH / 2;

  return (
    <span className="relative inline-flex items-center align-middle ml-1">
      <span
        ref={triggerRef}
        tabIndex={0}
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        className={
          "inline-flex h-4 w-4 items-center justify-center rounded-full bg-gray-200 text-gray-600 text-[10px] font-semibold cursor-help select-none transition-colors "
          + (open ? "bg-brand-100 text-brand-700" : "")
        }
        aria-label="Más información"
      >
        ?
      </span>
      {open && typeof document !== "undefined"
        && createPortal(
          <div
            ref={tooltipRef}
            role="tooltip"
            style={{
              position: "fixed",
              top: coords?.top ?? -9999,
              left: coords?.left ?? -9999,
              width: TOOLTIP_WIDTH,
              // Only fade in once we have coords. Without this
              // the tooltip flashes at (-9999,-9999) on slow
              // first paints.
              opacity: coords ? 1 : 0,
            }}
            className="z-[1000] pointer-events-none rounded-md bg-gray-900 px-3 py-2 text-xs leading-relaxed text-white shadow-lg whitespace-normal transition-opacity"
          >
            {children}
            <span
              aria-hidden
              style={{
                position: "absolute",
                left: arrowHorizontalLeft,
                transform: "translateX(-50%) rotate(45deg)",
                top:
                  coords?.placement === "above"
                    ? "100%"
                    : undefined,
                bottom:
                  coords?.placement === "below"
                    ? "100%"
                    : undefined,
                marginTop:
                  coords?.placement === "above" ? -4 : undefined,
                marginBottom:
                  coords?.placement === "below" ? -4 : undefined,
                width: 8,
                height: 8,
              }}
              className="bg-gray-900"
            />
          </div>,
          document.body,
        )}
    </span>
  );
}
