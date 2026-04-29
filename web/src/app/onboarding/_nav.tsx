"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Button } from "@/components/admin/ui";
import { STEPS } from "./layout";

export function StepNav({
  currentSlug,
  onNext,
  nextLabel,
  nextDisabled,
}: {
  currentSlug: string;
  onNext?: () => void | Promise<void>;
  nextLabel?: string;
  nextDisabled?: boolean;
}) {
  const router = useRouter();
  const idx = STEPS.findIndex((s) => s.slug === currentSlug);
  const prev = idx > 0 ? STEPS[idx - 1] : null;
  const next = idx < STEPS.length - 1 ? STEPS[idx + 1] : null;

  return (
    <div className="mt-8 flex items-center justify-between border-t pt-4">
      <div>
        {prev && (
          <Link href={`/onboarding/${prev.slug}`} className="text-sm text-gray-600 underline">
            ← {prev.label}
          </Link>
        )}
      </div>
      <div className="flex items-center gap-3">
        {next && (
          <Link
            href={`/onboarding/${next.slug}`}
            className="text-sm text-gray-500 underline"
          >
            Saltar este paso
          </Link>
        )}
        {next && (
          <Button
            onClick={async () => {
              if (onNext) await onNext();
              router.push(`/onboarding/${next.slug}`);
            }}
            disabled={nextDisabled}
          >
            {nextLabel ?? "Siguiente"}
          </Button>
        )}
      </div>
    </div>
  );
}
