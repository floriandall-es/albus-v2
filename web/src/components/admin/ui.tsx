"use client";
import { useEffect, type ReactNode } from "react";

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
      <div className={`w-full ${widthClass} rounded-lg bg-white shadow-lg`}>
        <div className="flex items-center justify-between border-b px-4 py-3">
          <h2 className="text-base font-semibold">{title}</h2>
          <button
            onClick={onClose}
            className="text-gray-500 hover:text-gray-800 text-lg leading-none"
            aria-label="Cerrar"
          >
            ×
          </button>
        </div>
        <div className="p-4">{children}</div>
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
export function InfoHint({
  children,
  position = "above",
}: {
  children: ReactNode;
  position?: "above" | "below";
}) {
  const popClasses =
    position === "above"
      ? "left-1/2 -translate-x-1/2 bottom-full mb-2"
      : "left-1/2 -translate-x-1/2 top-full mt-2";
  const arrowClasses =
    position === "above"
      ? "left-1/2 -translate-x-1/2 top-full -mt-1"
      : "left-1/2 -translate-x-1/2 bottom-full -mb-1";
  return (
    <span className="relative inline-flex items-center align-middle group ml-1">
      <span
        tabIndex={0}
        className="inline-flex h-4 w-4 items-center justify-center rounded-full bg-gray-200 text-gray-600 text-[10px] font-semibold cursor-help select-none group-hover:bg-brand-100 group-hover:text-brand-700 group-focus-within:bg-brand-100 group-focus-within:text-brand-700 transition-colors"
        aria-label="Más información"
      >
        ?
      </span>
      <span
        role="tooltip"
        className={
          "absolute z-50 w-64 rounded-md bg-gray-900 px-3 py-2 text-xs leading-relaxed text-white opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 pointer-events-none transition-opacity shadow-lg whitespace-normal "
          + popClasses
        }
      >
        {children}
        <span
          aria-hidden
          className={"absolute w-2 h-2 bg-gray-900 rotate-45 " + arrowClasses}
        />
      </span>
    </span>
  );
}
