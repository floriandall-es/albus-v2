"use client";
import { useEffect } from "react";
import { useRouter } from "next/navigation";

export default function OnboardingIndex() {
  const router = useRouter();
  useEffect(() => {
    // Funnel goes through the preset chooser first; that step seeds
    // the default categories so the next page already shows them
    // pre-populated.
    router.replace("/onboarding/preset");
  }, [router]);
  return null;
}
