"use client";
import Link from "next/link";
import Image from "next/image";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  ArrowRight,
  CalendarCheck2,
  Globe,
  Sparkles,
  Sun,
  Users,
} from "lucide-react";
import { api } from "@/lib/api";

/**
 * trivu.net landing page. Replaces the previous /login redirect.
 *
 * Audience: jefes de servicio at Spanish hospitals (and a smaller
 * secondary slice of IT / procurement). The copy talks like someone
 * who's sat next to one of them watching them build a rotación in
 * Excel — that's the brand voice and the trust hook.
 *
 * Conscious choices baked into this file:
 *
 *  - Bilingual via `?lang=en`. Default is Spanish. We persist the
 *    last choice in localStorage so a return visitor stays in the
 *    same language even if they hit the bare apex.
 *  - Authenticated visitors get a "Volver a la app" link in the nav
 *    instead of the auth CTAs. We don't redirect them away — they
 *    may have shared the URL on purpose or want to read the public
 *    pitch. Just remove the friction of a login link they don't
 *    need.
 *  - Hero "screenshot" is a styled CSS approximation of the
 *    planning grid (TODO: swap in a real screenshot exported from
 *    /admin/schedule once the alpha is stable). Same goes for the
 *    phone mockup in the team section.
 *  - One file. Splitting into per-section components has no payoff
 *    today (no shared state, no reuse) and would just make this
 *    harder to skim.
 *
 * Constraints respected:
 *  - No new npm dependencies.
 *  - Only the brand palette + design tokens already in use
 *    (`brand-*`, `shadow-soft`, `rounded-2xl`, the gradient body
 *    from /login).
 *  - No tracking, analytics, or external scripts.
 */

type Lang = "es" | "en";

const COPY = {
  es: {
    langLabel: "English",
    nav: {
      login: "Iniciar sesión",
      signup: "Crear cuenta",
      backToApp: "Volver a la app",
    },
    hero: {
      eyebrow: "El planificador de turnos para servicios quirúrgicos",
      title: "El cuadrante mensual, en un clic.",
      subtitle:
        "Trivu genera la planificación de tu servicio respetando guardias, rotaciones y reglas — y reparte la carga de forma justa. Tú validas; el equipo lo ve en su móvil.",
      ctaPrimary: "Crear cuenta",
      ctaSecondary: "Iniciar sesión",
      mockHeader: "Planificación · Septiembre 2026",
      mockEquilibrada: "Equilibrada",
    },
    problem: {
      title: "El cuadrante no debería robarte el fin de semana.",
      body: [
        "Cada mes, alguien de tu servicio dedica horas a Excel encajando guardias, esquivando vacaciones y discutiendo quién hace el puente. El resultado suele incluir un error que descubres el martes y un par de quejas legítimas sobre el reparto.",
        "Y cuando llega verano, todo se desmonta: vacaciones cruzadas, sustituciones de última hora, rotaciones que dejan de tener sentido. La operativa la haces tú — no la herramienta.",
      ],
    },
    features: {
      title: "Qué hace Trivu por ti",
      cards: [
        {
          icon: "sparkles" as const,
          heading: "Planificación inteligente",
          body: "Un solucionador matemático construye el mes respetando reglas estrictas (descansos, incompatibilidades, topes de frecuencia) y equilibrando el reparto entre personas. Si una restricción no se puede cumplir, te lo dice y te sugiere cómo aflojarla.",
        },
        {
          icon: "sun" as const,
          heading: "Periodos especiales",
          body: "Vacaciones, verano o Navidad como periodos con su propia configuración: actividades distintas, reglas suavizadas, rotaciones ajustadas. Trivu regenera todos los meses afectados en una sola operación.",
        },
        {
          icon: "users" as const,
          heading: "Auto-servicio del equipo",
          body: "Cada compañero ve sus turnos en el móvil, pide cobertura, acepta intercambios y solicita vacaciones. Tú apruebas lo que requiere tu atención — el resto fluye.",
        },
        {
          icon: "calendar" as const,
          heading: "Coordinación entre equipos",
          body: "Reuniones compartidas con otros servicios del hospital, directorio interno con teléfono y WhatsApp por persona, y un indicador de quién está de guardia hoy.",
        },
      ],
    },
    team: {
      title: "Para tu equipo, no solo para ti.",
      body: "La app pone los turnos en la palma de cada adjunto y residente. Cuando un compañero necesita cobertura, lo pide desde el móvil y los demás pueden aceptar — tú solo intervienes si quieres. Las vacaciones se solicitan desde el móvil y aparecen en tu panel para aprobar.",
      shiftToday: "Hoy",
      shiftTomorrow: "Mañana",
      shiftGuardia: "Guardia 22:00 – 08:00",
      shiftQuirofano: "Quirófano · Cirujano 1",
    },
    pricing: {
      title: "Cómo empezar",
      body: "Trivu está en fase alpha. El uso es gratuito mientras pulimos la herramienta junto con los servicios pioneros. Crea tu cuenta, configura tu equipo y empieza a generar cuadrantes esta misma tarde.",
      cta: "Crear cuenta",
      finePrint: "Sin tarjeta. Sin compromiso.",
    },
    footer: {
      tagline: "El planificador del jefe de servicio.",
      terms: "Condiciones",
      privacy: "Privacidad",
      contact: "Contacto",
      contactEmail: "hola@trivu.net",
    },
  },
  en: {
    langLabel: "Español",
    nav: {
      login: "Sign in",
      signup: "Create account",
      backToApp: "Back to app",
    },
    hero: {
      eyebrow: "Shift scheduling for surgical departments",
      title: "The monthly rota, in one click.",
      subtitle:
        "Trivu builds your department's rota respecting on-calls, rotations and rules — and balances the workload fairly. You approve; your team sees it on their phone.",
      ctaPrimary: "Create account",
      ctaSecondary: "Sign in",
      mockHeader: "Schedule · September 2026",
      mockEquilibrada: "Balanced",
    },
    problem: {
      title: "Building the rota shouldn't eat your weekend.",
      body: [
        "Every month, someone in your department spends hours in Excel fitting on-calls together, dodging vacations, and arguing over who covers the bank holiday. The result usually includes a mistake you spot on Tuesday and a couple of legitimate complaints about how the workload landed.",
        "When summer hits, everything falls apart: overlapping vacations, last-minute substitutions, rotations that stop making sense. The operational work is yours — the tool stays out of it.",
      ],
    },
    features: {
      title: "What Trivu does for you",
      cards: [
        {
          icon: "sparkles" as const,
          heading: "Smart planning",
          body: "A mathematical solver builds the month respecting hard rules (rest periods, incompatibilities, frequency caps) and balancing workload between people. When a constraint can't be met, it tells you why and suggests how to relax it.",
        },
        {
          icon: "sun" as const,
          heading: "Vacation periods",
          body: "Summer, Christmas, or any vacation window as a period with its own configuration: different activities, softer rules, adjusted rotations. Trivu regenerates every affected month in one operation.",
        },
        {
          icon: "users" as const,
          heading: "Team self-service",
          body: "Each colleague sees their shifts on their phone, requests coverage, accepts swaps, and books vacations. You only step in when something actually needs your attention — the rest flows.",
        },
        {
          icon: "calendar" as const,
          heading: "Cross-team coordination",
          body: "Shared meetings with other departments in your hospital, an internal directory with phone and WhatsApp per person, and a quick indicator of who's on call today.",
        },
      ],
    },
    team: {
      title: "For your team, not just for you.",
      body: "The app puts every shift in the palm of each attending and resident. When a colleague needs coverage, they request it from their phone and others can accept — you only step in when you want to. Vacations are requested from the phone and appear in your panel to approve.",
      shiftToday: "Today",
      shiftTomorrow: "Tomorrow",
      shiftGuardia: "On-call 22:00 – 08:00",
      shiftQuirofano: "OR · Surgeon 1",
    },
    pricing: {
      title: "How to get started",
      body: "Trivu is in alpha. Use is free while we polish the tool with our pioneer services. Create your account, configure your team, and start generating rotas the same afternoon.",
      cta: "Create account",
      finePrint: "No card. No commitment.",
    },
    footer: {
      tagline: "The scheduler your department deserves.",
      terms: "Terms",
      privacy: "Privacy",
      contact: "Contact",
      contactEmail: "hola@trivu.net",
    },
  },
} as const;

const LANG_STORAGE_KEY = "trivu-landing-lang";

export default function LandingPage() {
  const router = useRouter();
  const searchParams = useSearchParams();

  // Language resolution: explicit ?lang= wins; else localStorage;
  // else default to Spanish. Spelled out so the resolution order is
  // obvious six months from now.
  const urlLang = searchParams.get("lang");
  const [lang, setLang] = useState<Lang>(
    urlLang === "en" ? "en" : "es",
  );
  useEffect(() => {
    if (urlLang === "en" || urlLang === "es") {
      setLang(urlLang);
      try {
        localStorage.setItem(LANG_STORAGE_KEY, urlLang);
      } catch {
        // localStorage may throw in incognito / restricted contexts;
        // language still works in-memory.
      }
      return;
    }
    // No URL param — fall back to the persisted choice.
    try {
      const stored = localStorage.getItem(LANG_STORAGE_KEY);
      if (stored === "en" || stored === "es") setLang(stored);
    } catch {
      // ignore
    }
  }, [urlLang]);

  const toggleLang = () => {
    const next: Lang = lang === "es" ? "en" : "es";
    setLang(next);
    try {
      localStorage.setItem(LANG_STORAGE_KEY, next);
    } catch {
      // ignore
    }
    const params = new URLSearchParams(Array.from(searchParams.entries()));
    if (next === "es") {
      params.delete("lang");
    } else {
      params.set("lang", next);
    }
    const query = params.toString();
    router.replace(query ? `/?${query}` : "/");
  };

  // Auth-aware nav. The `me` query is the same one /admin and /me
  // use, so it dedupes via react-query when the visitor lands here
  // after being elsewhere in the app.
  const me = useQuery({
    queryKey: ["me"],
    queryFn: api.me,
    retry: false,
    staleTime: 60_000,
  });
  const isAuthed = !!me.data;

  const c = COPY[lang];

  return (
    <main className="min-h-screen bg-gradient-to-b from-brand-50/50 to-gray-50 text-gray-900">
      {/* Nav. Sticky so the CTAs stay reachable while the visitor
          scrolls; mostly transparent so the gradient bleeds through. */}
      <nav className="sticky top-0 z-10 backdrop-blur supports-[backdrop-filter]:bg-white/70 bg-white/90 border-b border-gray-200">
        <div className="mx-auto max-w-6xl px-4 sm:px-6 py-3 flex items-center gap-4">
          <Link
            href="/"
            className="flex items-center gap-2.5 shrink-0"
          >
            <Image
              src="/logo.jpeg"
              alt="Trivu"
              width={32}
              height={32}
              priority
              className="h-8 w-8 rounded-lg shadow-soft"
            />
            <span className="text-lg font-semibold tracking-tight">
              Trivu
            </span>
          </Link>
          <div className="flex-1" />
          <button
            type="button"
            onClick={toggleLang}
            className="inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-sm text-gray-700 hover:bg-gray-100 transition-colors"
            aria-label={`Switch language to ${c.langLabel}`}
          >
            <Globe className="h-4 w-4" />
            {c.langLabel}
          </button>
          {isAuthed ? (
            <Link
              href="/admin"
              className="inline-flex items-center gap-1.5 rounded-lg bg-brand-600 px-3.5 py-1.5 text-sm font-medium text-white hover:bg-brand-700 shadow-soft transition-colors"
            >
              {c.nav.backToApp}
              <ArrowRight className="h-3.5 w-3.5" />
            </Link>
          ) : (
            <>
              <Link
                href="/login"
                className="hidden sm:inline-flex items-center rounded-lg px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-100 transition-colors"
              >
                {c.nav.login}
              </Link>
              <Link
                href="/signup"
                className="inline-flex items-center gap-1.5 rounded-lg bg-brand-600 px-3.5 py-1.5 text-sm font-medium text-white hover:bg-brand-700 shadow-soft transition-colors"
              >
                {c.nav.signup}
                <ArrowRight className="h-3.5 w-3.5" />
              </Link>
            </>
          )}
        </div>
      </nav>

      {/* Hero */}
      <section className="mx-auto max-w-6xl px-4 sm:px-6 pt-12 sm:pt-20 pb-16 sm:pb-24">
        <div className="grid gap-12 lg:grid-cols-2 lg:items-center">
          <div>
            <p className="text-xs sm:text-sm font-semibold tracking-wide uppercase text-brand-700">
              {c.hero.eyebrow}
            </p>
            <h1 className="mt-3 text-4xl sm:text-5xl lg:text-6xl font-semibold tracking-tight text-gray-900 leading-[1.1]">
              {c.hero.title}
            </h1>
            <p className="mt-5 text-lg sm:text-xl text-gray-600 leading-relaxed">
              {c.hero.subtitle}
            </p>
            <div className="mt-8 flex flex-wrap items-center gap-3">
              <Link
                href="/signup"
                className="inline-flex items-center gap-2 rounded-xl bg-brand-600 px-5 py-3 text-base font-semibold text-white hover:bg-brand-700 shadow-soft transition-colors"
              >
                {c.hero.ctaPrimary}
                <ArrowRight className="h-4 w-4" />
              </Link>
              <Link
                href="/login"
                className="inline-flex items-center rounded-xl ring-1 ring-gray-300 bg-white px-5 py-3 text-base font-medium text-gray-800 hover:bg-gray-50 transition-colors"
              >
                {c.hero.ctaSecondary}
              </Link>
            </div>
          </div>
          {/* Hero mockup. Styled CSS approximation of the planning
              grid — swap in a real screenshot when the alpha UI is
              frozen. Pure CSS so it stays light + responsive. */}
          <HeroMockup label={c.hero.mockHeader} balancedLabel={c.hero.mockEquilibrada} />
        </div>
      </section>

      {/* Problem statement */}
      <section className="bg-white border-y border-gray-200">
        <div className="mx-auto max-w-3xl px-4 sm:px-6 py-16 sm:py-20">
          <h2 className="text-2xl sm:text-3xl font-semibold tracking-tight text-gray-900">
            {c.problem.title}
          </h2>
          <div className="mt-5 space-y-4 text-base sm:text-lg text-gray-600 leading-relaxed">
            {c.problem.body.map((p, i) => (
              <p key={i}>{p}</p>
            ))}
          </div>
        </div>
      </section>

      {/* Features grid */}
      <section className="mx-auto max-w-6xl px-4 sm:px-6 py-16 sm:py-20">
        <h2 className="text-2xl sm:text-3xl font-semibold tracking-tight text-gray-900">
          {c.features.title}
        </h2>
        <div className="mt-8 grid gap-5 sm:grid-cols-2 lg:grid-cols-2">
          {c.features.cards.map((card, i) => (
            <div
              key={i}
              className="rounded-2xl bg-white p-6 ring-1 ring-gray-200 shadow-soft"
            >
              <div className="inline-flex h-10 w-10 items-center justify-center rounded-lg bg-brand-100 text-brand-700">
                <FeatureIcon name={card.icon} />
              </div>
              <h3 className="mt-4 text-lg font-semibold text-gray-900">
                {card.heading}
              </h3>
              <p className="mt-2 text-sm sm:text-base text-gray-600 leading-relaxed">
                {card.body}
              </p>
            </div>
          ))}
        </div>
      </section>

      {/* Team section — pitch to the member side of the product */}
      <section className="bg-white border-y border-gray-200">
        <div className="mx-auto max-w-6xl px-4 sm:px-6 py-16 sm:py-20">
          <div className="grid gap-12 lg:grid-cols-2 lg:items-center">
            <div>
              <h2 className="text-2xl sm:text-3xl font-semibold tracking-tight text-gray-900">
                {c.team.title}
              </h2>
              <p className="mt-5 text-base sm:text-lg text-gray-600 leading-relaxed">
                {c.team.body}
              </p>
            </div>
            <PhoneMockup
              today={c.team.shiftToday}
              tomorrow={c.team.shiftTomorrow}
              guardia={c.team.shiftGuardia}
              quirofano={c.team.shiftQuirofano}
            />
          </div>
        </div>
      </section>

      {/* Pricing / cómo empezar */}
      <section className="mx-auto max-w-3xl px-4 sm:px-6 py-16 sm:py-20 text-center">
        <h2 className="text-2xl sm:text-3xl font-semibold tracking-tight text-gray-900">
          {c.pricing.title}
        </h2>
        <p className="mt-5 text-base sm:text-lg text-gray-600 leading-relaxed">
          {c.pricing.body}
        </p>
        <div className="mt-8 flex flex-col items-center gap-2">
          <Link
            href="/signup"
            className="inline-flex items-center gap-2 rounded-xl bg-brand-600 px-6 py-3 text-base font-semibold text-white hover:bg-brand-700 shadow-soft transition-colors"
          >
            {c.pricing.cta}
            <ArrowRight className="h-4 w-4" />
          </Link>
          <p className="text-xs text-gray-500">{c.pricing.finePrint}</p>
        </div>
      </section>

      {/* Footer */}
      <footer className="bg-white border-t border-gray-200">
        <div className="mx-auto max-w-6xl px-4 sm:px-6 py-10 flex flex-col sm:flex-row sm:items-center gap-4 sm:gap-8">
          <div className="flex items-center gap-2.5">
            <Image
              src="/logo.jpeg"
              alt="Trivu"
              width={28}
              height={28}
              className="h-7 w-7 rounded-md shadow-soft"
            />
            <div>
              <div className="text-sm font-semibold text-gray-900">Trivu</div>
              <div className="text-xs text-gray-500">{c.footer.tagline}</div>
            </div>
          </div>
          <div className="flex-1" />
          <nav className="flex flex-wrap gap-x-5 gap-y-2 text-sm text-gray-600">
            <Link href="/terms" className="hover:text-gray-900 hover:underline">
              {c.footer.terms}
            </Link>
            <Link href="/privacy" className="hover:text-gray-900 hover:underline">
              {c.footer.privacy}
            </Link>
            {/* TODO Florian: replace hola@trivu.net with the real
                contact address if different. */}
            <a
              href={`mailto:${c.footer.contactEmail}`}
              className="hover:text-gray-900 hover:underline"
            >
              {c.footer.contact}
            </a>
          </nav>
        </div>
      </footer>
    </main>
  );
}

// ---------------------------------------------------------------------------
// Mockups — pure CSS approximations of the real UI. Cheap to render
// and they hold the spot for real screenshots later. Kept inline
// because they're only used here.
// ---------------------------------------------------------------------------

function HeroMockup({
  label,
  balancedLabel,
}: {
  label: string;
  balancedLabel: string;
}) {
  // Tiny calendar-grid silhouette with a couple of coloured cells so
  // the eye reads "schedule" without needing a real screenshot. Six
  // people, twelve days — same shape as a typical /admin/schedule
  // header in the actual app.
  const people = ["CE", "ES", "FO", "JO", "MO", "SA"];
  const days = Array.from({ length: 12 }, (_, i) => i + 1);
  return (
    <div className="relative">
      <div className="rounded-2xl bg-white ring-1 ring-gray-200 shadow-soft overflow-hidden">
        <div className="flex items-center gap-3 border-b border-gray-200 bg-gray-50/60 px-4 py-3">
          <CalendarCheck2 className="h-4 w-4 text-brand-700" />
          <span className="text-sm font-medium text-gray-800">{label}</span>
          <span className="ml-auto inline-flex items-center rounded-md bg-emerald-50 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-emerald-700 ring-1 ring-emerald-200">
            {balancedLabel}
          </span>
        </div>
        <div className="p-4">
          <div className="grid grid-cols-[auto_repeat(12,minmax(0,1fr))] gap-1 text-[10px] text-gray-500">
            <div />
            {days.map((d) => (
              <div key={d} className="text-center">
                {d}
              </div>
            ))}
            {people.map((p, rowIdx) => (
              <Row
                key={p}
                initials={p}
                rowIdx={rowIdx}
                cols={days.length}
              />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function Row({
  initials,
  rowIdx,
  cols,
}: {
  initials: string;
  rowIdx: number;
  cols: number;
}) {
  // Sparse colouring — every third column gets a brand block, every
  // fourth gets a soft neutral. Just enough to suggest a planning
  // grid without pretending to be a real one.
  return (
    <>
      <div className="text-[11px] font-medium text-gray-700 pr-2 self-center">
        {initials}
      </div>
      {Array.from({ length: cols }).map((_, c) => {
        const isBrand = (c + rowIdx) % 5 === 0;
        const isAlt = (c + rowIdx) % 7 === 0;
        return (
          <div
            key={c}
            className={
              "h-5 rounded-sm "
              + (isBrand
                ? "bg-brand-500"
                : isAlt
                  ? "bg-brand-200"
                  : "bg-gray-100")
            }
          />
        );
      })}
    </>
  );
}

function PhoneMockup({
  today,
  tomorrow,
  guardia,
  quirofano,
}: {
  today: string;
  tomorrow: string;
  guardia: string;
  quirofano: string;
}) {
  // Stylised phone frame holding a two-card agenda. Same shapes the
  // real /me Inicio renders: shift card with a Guardia row above a
  // Quirófano row.
  return (
    <div className="mx-auto w-full max-w-[260px]">
      <div className="rounded-[2.5rem] bg-gray-900 p-2 shadow-soft">
        <div className="rounded-[2rem] bg-white p-3 h-[440px] flex flex-col gap-3">
          <div className="text-[10px] font-semibold uppercase tracking-wide text-gray-400">
            {today}
          </div>
          <div className="rounded-xl bg-brand-50 ring-1 ring-brand-100 p-3">
            <div className="text-xs font-medium text-brand-800">
              {guardia}
            </div>
            <div className="mt-1 h-1.5 w-12 rounded-full bg-brand-300" />
          </div>
          <div className="text-[10px] font-semibold uppercase tracking-wide text-gray-400 mt-2">
            {tomorrow}
          </div>
          <div className="rounded-xl bg-gray-50 ring-1 ring-gray-200 p-3">
            <div className="text-xs font-medium text-gray-800">
              {quirofano}
            </div>
            <div className="mt-1 h-1.5 w-16 rounded-full bg-gray-300" />
          </div>
          <div className="flex-1" />
          <div className="grid grid-cols-4 gap-1.5">
            {["calendar", "swaps", "vacations", "settings"].map((k) => (
              <div
                key={k}
                className="h-8 rounded-lg bg-gray-50 ring-1 ring-gray-200"
              />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function FeatureIcon({ name }: { name: "sparkles" | "sun" | "users" | "calendar" }) {
  switch (name) {
    case "sparkles":
      return <Sparkles className="h-5 w-5" />;
    case "sun":
      return <Sun className="h-5 w-5" />;
    case "users":
      return <Users className="h-5 w-5" />;
    case "calendar":
      return <CalendarCheck2 className="h-5 w-5" />;
  }
}
