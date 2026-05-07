"use client";
import { useEffect } from "react";
import { useRouter } from "next/navigation";

export default function MeIndex() {
  const router = useRouter();
  useEffect(() => {
    router.replace("/me/turnos");
  }, [router]);
  return null;
}
