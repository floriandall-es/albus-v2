"use client";
import Link from "next/link";
import Image from "next/image";
import { useRouter, useSearchParams } from "next/navigation";
import { Fragment, useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  ArrowDown,
  ArrowRight,
  ArrowLeftRight,
  Bell,
  CalendarCheck2,
  CalendarRange,
  ChevronDown,
  ChevronRight,
  FileSpreadsheet,
  Globe,
  Hospital,
  MessageCircle,
  PhoneCall,
  Plus,
  Scale,
  Shield,
  Sparkles,
  Sun,
  Users,
  Wand2,
  X,
} from "lucide-react";
import { api } from "@/lib/api";

/**
 * trivu.net landing page. Replaces the previous /login redirect.
 *
 * Audience: jefes de servicio at Spanish hospitals first, team
 * members second (they decide via the toggle in the audience
 * section). The copy is written from the perspective of someone
 * who's sat next to a jefe building a rotación in Excel — that's
 * the brand voice and the trust hook.
 *
 * Conscious choices baked into this file:
 *
 *  - Bilingual via `?lang=en`. Default is Spanish. Persisted in
 *    localStorage so return visitors stay in the same language.
 *  - Authenticated visitors get a "Volver a la app" link in the nav
 *    instead of the auth CTAs. We don't redirect them away — they
 *    might be showing the URL to a colleague.
 *  - Mockups are pure CSS approximations of the real UI, kept
 *    inline. Swapping to real screenshots is a later pass; the
 *    CSS versions are lighter and stay in sync with the design
 *    tokens (brand colors, shadow-soft, rounded-2xl) automatically.
 *  - One file. Sections are small + linear; splitting into per-
 *    section components would add structure without payoff. The
 *    mockups + FAQ rows ARE extracted as helpers because they're
 *    self-contained and visually dense.
 *
 * Constraints respected:
 *  - No new npm dependencies.
 *  - Only the brand palette + design tokens already in use.
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
      features: "Cómo funciona",
      forWhom: "Para quién",
      pricing: "Precios",
      faq: "Preguntas",
    },
    hero: {
      title: "La planificación del mes,",
      titleAccent: "hecha.",
      subtitle:
        "Trivu construye la planificación de tu servicio respetando guardias, rotaciones, vacaciones y reglas — y la reparte de forma justa. El jefe valida; el equipo lo ve en su móvil.",
      ctaPrimary: "Empezar gratis",
      ctaSecondary: "Ver cómo funciona",
      mockHeader: "Planificación · Junio",
      mockBalanced: "Equilibrada",
      mockPublished: "Publicada",
    },
    beforeAfter: {
      title: "Antes de Trivu, después de Trivu.",
      subtitle:
        "El mismo servicio, la misma semana. Lo que cambia es quién hace el trabajo.",
      before: {
        badge: "Sin Trivu",
        sublabel: "Excel + WhatsApp",
        points: [
          { kind: "bad", text: "Sábado por la tarde rehaciendo la planificación" },
          { kind: "bad", text: "Tres conflictos de guardia que nadie vio" },
          { kind: "bad", text: "Vacaciones cruzadas descubiertas en agosto" },
          {
            kind: "bad",
            text: "Cada cambio se cierra entre llamadas y WhatsApps",
          },
          { kind: "bad", text: "Sin vista clara de quién hace qué turno cuándo" },
        ],
      },
      after: {
        badge: "Con Trivu",
        sublabel: "Trivu",
        points: [
          { kind: "good", text: "Planificación generada en menos de un minuto" },
          {
            kind: "good",
            text: "Conflictos detectados antes de publicar",
          },
          { kind: "good", text: "Reparto equilibrado entre todos" },
          { kind: "good", text: "Cambios y coberturas fluyen entre el equipo" },
          { kind: "good", text: "Todos los turnos del equipo, en el móvil" },
        ],
      },
    },
    howItWorks: {
      title: "Cómo funciona",
      subtitle:
        "De Excel a turno publicado en una tarde. Lo difícil ya está hecho.",
      steps: [
        {
          eyebrow: "Paso 1",
          title: "Se configura el equipo",
          body:
            "Personas, actividades y las reglas que de verdad importan en el servicio. Un solo lugar, una sola vez. A partir de ahí, cada nuevo mes parte de la misma base.",
        },
        {
          eyebrow: "Paso 2",
          title: "Se genera la planificación",
          body:
            "Un clic. Trivu construye el mes respetando todas las reglas y equilibrando el reparto. Si una restricción no encaja, lo dice y propone aflojarla.",
        },
        {
          eyebrow: "Paso 3",
          title: "Se publica al equipo",
          body:
            "Al publicar, cada miembro recibe un correo y ve sus turnos en la app — con avisos antes de cada guardia y exportables al calendario del móvil.",
        },
        {
          eyebrow: "Paso 4",
          title: "Lo demás fluye solo",
          body:
            "Coberturas, intercambios y vacaciones los gestiona el equipo entre sí. Cuando hace falta una aprobación, es un toque. El resto, sin intervención.",
        },
      ],
    },
    audience: {
      title: "Una herramienta, dos vistas.",
      subtitle:
        "Una para quien planifica. Otra para quien recibe los turnos. Las dos pensadas con el mismo cuidado.",
      tabs: {
        jefe: "Para el jefe de servicio",
        equipo: "Para el equipo",
      },
      jefe: {
        heading: "Planifica sin perder el viernes por la tarde.",
        bullets: [
          {
            heading: "La planificación en un clic",
            body: "Genera el mes respetando todas tus reglas. Lo regeneras tantas veces como quieras.",
          },
          {
            heading: "Reparto justo, demostrable",
            body: "Estadísticas por persona, mes y actividad. Cuando alguien pregunte, tienes datos.",
          },
          {
            heading: "Vacaciones sin migrañas",
            body: "Periodos especiales con su propia configuración: rotaciones distintas en verano, reglas suavizadas en Navidad.",
          },
          {
            heading: "Sin sustos en publicación",
            body: "Antes de publicar te avisa de huecos, conflictos y descansos. Si publicas, sabes lo que publicas.",
          },
        ],
        ctaLabel: "Empezar como jefe",
      },
      equipo: {
        heading: "Tus turnos, en la palma de tu mano.",
        bullets: [
          {
            heading: "Tus turnos en el móvil",
            body: "Calendario propio + del equipo, con avisos antes de cada guardia. También exportable a tu Google / Apple Calendar.",
          },
          {
            heading: "Cambios sin pasar por el jefe",
            body: "Pide cobertura a tus compañeros, acepta intercambios, todo desde el móvil. Tu jefe solo entra si hace falta.",
          },
          {
            heading: "Vacaciones y bloqueos",
            body: "Solicita días libres, formación o baja desde la app. El jefe ve la solicitud y aprueba con un toque.",
          },
          {
            heading: "Directorio del hospital",
            body: "Teléfono, WhatsApp y email de cada compañero del servicio. Saber quién está de guardia hoy, también.",
          },
        ],
        ctaLabel: "Pídeselo a tu jefe",
      },
    },
    features: {
      title: "Las funciones que te van a enganchar",
      subtitle:
        "Cada una resuelve un dolor concreto. Todas vienen de horas escuchando a jefes de servicio.",
      cards: [
        {
          icon: "wand" as const,
          tone: "brand" as const,
          heading: "Planificación inteligente",
          body: "Construye el mes en menos de un minuto respetando todas tus reglas — descansos, vacaciones, rotaciones, incompatibilidades — y repartiendo la carga de forma justa entre el equipo. Si algo no encaja, te dice qué pasa y propone cómo arreglarlo.",
          chip: "1 clic",
        },
        {
          icon: "sun" as const,
          tone: "amber" as const,
          heading: "Periodos especiales",
          body: "Verano, Navidad, Semana Santa: cada periodo con su propia plantilla de actividades, reglas y rotaciones. Regenera todos los meses afectados en una sola operación, sin pisar los meses que ya funcionaban.",
          chip: "Verano '26",
        },
        {
          icon: "swap" as const,
          tone: "sky" as const,
          heading: "Cambios entre compañeros",
          body: "Una persona pide cobertura, otra la acepta. El cambio se aplica a la planificación, los dos calendarios se actualizan, y queda registrado quién cubrió a quién — todo sin que el jefe tenga que firmar nada.",
          chip: "Auto-aprobado",
        },
        {
          icon: "calendarOff" as const,
          tone: "emerald" as const,
          heading: "Bloqueos y ausencias",
          body: "Vacaciones, baja médica, formación, asuntos propios — todo en un mismo modelo. El planificador los respeta automáticamente, y el equipo ve quién está fuera cada día sin tener que preguntar.",
          chip: "Solicitar →",
        },
        {
          icon: "directory" as const,
          tone: "violet" as const,
          heading: "Directorio + WhatsApp",
          body: "Cada miembro del hospital — no solo del servicio — con teléfono, WhatsApp y email. Favoritos, indicador de guardia hoy, cargos visibles. Adiós al grupo de WhatsApp para encontrar a quien sea.",
          chip: "Hospital",
        },
        {
          icon: "meeting" as const,
          tone: "rose" as const,
          heading: "Reuniones del servicio",
          body: "Comités, sesiones, casos clínicos: reuniones recurrentes o puntuales, con invitados de otros equipos del mismo servicio. Aparecen en la planificación y en el calendario de cada invitado.",
          chip: "Cross-equipo",
        },
      ],
    },
    why: {
      title: "Por qué confiar en Trivu",
      subtitle:
        "No es un Excel con macros bonitas. Es una herramienta seria, hecha desde dentro.",
      columns: [
        {
          icon: "hospital" as const,
          heading: "Pensado para servicios quirúrgicos",
          body: "Guardias, rotaciones, equipos por día, vacaciones cruzadas, sub-equipos de residentes. Las reglas reales de un servicio quirúrgico — no un calendario genérico al que le pones nombres encima.",
        },
        {
          icon: "sparkles" as const,
          heading: "Reparto matemáticamente justo",
          body: "La planificación no se genera por azar. Trivu respeta tus reglas y reparte la carga de forma óptima entre las personas del equipo.",
        },
        {
          icon: "shield" as const,
          heading: "Tus datos, tuyos",
          body: "Cada equipo en su propio espacio aislado — nadie ve datos de otro. Conexiones cifradas, RGPD, sin rastreadores ni publicidad de terceros.",
        },
      ],
    },
    pricing: {
      title: "Precios sencillos.",
      subtitle:
        "Primer mes gratis. Después, una tarifa clara por persona — sin contratos anuales.",
      trial: "30 días gratis · Sin tarjeta hasta probarlo",
      plans: [
        {
          name: "Admin",
          price: "29,90 €",
          cadence: "/mes",
          tagline: "Quien crea y mantiene la planificación",
          features: [
            "Generación de planificaciones ilimitada",
            "Periodos especiales (verano, Navidad…)",
            "Estadísticas y reparto justo",
            "Aprobar vacaciones, cambios e incidencias",
            "Soporte por email",
          ],
          cta: "Empezar como admin",
        },
        {
          name: "Miembro",
          price: "4,90 €",
          cadence: "/mes",
          tagline: "Quien recibe sus turnos en el móvil",
          features: [
            "Tus turnos en el móvil, con avisos",
            "Cambios e intercambios con compañeros",
            "Solicitar vacaciones, bajas, formación",
            "Directorio del hospital + WhatsApp",
            "Exportar a Google y Apple Calendar",
          ],
          cta: "Pídeselo a tu jefe",
        },
      ],
      finePrint: "Sin contrato anual. Cancela cuando quieras.",
    },
    faq: {
      title: "Preguntas frecuentes",
      items: [
        {
          q: "¿Funciona con las reglas particulares de mi servicio?",
          a: "Sí. Rotaciones, días fijos, descansos obligatorios, incompatibilidades, vacaciones cruzadas, equipos por día y muchas más. Si tu servicio tiene una regla que no encaja, nos la cuentas y la añadimos.",
        },
        {
          q: "¿Cuánto cuesta?",
          a: "Los primeros 30 días son gratis. Después, 29,90 € al mes para quien crea la planificación y 4,90 € al mes por cada miembro del equipo. Sin contrato anual ni permanencia: cancelas cuando quieras.",
        },
        {
          q: "¿Cuánto tarda configurarlo?",
          a: "Un servicio típico se configura en una tarde. Un asistente te guía paso a paso por el equipo, las actividades y las reglas. Si quieres, te ayudamos a importar tu planificación actual.",
        },
        {
          q: "¿Mis datos están seguros?",
          a: "Cada equipo tiene su propio espacio aislado — nadie ve datos de otro equipo. Conexiones cifradas, contraseñas encriptadas y cumplimiento RGPD. Sin rastreadores, sin publicidad, sin terceros.",
        },
        {
          q: "¿Y si tengo varios equipos en el mismo servicio?",
          a: "Cada equipo lleva su planificación de forma independiente, pero pueden coordinarse: reuniones compartidas, directorio común y, si quieren, visibilidad mutua de las planificaciones publicadas.",
        },
        {
          q: "¿Y si tengo residentes u otro subequipo aparte?",
          a: "Soportado. Los residentes (u otro subequipo) son un equipo independiente con su propia planificación, pero coordinan reuniones y vacaciones con el equipo principal.",
        },
      ],
    },
    finalCta: {
      title: "Tu próxima planificación.",
      subtitle:
        "Sin Excel, sin domingos por la noche. Crea la cuenta y configura tu equipo en una tarde.",
      ctaPrimary: "Empezar gratis 30 días",
      ctaSecondary: "hola@trivu.net",
      finePrint: "Sin tarjeta hasta probarlo · Cancela cuando quieras",
    },
    footer: {
      tagline: "La planificación de tu equipo, en una sola herramienta.",
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
      features: "How it works",
      forWhom: "Who it's for",
      pricing: "Pricing",
      faq: "FAQ",
    },
    hero: {
      title: "The monthly rota,",
      titleAccent: "done.",
      subtitle:
        "Trivu builds your department's schedule respecting on-calls, rotations, vacations and rules — and distributes the load fairly. The chief approves; the team sees it on their phone.",
      ctaPrimary: "Start free",
      ctaSecondary: "See how it works",
      mockHeader: "Schedule · June",
      mockBalanced: "Balanced",
      mockPublished: "Published",
    },
    beforeAfter: {
      title: "Before Trivu, after Trivu.",
      subtitle:
        "Same department, same week. What changes is who does the work.",
      before: {
        badge: "Without Trivu",
        sublabel: "Excel + WhatsApp",
        points: [
          { kind: "bad", text: "Saturday afternoon rebuilding the rota" },
          { kind: "bad", text: "Three on-call conflicts nobody spotted" },
          { kind: "bad", text: "Overlapping vacations discovered in August" },
          { kind: "bad", text: "Every swap ends in calls and WhatsApps" },
          { kind: "bad", text: "No clear view of who's on what shift, when" },
        ],
      },
      after: {
        badge: "With Trivu",
        sublabel: "Trivu",
        points: [
          { kind: "good", text: "Rota generated in under a minute" },
          { kind: "good", text: "Conflicts caught before publishing" },
          { kind: "good", text: "Workload balanced across the team" },
          {
            kind: "good",
            text: "Swaps and coverage flow between colleagues",
          },
          { kind: "good", text: "Every team shift, visible on the phone" },
        ],
      },
    },
    howItWorks: {
      title: "How it works",
      subtitle:
        "From Excel to published rota in one afternoon. The hard part's already done.",
      steps: [
        {
          eyebrow: "Step 1",
          title: "The team is set up",
          body:
            "People, activities, and the rules that actually matter in the department. One place, one time. From then on every new month starts from the same baseline.",
        },
        {
          eyebrow: "Step 2",
          title: "The rota is generated",
          body:
            "One click. Trivu builds the month respecting every rule and balancing the load. If a constraint can't be met, it explains why and suggests how to relax it.",
        },
        {
          eyebrow: "Step 3",
          title: "It's published to the team",
          body:
            "Once published, each member receives an email and sees their shifts in the app — with reminders before each on-call and exports to their phone calendar.",
        },
        {
          eyebrow: "Step 4",
          title: "The rest flows on its own",
          body:
            "Coverage, swaps and vacations the team handles among themselves. When an approval is needed, it's one tap. The rest, hands-off.",
        },
      ],
    },
    audience: {
      title: "One tool, two views.",
      subtitle:
        "One for whoever plans. One for whoever receives the shifts. Both built with the same care.",
      tabs: {
        jefe: "For department chiefs",
        equipo: "For team members",
      },
      jefe: {
        heading: "Plan the month without losing your Friday afternoon.",
        bullets: [
          {
            heading: "Rota in one click",
            body: "Generate the month respecting every rule. Regenerate as many times as you like.",
          },
          {
            heading: "Fair distribution, provable",
            body: "Per-person, per-month, per-activity stats. When someone asks, you have data.",
          },
          {
            heading: "Vacations without migraines",
            body: "Special periods with their own config: different rotations in summer, softer rules at Christmas.",
          },
          {
            heading: "No surprises at publish time",
            body: "Before publishing it warns of gaps, conflicts, missed rests. If you publish, you know what you publish.",
          },
        ],
        ctaLabel: "Start as chief",
      },
      equipo: {
        heading: "Your shifts, in the palm of your hand.",
        bullets: [
          {
            heading: "Your shifts on your phone",
            body: "Personal + team calendar, with reminders before each on-call. Exportable to Google / Apple Calendar.",
          },
          {
            heading: "Swaps without going through your chief",
            body: "Request coverage from colleagues, accept swaps, all from your phone. Your chief only steps in if needed.",
          },
          {
            heading: "Vacations and blocks",
            body: "Request days off, training, sick leave from the app. The chief sees the request and approves with a tap.",
          },
          {
            heading: "Hospital directory",
            body: "Phone, WhatsApp and email for every department colleague. Plus a 'who's on call' indicator.",
          },
        ],
        ctaLabel: "Send to your chief",
      },
    },
    features: {
      title: "Features that will hook you",
      subtitle:
        "Each one solves a real pain. All come from hours listening to department chiefs.",
      cards: [
        {
          icon: "wand" as const,
          tone: "brand" as const,
          heading: "Smart planning",
          body: "Builds the month in under a minute respecting all your rules — rest, vacations, rotations, incompatibilities — and distributing the load fairly across the team. If something doesn't fit, it tells you what's wrong and how to fix it.",
          chip: "1 click",
        },
        {
          icon: "sun" as const,
          tone: "amber" as const,
          heading: "Vacation periods",
          body: "Summer, Christmas, Easter: each period with its own activity template, rules and rotations. Regenerate every affected month in one operation, without touching the months that already worked.",
          chip: "Summer '26",
        },
        {
          icon: "swap" as const,
          tone: "sky" as const,
          heading: "Colleague swaps",
          body: "One person requests coverage, another accepts. The swap applies to the rota, both calendars update, and the audit trail records who covered whom — all without your signature.",
          chip: "Auto-approved",
        },
        {
          icon: "calendarOff" as const,
          tone: "emerald" as const,
          heading: "Blocks and absences",
          body: "Vacations, sick leave, training, personal — all in one model. The planner respects them automatically, and the team sees who's out each day without having to ask.",
          chip: "Request →",
        },
        {
          icon: "directory" as const,
          tone: "violet" as const,
          heading: "Directory + WhatsApp",
          body: "Every hospital member — not just your department — with phone, WhatsApp and email. Favorites, 'on call today' indicator, visible job titles. Goodbye to the WhatsApp group hunt.",
          chip: "Hospital",
        },
        {
          icon: "meeting" as const,
          tone: "rose" as const,
          heading: "Department meetings",
          body: "Committees, sessions, clinical case reviews: recurring or one-off, with guests from other teams in the same department. They show up on the planning grid and on every invitee's calendar.",
          chip: "Cross-team",
        },
      ],
    },
    why: {
      title: "Why trust Trivu",
      subtitle:
        "Not an Excel with fancy macros. A serious tool, built from the inside.",
      columns: [
        {
          icon: "hospital" as const,
          heading: "Built for surgical services",
          body: "On-calls, rotations, team-per-day, overlapping vacations, resident subteams. The actual rules a surgical service runs on — not a generic calendar with names slapped on top.",
        },
        {
          icon: "sparkles" as const,
          heading: "Mathematically fair distribution",
          body: "The rota isn't built by chance. Trivu respects your rules and balances the load optimally across the people in your team.",
        },
        {
          icon: "shield" as const,
          heading: "Your data, yours",
          body: "Each team in its own isolated space — nobody sees data from another. Encrypted connections, GDPR-compliant, no trackers, no third-party ads.",
        },
      ],
    },
    pricing: {
      title: "Simple pricing.",
      subtitle:
        "First month free. Then a clear per-person fee — no annual contracts.",
      trial: "30 days free · No card until you try it",
      plans: [
        {
          name: "Admin",
          price: "€29.90",
          cadence: "/mo",
          tagline: "Whoever creates and maintains the rota",
          features: [
            "Unlimited rota generation",
            "Special periods (summer, Christmas…)",
            "Stats + fair-distribution tools",
            "Approve vacations, swaps and incidents",
            "Email support",
          ],
          cta: "Start as admin",
        },
        {
          name: "Member",
          price: "€4.90",
          cadence: "/mo",
          tagline: "Whoever receives their shifts on their phone",
          features: [
            "Your shifts on your phone, with reminders",
            "Swaps and coverage with colleagues",
            "Request vacations, sick leave, training",
            "Hospital directory + WhatsApp",
            "Export to Google and Apple Calendar",
          ],
          cta: "Ask your chief for access",
        },
      ],
      finePrint: "No annual contract. Cancel anytime.",
    },
    faq: {
      title: "Frequently asked",
      items: [
        {
          q: "Does it work with my department's specific rules?",
          a: "Yes. Rotations, fixed days, mandatory rest, incompatibilities, overlapping vacations, team-per-day requirements and many more. If your department runs on a rule that doesn't fit, tell us and we'll add it.",
        },
        {
          q: "How much does it cost?",
          a: "The first 30 days are free. Then €29.90 per month for the person who creates the rota, and €4.90 per month for each team member. No annual contract or lock-in — cancel anytime.",
        },
        {
          q: "How long does setup take?",
          a: "A typical department sets up in one afternoon. A guided wizard walks you through team, activities and rules. If you want, we can help import your current rota.",
        },
        {
          q: "Is my data secure?",
          a: "Each team has its own isolated space — nobody sees data from another team. Encrypted connections, encrypted passwords, GDPR-compliant. No trackers, no ads, no third parties.",
        },
        {
          q: "What if I have several teams in the same department?",
          a: "Each team runs its planning independently, but they can coordinate: shared meetings, common directory and — if they want — mutual visibility of published rotas.",
        },
        {
          q: "What about residents or another subteam?",
          a: "Supported. Residents (or any other subteam) are an independent team with their own planning, but they coordinate meetings and vacations with the main team.",
        },
      ],
    },
    finalCta: {
      title: "Your next rota.",
      subtitle:
        "No Excel, no Sunday evenings. Create your account and configure your team in one afternoon.",
      ctaPrimary: "Start free for 30 days",
      ctaSecondary: "hola@trivu.net",
      finePrint: "No card until you try it · Cancel anytime",
    },
    footer: {
      tagline: "Your team's planning, in a single tool.",
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
  // else default to Spanish.
  const urlLang = searchParams.get("lang");
  const [lang, setLang] = useState<Lang>(urlLang === "en" ? "en" : "es");
  useEffect(() => {
    if (urlLang === "en" || urlLang === "es") {
      setLang(urlLang);
      try {
        localStorage.setItem(LANG_STORAGE_KEY, urlLang);
      } catch {
        // localStorage may throw in incognito; we still have in-memory.
      }
      return;
    }
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
    if (next === "es") params.delete("lang");
    else params.set("lang", next);
    const query = params.toString();
    router.replace(query ? `/?${query}` : "/");
  };

  // Auth-aware nav.
  const me = useQuery({
    queryKey: ["me"],
    queryFn: api.me,
    retry: false,
    staleTime: 60_000,
  });
  const isAuthed = !!me.data;

  const c = COPY[lang];

  // Audience tab + FAQ open state. Both stateful so the page feels
  // alive — switching the tab swaps the visual on the right, and
  // opening a FAQ row tells the visitor "this is interactive too".
  const [audienceTab, setAudienceTab] = useState<"jefe" | "equipo">("jefe");
  const [openFaq, setOpenFaq] = useState<number | null>(0);

  return (
    <main className="min-h-screen overflow-x-hidden bg-gradient-to-b from-brand-50/40 via-white to-gray-50 text-gray-900">
      {/* -----------------------------------------------------------
          Nav
          ----------------------------------------------------------- */}
      <nav className="sticky top-0 z-30 backdrop-blur supports-[backdrop-filter]:bg-white/70 bg-white/90 border-b border-gray-200">
        <div className="mx-auto max-w-6xl px-4 sm:px-6 py-3 flex items-center gap-3 sm:gap-5">
          <Link href="/" className="flex items-center gap-2.5 shrink-0">
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
          <div className="hidden md:flex items-center gap-1 ml-4">
            <a
              href="#how"
              className="rounded-md px-2.5 py-1.5 text-sm text-gray-700 hover:bg-gray-100"
            >
              {c.nav.features}
            </a>
            <a
              href="#for-whom"
              className="rounded-md px-2.5 py-1.5 text-sm text-gray-700 hover:bg-gray-100"
            >
              {c.nav.forWhom}
            </a>
            <a
              href="#pricing"
              className="rounded-md px-2.5 py-1.5 text-sm text-gray-700 hover:bg-gray-100"
            >
              {c.nav.pricing}
            </a>
            <a
              href="#faq"
              className="rounded-md px-2.5 py-1.5 text-sm text-gray-700 hover:bg-gray-100"
            >
              {c.nav.faq}
            </a>
          </div>
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

      {/* -----------------------------------------------------------
          Hero — large title, pilot badge, dual CTAs, KPI strip, rich
          mockup of the planning grid on the right.
          ----------------------------------------------------------- */}
      <section className="relative overflow-hidden">
        {/* Soft brand-tinted blob behind the hero to add depth. */}
        <div
          className="pointer-events-none absolute -top-32 -right-32 h-[480px] w-[480px] rounded-full bg-brand-200/30 blur-3xl"
          aria-hidden
        />
        <div
          className="pointer-events-none absolute -bottom-40 -left-40 h-[360px] w-[360px] rounded-full bg-brand-100/40 blur-3xl"
          aria-hidden
        />
        <div className="relative mx-auto max-w-6xl px-4 sm:px-6 pt-8 sm:pt-20 pb-12 sm:pb-16">
          <div className="grid gap-8 sm:gap-12 lg:grid-cols-[1.05fr_1fr] lg:items-center">
            <div className="min-w-0">
              <h1 className="text-[1.75rem] sm:text-5xl lg:text-6xl font-semibold tracking-tight text-gray-900 leading-[1.15] sm:leading-[1.05] break-words">
                {/* On mobile the two halves stack on their own
                    lines so the title can't overflow the viewport;
                    on sm and up they flow inline next to each
                    other with the gradient accent. */}
                <span className="block sm:inline">{c.hero.title}</span>{" "}
                <span className="block sm:inline bg-gradient-to-r from-brand-700 to-brand-500 bg-clip-text text-transparent">
                  {c.hero.titleAccent}
                </span>
              </h1>
              <p className="mt-4 sm:mt-5 text-base sm:text-xl text-gray-600 leading-relaxed max-w-xl">
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
                <a
                  href="#how"
                  className="inline-flex items-center gap-1.5 rounded-xl ring-1 ring-gray-300 bg-white px-5 py-3 text-base font-medium text-gray-800 hover:bg-gray-50 transition-colors"
                >
                  {c.hero.ctaSecondary}
                  <ArrowDown className="h-4 w-4" />
                </a>
              </div>
            </div>
            <HeroMockup
              label={c.hero.mockHeader}
              balancedLabel={c.hero.mockBalanced}
              publishedLabel={c.hero.mockPublished}
            />
          </div>
        </div>
      </section>

      {/* -----------------------------------------------------------
          Before / After comparison
          ----------------------------------------------------------- */}
      <section className="bg-white border-y border-gray-200">
        <div className="mx-auto max-w-6xl px-4 sm:px-6 py-16 sm:py-20">
          <div className="text-center max-w-2xl mx-auto">
            <h2 className="text-2xl sm:text-4xl font-semibold tracking-tight text-gray-900">
              {c.beforeAfter.title}
            </h2>
            <p className="mt-4 text-base sm:text-lg text-gray-600 leading-relaxed">
              {c.beforeAfter.subtitle}
            </p>
          </div>
          <div className="mt-10 grid gap-5 md:grid-cols-2 md:items-stretch">
            <BeforeAfterCard
              tone="bad"
              badge={c.beforeAfter.before.badge}
              sublabel={c.beforeAfter.before.sublabel}
              points={c.beforeAfter.before.points}
            />
            <BeforeAfterCard
              tone="good"
              badge={c.beforeAfter.after.badge}
              sublabel={c.beforeAfter.after.sublabel}
              points={c.beforeAfter.after.points}
            />
          </div>
        </div>
      </section>

      {/* -----------------------------------------------------------
          How it works — four-step timeline
          ----------------------------------------------------------- */}
      <section id="how" className="mx-auto max-w-6xl px-4 sm:px-6 py-16 sm:py-24">
        <div className="text-center max-w-2xl mx-auto">
          <h2 className="text-2xl sm:text-4xl font-semibold tracking-tight text-gray-900">
            {c.howItWorks.title}
          </h2>
          <p className="mt-4 text-base sm:text-lg text-gray-600 leading-relaxed">
            {c.howItWorks.subtitle}
          </p>
        </div>
        <ol className="mt-12 grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
          {c.howItWorks.steps.map((step, i) => (
            <li
              key={step.title}
              className="relative rounded-2xl bg-white p-6 ring-1 ring-gray-200 shadow-soft"
            >
              <div className="absolute -top-3 left-6 inline-flex items-center gap-1.5 rounded-full bg-brand-600 px-3 py-1 text-[10px] font-semibold uppercase tracking-wider text-white shadow-soft">
                {step.eyebrow}
              </div>
              <div className="mt-3 text-3xl font-semibold text-brand-700">
                {String(i + 1).padStart(2, "0")}
              </div>
              <h3 className="mt-3 text-lg font-semibold text-gray-900">
                {step.title}
              </h3>
              <p className="mt-2 text-sm text-gray-600 leading-relaxed">
                {step.body}
              </p>
            </li>
          ))}
        </ol>
      </section>

      {/* -----------------------------------------------------------
          Audience tabs — jefe vs equipo
          ----------------------------------------------------------- */}
      <section
        id="for-whom"
        className="bg-gradient-to-b from-gray-50 to-white border-y border-gray-200"
      >
        <div className="mx-auto max-w-6xl px-4 sm:px-6 py-16 sm:py-24">
          <div className="text-center max-w-2xl mx-auto">
            <h2 className="text-2xl sm:text-4xl font-semibold tracking-tight text-gray-900">
              {c.audience.title}
            </h2>
            <p className="mt-4 text-base sm:text-lg text-gray-600 leading-relaxed">
              {c.audience.subtitle}
            </p>
            <div className="mt-7 inline-flex rounded-xl bg-white p-1 ring-1 ring-gray-200 shadow-soft">
              <button
                type="button"
                onClick={() => setAudienceTab("jefe")}
                className={
                  "rounded-lg px-4 py-2 text-sm font-semibold transition-colors "
                  + (audienceTab === "jefe"
                    ? "bg-brand-600 text-white shadow-soft"
                    : "text-gray-700 hover:bg-gray-50")
                }
              >
                {c.audience.tabs.jefe}
              </button>
              <button
                type="button"
                onClick={() => setAudienceTab("equipo")}
                className={
                  "rounded-lg px-4 py-2 text-sm font-semibold transition-colors "
                  + (audienceTab === "equipo"
                    ? "bg-brand-600 text-white shadow-soft"
                    : "text-gray-700 hover:bg-gray-50")
                }
              >
                {c.audience.tabs.equipo}
              </button>
            </div>
          </div>

          <div className="mt-12 grid gap-10 lg:grid-cols-[1fr_1.1fr] lg:items-center">
            <div>
              <h3 className="text-xl sm:text-2xl font-semibold text-gray-900">
                {audienceTab === "jefe"
                  ? c.audience.jefe.heading
                  : c.audience.equipo.heading}
              </h3>
              <ul className="mt-6 space-y-4">
                {(audienceTab === "jefe"
                  ? c.audience.jefe.bullets
                  : c.audience.equipo.bullets
                ).map((b) => (
                  <li key={b.heading} className="flex items-start gap-3">
                    <span className="mt-0.5 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-brand-100 text-brand-700">
                      <ChevronRight className="h-3.5 w-3.5" />
                    </span>
                    <div>
                      <div className="text-sm font-semibold text-gray-900">
                        {b.heading}
                      </div>
                      <div className="mt-0.5 text-sm text-gray-600 leading-relaxed">
                        {b.body}
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
              <div className="mt-7">
                <Link
                  href="/signup"
                  className="inline-flex items-center gap-2 rounded-xl bg-brand-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-brand-700 shadow-soft transition-colors"
                >
                  {audienceTab === "jefe"
                    ? c.audience.jefe.ctaLabel
                    : c.audience.equipo.ctaLabel}
                  <ArrowRight className="h-4 w-4" />
                </Link>
              </div>
            </div>
            <div>
              {audienceTab === "jefe" ? (
                <AdminMockup />
              ) : (
                <PhoneMockup lang={lang} />
              )}
            </div>
          </div>
        </div>
      </section>

      {/* -----------------------------------------------------------
          Feature deep-dive cards
          ----------------------------------------------------------- */}
      <section className="mx-auto max-w-6xl px-4 sm:px-6 py-16 sm:py-24">
        <div className="text-center max-w-2xl mx-auto">
          <h2 className="text-2xl sm:text-4xl font-semibold tracking-tight text-gray-900">
            {c.features.title}
          </h2>
          <p className="mt-4 text-base sm:text-lg text-gray-600 leading-relaxed">
            {c.features.subtitle}
          </p>
        </div>
        <div className="mt-12 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
          {c.features.cards.map((card) => (
            <FeatureCard key={card.heading} card={card} />
          ))}
        </div>
      </section>

      {/* -----------------------------------------------------------
          Why Trivu — credibility strip
          ----------------------------------------------------------- */}
      <section className="bg-gray-900 text-white">
        <div className="mx-auto max-w-6xl px-4 sm:px-6 py-16 sm:py-20">
          <div className="text-center max-w-2xl mx-auto">
            <h2 className="text-2xl sm:text-4xl font-semibold tracking-tight">
              {c.why.title}
            </h2>
            <p className="mt-4 text-base sm:text-lg text-gray-300 leading-relaxed">
              {c.why.subtitle}
            </p>
          </div>
          <div className="mt-12 grid gap-6 md:grid-cols-3">
            {c.why.columns.map((col) => (
              <div
                key={col.heading}
                className="rounded-2xl bg-gray-800/60 backdrop-blur p-6 ring-1 ring-white/10"
              >
                <div className="inline-flex h-10 w-10 items-center justify-center rounded-lg bg-brand-500/20 text-brand-200">
                  <WhyIcon name={col.icon} />
                </div>
                <h3 className="mt-4 text-lg font-semibold">{col.heading}</h3>
                <p className="mt-2 text-sm text-gray-300 leading-relaxed">
                  {col.body}
                </p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* -----------------------------------------------------------
          Pricing — two role-tiered plans + a 30-day free trial chip
          ----------------------------------------------------------- */}
      <section
        id="pricing"
        className="bg-white border-y border-gray-200"
      >
        <div className="mx-auto max-w-5xl px-4 sm:px-6 py-16 sm:py-24">
          <div className="text-center max-w-2xl mx-auto">
            <h2 className="text-2xl sm:text-4xl font-semibold tracking-tight text-gray-900">
              {c.pricing.title}
            </h2>
            <p className="mt-4 text-base sm:text-lg text-gray-600 leading-relaxed">
              {c.pricing.subtitle}
            </p>
            <div className="mt-6 inline-flex items-center gap-1.5 rounded-full bg-emerald-50 px-3 py-1.5 ring-1 ring-emerald-200">
              <Sparkles className="h-3.5 w-3.5 text-emerald-700" />
              <span className="text-xs font-semibold text-emerald-800">
                {c.pricing.trial}
              </span>
            </div>
          </div>
          <div className="mt-12 grid gap-6 md:grid-cols-2 md:items-stretch">
            {c.pricing.plans.map((plan, idx) => (
              <PricingCard
                key={plan.name}
                plan={plan}
                primary={idx === 0}
              />
            ))}
          </div>
          <p className="mt-6 text-center text-xs text-gray-500">
            {c.pricing.finePrint}
          </p>
        </div>
      </section>

      {/* -----------------------------------------------------------
          FAQ
          ----------------------------------------------------------- */}
      <section
        id="faq"
        className="mx-auto max-w-3xl px-4 sm:px-6 py-16 sm:py-24"
      >
        <h2 className="text-2xl sm:text-4xl font-semibold tracking-tight text-gray-900 text-center">
          {c.faq.title}
        </h2>
        <div className="mt-10 divide-y divide-gray-200 rounded-2xl bg-white ring-1 ring-gray-200 shadow-soft overflow-hidden">
          {c.faq.items.map((item, i) => (
            <FaqRow
              key={i}
              q={item.q}
              a={item.a}
              isOpen={openFaq === i}
              onToggle={() => setOpenFaq(openFaq === i ? null : i)}
            />
          ))}
        </div>
      </section>

      {/* -----------------------------------------------------------
          Final CTA
          ----------------------------------------------------------- */}
      <section className="bg-gradient-to-br from-brand-600 to-brand-700 text-white">
        <div className="mx-auto max-w-4xl px-4 sm:px-6 py-16 sm:py-20 text-center">
          <h2 className="text-2xl sm:text-4xl font-semibold tracking-tight">
            {c.finalCta.title}
          </h2>
          <p className="mt-4 text-base sm:text-lg text-brand-50 leading-relaxed">
            {c.finalCta.subtitle}
          </p>
          <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
            <Link
              href="/signup"
              className="inline-flex items-center gap-2 rounded-xl bg-white px-5 py-3 text-base font-semibold text-brand-700 hover:bg-brand-50 transition-colors shadow-soft"
            >
              {c.finalCta.ctaPrimary}
              <ArrowRight className="h-4 w-4" />
            </Link>
            <a
              href={`mailto:${c.finalCta.ctaSecondary}`}
              className="inline-flex items-center gap-1.5 rounded-xl ring-1 ring-white/40 px-5 py-3 text-base font-medium text-white hover:bg-white/10 transition-colors"
            >
              <MessageCircle className="h-4 w-4" />
              {c.finalCta.ctaSecondary}
            </a>
          </div>
          <p className="mt-5 text-xs text-brand-100">{c.finalCta.finePrint}</p>
        </div>
      </section>

      {/* -----------------------------------------------------------
          Footer
          ----------------------------------------------------------- */}
      <footer className="bg-gray-50 border-t border-gray-200">
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

// ===========================================================================
// Mockups — pure-CSS approximations of the real Trivu UI. They use the same
// design tokens (brand-*, shadow-soft, rounded-*) the app uses, so they stay
// visually in sync if the design language evolves. None of them are pixel-
// perfect; they're abstract enough to read "schedule" without pretending to
// be a screenshot.
// ===========================================================================

/** The planning-grid hero mockup. Six slot rows × ~10 visible day
 * columns. Slot names + initials hard-coded to read as a real
 * surgical-department rota. */
function HeroMockup({
  label,
  balancedLabel,
  publishedLabel,
}: {
  label: string;
  balancedLabel: string;
  publishedLabel: string;
}) {
  type Cell =
    | { kind: "off" }
    | { kind: "person"; initials: string; mine?: boolean }
    | { kind: "gap" };

  // Initials palette — deliberately abstract two-letter codes (AB,
  // CD, …). Anything that read as plausible Spanish-surname starts
  // (CE / FO / MO …) risked being misread as "people from my team"
  // when shown to a real department.
  const P = {
    CE: "AB",
    ES: "CD",
    FO: "EF",
    JD: "GH",
    MO: "IJ",
    SA: "KL",
  } as const;

  // Hand-built schedule that "looks like" a real planificación: today
  // is column 4 (highlighted), some rotation patterns, a couple of
  // uncovered cells in rose.
  const rows: { slot: string; color: string; cells: Cell[] }[] = [
    {
      slot: "Guardia",
      color: "#22c55e",
      cells: [
        { kind: "person", initials: P.CE },
        { kind: "person", initials: P.CE },
        { kind: "person", initials: P.SA, mine: true },
        { kind: "person", initials: P.FO },
        { kind: "person", initials: P.MO },
        { kind: "person", initials: P.JD },
        { kind: "person", initials: P.ES },
        { kind: "person", initials: P.CE },
        { kind: "person", initials: P.SA, mine: true },
        { kind: "person", initials: P.FO },
      ],
    },
    {
      slot: "Consulta",
      color: "#3b82f6",
      cells: [
        { kind: "off" },
        { kind: "off" },
        { kind: "person", initials: P.FO },
        { kind: "person", initials: P.SA, mine: true },
        { kind: "person", initials: P.MO },
        { kind: "person", initials: P.CE },
        { kind: "person", initials: P.ES },
        { kind: "off" },
        { kind: "off" },
        { kind: "person", initials: P.FO },
      ],
    },
    {
      slot: "Quirófano",
      color: "#a855f7",
      cells: [
        { kind: "off" },
        { kind: "off" },
        { kind: "person", initials: P.ES },
        { kind: "person", initials: P.CE },
        { kind: "person", initials: P.JD },
        { kind: "person", initials: P.MO },
        { kind: "off" },
        { kind: "off" },
        { kind: "off" },
        { kind: "person", initials: P.SA, mine: true },
      ],
    },
    {
      slot: "Planta",
      color: "#f59e0b",
      cells: [
        { kind: "off" },
        { kind: "off" },
        { kind: "person", initials: P.MO },
        { kind: "person", initials: P.JD },
        { kind: "person", initials: P.FO },
        { kind: "person", initials: P.ES },
        { kind: "person", initials: P.CE },
        { kind: "off" },
        { kind: "off" },
        { kind: "person", initials: P.JD },
      ],
    },
    {
      slot: "Trasplante",
      color: "#ec4899",
      cells: [
        { kind: "person", initials: P.SA, mine: true },
        { kind: "person", initials: P.SA, mine: true },
        { kind: "person", initials: P.MO },
        { kind: "person", initials: P.SA, mine: true },
        { kind: "person", initials: P.JD },
        { kind: "person", initials: P.CE },
        { kind: "person", initials: P.ES },
        { kind: "person", initials: P.SA, mine: true },
        { kind: "person", initials: P.MO },
        { kind: "person", initials: P.FO },
      ],
    },
    {
      slot: "Neumólogo",
      color: "#10b981",
      cells: [
        { kind: "person", initials: P.ES },
        { kind: "person", initials: P.ES },
        { kind: "person", initials: P.JD },
        { kind: "person", initials: P.MO },
        { kind: "person", initials: P.FO },
        { kind: "person", initials: P.CE },
        { kind: "person", initials: P.SA, mine: true },
        { kind: "person", initials: P.ES },
        { kind: "person", initials: P.ES },
        { kind: "person", initials: P.JD },
      ],
    },
  ];

  // Day strip: numbers 26..05 with the 29 (= today) highlighted in
  // brand. 30/31 are weekends → slate; the rest neutral. The
  // weekday short ("LUN", "MAR"…) reads as the real planning grid.
  const days = [
    { n: 26, wd: "vie" },
    { n: 27, wd: "sáb", weekend: true },
    { n: 28, wd: "dom", weekend: true },
    { n: 29, wd: "lun", today: true },
    { n: 30, wd: "mar" },
    { n: 1, wd: "mié" },
    { n: 2, wd: "jue" },
    { n: 3, wd: "vie" },
    { n: 4, wd: "sáb", weekend: true },
    { n: 5, wd: "dom", weekend: true },
  ];

  return (
    <div className="relative">
      {/* Floating "Generar" badge — sells the magic in one glance. */}
      <div className="absolute -top-4 -left-4 z-10 hidden sm:flex items-center gap-1.5 rounded-full bg-white px-3 py-1.5 shadow-soft ring-1 ring-brand-200">
        <Sparkles className="h-3.5 w-3.5 text-brand-600" />
        <span className="text-xs font-semibold text-brand-800">
          Generar en 1 clic
        </span>
      </div>
      <div className="rounded-2xl bg-white ring-1 ring-gray-200 shadow-soft overflow-hidden">
        {/* Card header */}
        <div className="flex flex-wrap items-center gap-2 border-b border-gray-200 bg-gray-50/60 px-4 py-3">
          <CalendarCheck2 className="h-4 w-4 text-brand-700" />
          <span className="text-sm font-medium text-gray-800">{label}</span>
          <span className="inline-flex items-center gap-1 rounded-md bg-emerald-50 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-emerald-700 ring-1 ring-emerald-200">
            <Scale className="h-3 w-3" />
            {balancedLabel}
          </span>
          <span className="ml-auto inline-flex items-center gap-1 rounded-md bg-brand-50 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-brand-700 ring-1 ring-brand-200">
            {publishedLabel}
          </span>
        </div>
        {/* Mini-grid */}
        <div className="overflow-x-auto">
          <table className="text-[10px] border-separate border-spacing-0 min-w-full">
            <thead className="bg-gray-50">
              <tr>
                <th className="sticky left-0 z-10 bg-gray-50 px-2 py-1.5 text-left text-[9px] font-semibold uppercase tracking-wide text-gray-500 border-b border-r border-gray-200 whitespace-nowrap">
                  Turno
                </th>
                {days.map((d) => (
                  <th
                    key={d.n + d.wd}
                    className={
                      "px-1 py-1.5 text-center min-w-[40px] border-b "
                      + (d.today
                        ? "bg-brand-50 border-brand-200 "
                        : d.weekend
                          ? "bg-slate-100 border-gray-200 "
                          : "border-gray-200 ")
                    }
                  >
                    <div
                      className={
                        "text-xs font-semibold "
                        + (d.today
                          ? "text-brand-700"
                          : d.weekend
                            ? "text-gray-500"
                            : "text-gray-900")
                      }
                    >
                      {String(d.n).padStart(2, "0")}
                    </div>
                    <div
                      className={
                        "font-medium text-[9px] uppercase tracking-wide "
                        + (d.today
                          ? "text-brand-600"
                          : d.weekend
                            ? "text-gray-400"
                            : "text-gray-500")
                      }
                    >
                      {d.wd}
                    </div>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, rowIdx) => (
                <tr key={row.slot} className={rowIdx % 2 === 1 ? "bg-gray-50/40" : ""}>
                  <td
                    className={
                      "sticky left-0 z-[1] px-2 py-1.5 border-r border-b border-gray-100 whitespace-nowrap font-medium text-gray-800 "
                      + (rowIdx % 2 === 1 ? "bg-gray-50/90" : "bg-white")
                    }
                  >
                    <span className="flex items-center gap-1.5">
                      <span
                        className="h-1.5 w-1.5 rounded-full shrink-0"
                        style={{ backgroundColor: row.color }}
                      />
                      {row.slot}
                    </span>
                  </td>
                  {row.cells.map((cell, idx) => {
                    const d = days[idx];
                    const cellTint = d.today
                      ? "bg-brand-50/30"
                      : d.weekend
                        ? "bg-slate-100"
                        : "";
                    if (cell.kind === "off") {
                      return (
                        <td
                          key={idx}
                          className={`align-top px-1 py-1.5 border-b border-gray-100 text-center text-gray-300 ${cellTint}`}
                        >
                          —
                        </td>
                      );
                    }
                    if (cell.kind === "gap") {
                      return (
                        <td
                          key={idx}
                          className={`align-top px-1 py-1.5 border-b border-gray-100 bg-rose-50/70`}
                        >
                          <span className="text-rose-700 font-semibold text-[9px]">
                            Sin cubrir
                          </span>
                        </td>
                      );
                    }
                    return (
                      <td
                        key={idx}
                        className={`align-top px-1 py-1.5 border-b border-gray-100 ${
                          cell.mine ? "bg-brand-50/70" : cellTint
                        }`}
                      >
                        <span className="inline-flex items-center gap-1">
                          <MiniAvatar initials={cell.initials} mine={cell.mine} />
                          <span
                            className={
                              cell.mine
                                ? "font-semibold text-brand-700"
                                : "text-gray-800"
                            }
                          >
                            {cell.initials}
                          </span>
                        </span>
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      {/* Float a small KPI card beneath the grid to add depth. */}
      <div className="absolute -bottom-5 right-4 sm:right-8 hidden sm:flex items-center gap-2 rounded-xl bg-white px-3 py-2 shadow-soft ring-1 ring-gray-200">
        <div className="inline-flex h-7 w-7 items-center justify-center rounded-md bg-emerald-50 text-emerald-700">
          <Scale className="h-3.5 w-3.5" />
        </div>
        <div>
          <div className="text-[10px] uppercase tracking-wide text-gray-500">
            Guardias / persona
          </div>
          <div className="text-xs font-semibold text-gray-900">3.3 ± 0.4</div>
        </div>
      </div>
    </div>
  );
}

/** Small colored-initials avatar — mirrors the real Avatar
 * component but with hard-coded palettes per initials so the same
 * letters always read as the same person. */
function MiniAvatar({ initials, mine }: { initials: string; mine?: boolean }) {
  const palette: Record<string, { bg: string; fg: string }> = {
    AB: { bg: "#fef3c7", fg: "#92400e" }, // amber
    CD: { bg: "#dbeafe", fg: "#1e40af" }, // blue
    EF: { bg: "#dcfce7", fg: "#166534" }, // green
    GH: { bg: "#fce7f3", fg: "#9d174d" }, // pink
    IJ: { bg: "#e0e7ff", fg: "#3730a3" }, // indigo
    KL: { bg: "#ccfbf1", fg: "#115e59" }, // teal
  };
  const p = palette[initials] ?? { bg: "#e5e7eb", fg: "#374151" };
  return (
    <span
      className={
        "inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full text-[7px] font-semibold "
        + (mine ? "ring-1 ring-brand-500 ring-offset-1" : "")
      }
      style={{ backgroundColor: p.bg, color: p.fg }}
      aria-hidden
    >
      {initials.slice(0, 2)}
    </span>
  );
}

/** Phone mockup for the team/equipo audience tab — a stylised
 * /me/turnos Lista with two shift cards. */
function PhoneMockup({ lang }: { lang: Lang }) {
  const t = lang === "es"
    ? {
        today: "Hoy",
        tomorrow: "Mañana",
        coverage: "Pedir cobertura",
        guardia: "Guardia",
        guardiaTime: "22:00 – 08:00",
        quirofano: "Quirófano",
        quirofanoTime: "08:00 – 14:00",
        you: "Tú",
        balance: "Mes equilibrado",
      }
    : {
        today: "Today",
        tomorrow: "Tomorrow",
        coverage: "Request coverage",
        guardia: "On-call",
        guardiaTime: "22:00 – 08:00",
        quirofano: "OR",
        quirofanoTime: "08:00 – 14:00",
        you: "You",
        balance: "Balanced month",
      };
  return (
    <div className="relative mx-auto w-full max-w-[300px]">
      {/* Floating notification chip */}
      <div className="absolute -top-4 -left-6 z-10 hidden sm:flex items-center gap-1.5 rounded-full bg-white px-3 py-1.5 shadow-soft ring-1 ring-gray-200">
        <Bell className="h-3.5 w-3.5 text-brand-600" />
        <span className="text-[10px] font-medium text-gray-800">
          {lang === "es"
            ? "Guardia en 2 h — Trivu"
            : "On-call in 2 h — Trivu"}
        </span>
      </div>
      <div className="rounded-[2.75rem] bg-gray-900 p-2 shadow-soft">
        <div className="rounded-[2.25rem] bg-white p-3.5 h-[480px] flex flex-col gap-2.5">
          {/* Status bar */}
          <div className="flex items-center justify-between text-[10px] text-gray-400">
            <span className="font-semibold">9:41</span>
            <span className="flex items-center gap-1">
              <span className="inline-block h-1.5 w-1.5 rounded-full bg-emerald-500" />
              5G
            </span>
          </div>
          {/* App header */}
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold text-gray-900">
              {lang === "es" ? "Mis turnos" : "My shifts"}
            </h3>
            <div className="inline-flex h-6 w-6 items-center justify-center rounded-full bg-brand-100 text-brand-700 text-[10px] font-semibold">
              {t.you}
            </div>
          </div>
          {/* Today card */}
          <div className="text-[10px] font-semibold uppercase tracking-wide text-gray-400">
            {t.today}
          </div>
          <div className="rounded-2xl bg-brand-50 ring-1 ring-brand-100 p-3">
            <div className="flex items-center gap-2">
              <div className="inline-flex h-9 w-9 items-center justify-center rounded-full bg-brand-200 text-brand-800 text-xs font-semibold ring-2 ring-brand-500 ring-offset-1">
                {t.you}
              </div>
              <div className="flex-1 min-w-0">
                <div className="text-sm font-semibold text-brand-800 truncate">
                  {t.guardia}
                </div>
                <div className="mt-0.5 text-[11px] text-brand-700">
                  {t.guardiaTime}
                </div>
              </div>
            </div>
          </div>
          {/* Tomorrow card */}
          <div className="text-[10px] font-semibold uppercase tracking-wide text-gray-400 mt-1">
            {t.tomorrow}
          </div>
          <div className="rounded-2xl bg-white ring-1 ring-gray-200 p-3">
            <div className="flex items-center gap-2">
              <div className="inline-flex h-9 w-9 items-center justify-center rounded-full bg-brand-200 text-brand-800 text-xs font-semibold ring-2 ring-brand-500 ring-offset-1">
                {t.you}
              </div>
              <div className="flex-1 min-w-0">
                <div className="text-sm font-semibold text-gray-900 truncate">
                  {t.quirofano}
                </div>
                <div className="mt-0.5 text-[11px] text-gray-600">
                  {t.quirofanoTime}
                </div>
              </div>
            </div>
            <button
              type="button"
              className="mt-2.5 w-full inline-flex items-center justify-center gap-1.5 rounded-lg ring-1 ring-gray-200 px-2 py-1.5 text-[11px] font-medium text-gray-700"
            >
              <ArrowLeftRight className="h-3 w-3" />
              {t.coverage}
            </button>
          </div>
          <div className="flex-1" />
          {/* Mini stat strip */}
          <div className="flex items-center justify-between rounded-xl bg-emerald-50 ring-1 ring-emerald-100 px-3 py-2">
            <div className="flex items-center gap-1.5 text-emerald-700">
              <Scale className="h-3.5 w-3.5" />
              <span className="text-[10px] font-semibold uppercase tracking-wide">
                {t.balance}
              </span>
            </div>
            <span className="text-[11px] font-semibold text-emerald-800">
              3 ± 0.4
            </span>
          </div>
          {/* Bottom nav */}
          <div className="grid grid-cols-4 gap-1.5">
            {[CalendarCheck2, ArrowLeftRight, Sun, Users].map((Icon, i) => (
              <div
                key={i}
                className={
                  "h-9 rounded-xl flex items-center justify-center "
                  + (i === 0
                    ? "bg-brand-100 text-brand-700"
                    : "bg-gray-50 ring-1 ring-gray-200 text-gray-400")
                }
              >
                <Icon className="h-4 w-4" />
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

/** Admin-side mockup for the audience tab — the planning grid
 * miniature plus a couple of supporting cards (stats + pendientes).
 * Keeps the audience tabs swap visually distinct from the hero. */
function AdminMockup() {
  return (
    <div className="relative">
      {/* Generate-button float */}
      <div className="absolute -top-3 right-4 z-10 inline-flex items-center gap-1.5 rounded-full bg-brand-600 px-3 py-1.5 text-[11px] font-semibold text-white shadow-soft">
        <Wand2 className="h-3.5 w-3.5" />
        Generar
      </div>
      {/* Mini schedule card */}
      <div className="rounded-2xl bg-white ring-1 ring-gray-200 shadow-soft p-4">
        <div className="flex items-center gap-2">
          <CalendarCheck2 className="h-4 w-4 text-brand-700" />
          <span className="text-sm font-medium text-gray-800">
            Junio 2026
          </span>
          <span className="ml-auto inline-flex items-center rounded-md bg-emerald-50 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-emerald-700 ring-1 ring-emerald-200">
            Publicada
          </span>
        </div>
        {/* Tiny grid */}
        <div className="mt-3 grid grid-cols-[auto_repeat(10,minmax(0,1fr))] gap-0.5 text-[8px] text-gray-500">
          <div />
          {Array.from({ length: 10 }, (_, i) => (
            <div key={i} className="text-center">
              {String(i + 1).padStart(2, "0")}
            </div>
          ))}
          {["GUA", "CON", "QUI", "PLA", "TRA"].map((slot, rowIdx) => (
            <Fragment key={slot}>
              <div className="pr-1 self-center font-semibold text-[9px] text-gray-700">
                {slot}
              </div>
              {Array.from({ length: 10 }, (_, c) => {
                const isBrand = (c + rowIdx) % 4 === 0;
                const isAlt = (c + rowIdx) % 6 === 0;
                const isGap = rowIdx === 2 && c === 5;
                return (
                  <div
                    key={c}
                    className={
                      "h-3 rounded-sm "
                      + (isGap
                        ? "bg-rose-300"
                        : isBrand
                          ? "bg-brand-500"
                          : isAlt
                            ? "bg-brand-200"
                            : "bg-gray-100")
                    }
                  />
                );
              })}
            </Fragment>
          ))}
        </div>
      </div>
      {/* Pendientes card */}
      <div className="mt-4 rounded-2xl bg-white ring-1 ring-gray-200 shadow-soft p-4">
        <div className="flex items-center gap-2">
          <Bell className="h-4 w-4 text-amber-600" />
          <span className="text-sm font-medium text-gray-800">
            Pendientes de aprobación
          </span>
          <span className="ml-auto inline-flex items-center rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-semibold text-amber-800">
            3
          </span>
        </div>
        <div className="mt-3 space-y-2">
          {[
            {
              initials: "AB",
              avatarBg: "#dbeafe",
              avatarFg: "#1e40af",
              kind: "Vacaciones",
              detail: "12–19 jul",
            },
            {
              initials: "CD",
              avatarBg: "#fef3c7",
              avatarFg: "#92400e",
              kind: "Cobertura",
              detail: "Guardia · 04 jun",
            },
            {
              initials: "EF",
              avatarBg: "#dcfce7",
              avatarFg: "#166534",
              kind: "Cambio de turno",
              detail: "14 jun",
            },
          ].map((p) => (
            <div
              key={p.initials}
              className="flex items-center gap-2 rounded-lg bg-gray-50 px-2.5 py-1.5"
            >
              <div
                className="inline-flex h-6 w-6 items-center justify-center rounded-full text-[10px] font-semibold"
                style={{ backgroundColor: p.avatarBg, color: p.avatarFg }}
                aria-hidden
              >
                {p.initials}
              </div>
              <div className="flex-1 min-w-0">
                <div className="text-[11px] font-semibold text-gray-900 truncate">
                  {p.kind}
                </div>
                <div className="text-[10px] text-gray-600 truncate">
                  {p.detail}
                </div>
              </div>
              <button
                type="button"
                className="inline-flex items-center rounded-md bg-brand-600 px-2 py-1 text-[10px] font-semibold text-white"
              >
                OK
              </button>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ===========================================================================
// Small visual primitives + cards
// ===========================================================================

function BeforeAfterCard({
  tone,
  badge,
  sublabel,
  points,
}: {
  tone: "bad" | "good";
  badge: string;
  sublabel: string;
  points: readonly { kind: "bad" | "good"; text: string }[];
}) {
  const isBad = tone === "bad";
  const Icon = isBad ? FileSpreadsheet : Sparkles;
  return (
    <div
      className={
        "rounded-2xl p-6 ring-1 shadow-soft flex flex-col "
        + (isBad
          ? "bg-gradient-to-br from-amber-50/70 to-rose-50/40 ring-amber-200"
          : "bg-gradient-to-br from-brand-50 to-emerald-50/50 ring-brand-200")
      }
    >
      <div className="flex items-center gap-3">
        <div
          className={
            "inline-flex h-10 w-10 items-center justify-center rounded-lg "
            + (isBad ? "bg-amber-100 text-amber-700" : "bg-brand-100 text-brand-700")
          }
        >
          <Icon className="h-5 w-5" />
        </div>
        <div>
          <div
            className={
              "text-base font-semibold "
              + (isBad ? "text-amber-900" : "text-brand-800")
            }
          >
            {badge}
          </div>
          <div className="text-xs text-gray-600">{sublabel}</div>
        </div>
      </div>
      <ul className="mt-5 space-y-2.5">
        {points.map((p) => (
          <li key={p.text} className="flex items-start gap-2.5">
            <span
              className={
                "mt-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full "
                + (isBad
                  ? "bg-rose-100 text-rose-700"
                  : "bg-emerald-100 text-emerald-700")
              }
            >
              {isBad ? <X className="h-3 w-3" /> : <Plus className="h-3 w-3" />}
            </span>
            <span
              className={
                "text-sm leading-snug "
                + (isBad ? "text-gray-700" : "text-gray-800")
              }
            >
              {p.text}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function FeatureCard({
  card,
}: {
  card: {
    icon: "wand" | "sun" | "swap" | "calendarOff" | "directory" | "meeting";
    tone: "brand" | "amber" | "sky" | "emerald" | "violet" | "rose";
    heading: string;
    body: string;
    chip: string;
  };
}) {
  const tones: Record<
    string,
    { bg: string; fg: string; chipBg: string; chipFg: string; ring: string }
  > = {
    brand: {
      bg: "bg-brand-50",
      fg: "text-brand-700",
      chipBg: "bg-brand-100",
      chipFg: "text-brand-800",
      ring: "ring-brand-100",
    },
    amber: {
      bg: "bg-amber-50",
      fg: "text-amber-700",
      chipBg: "bg-amber-100",
      chipFg: "text-amber-800",
      ring: "ring-amber-100",
    },
    sky: {
      bg: "bg-sky-50",
      fg: "text-sky-700",
      chipBg: "bg-sky-100",
      chipFg: "text-sky-800",
      ring: "ring-sky-100",
    },
    emerald: {
      bg: "bg-emerald-50",
      fg: "text-emerald-700",
      chipBg: "bg-emerald-100",
      chipFg: "text-emerald-800",
      ring: "ring-emerald-100",
    },
    violet: {
      bg: "bg-violet-50",
      fg: "text-violet-700",
      chipBg: "bg-violet-100",
      chipFg: "text-violet-800",
      ring: "ring-violet-100",
    },
    rose: {
      bg: "bg-rose-50",
      fg: "text-rose-700",
      chipBg: "bg-rose-100",
      chipFg: "text-rose-800",
      ring: "ring-rose-100",
    },
  };
  const t = tones[card.tone];
  return (
    <div className="group rounded-2xl bg-white p-6 ring-1 ring-gray-200 shadow-soft hover:shadow-md hover:ring-gray-300 transition-all">
      <div className="flex items-center gap-3">
        <div
          className={`inline-flex h-10 w-10 items-center justify-center rounded-lg ${t.bg} ${t.fg}`}
        >
          <FeatureIcon name={card.icon} />
        </div>
        <span
          className={`ml-auto inline-flex items-center rounded-full ${t.chipBg} ${t.chipFg} px-2.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide`}
        >
          {card.chip}
        </span>
      </div>
      <h3 className="mt-4 text-lg font-semibold text-gray-900">
        {card.heading}
      </h3>
      <p className="mt-2 text-sm text-gray-600 leading-relaxed">{card.body}</p>
    </div>
  );
}

/** One of the two pricing tiers (Admin / Member). `primary` flips
 * the visual treatment to a brand-tinted gradient — used for the
 * Admin card because that's the buyer's plan. The Member card stays
 * neutral so they read as peers (one tool, two roles) rather than
 * a basic-vs-premium hierarchy. */
function PricingCard({
  plan,
  primary,
}: {
  plan: {
    name: string;
    price: string;
    cadence: string;
    tagline: string;
    features: readonly string[];
    cta: string;
  };
  primary: boolean;
}) {
  return (
    <div
      className={
        "flex flex-col rounded-2xl p-6 sm:p-8 shadow-soft ring-1 "
        + (primary
          ? "bg-gradient-to-br from-brand-50 via-white to-white ring-brand-200"
          : "bg-white ring-gray-200")
      }
    >
      <div className="flex items-baseline gap-2">
        <h3 className="text-xl font-semibold text-gray-900">{plan.name}</h3>
      </div>
      <p className="mt-1 text-sm text-gray-600">{plan.tagline}</p>
      <div className="mt-5 flex items-baseline gap-1.5">
        <span className="text-4xl sm:text-5xl font-semibold tracking-tight text-gray-900">
          {plan.price}
        </span>
        <span className="text-sm text-gray-500">{plan.cadence}</span>
      </div>
      <ul className="mt-6 space-y-2.5 flex-1">
        {plan.features.map((f) => (
          <li key={f} className="flex items-start gap-2.5">
            <span
              className={
                "mt-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full "
                + (primary
                  ? "bg-brand-100 text-brand-700"
                  : "bg-emerald-100 text-emerald-700")
              }
            >
              <Plus className="h-3 w-3" />
            </span>
            <span className="text-sm text-gray-700 leading-snug">{f}</span>
          </li>
        ))}
      </ul>
      <div className="mt-7">
        <Link
          href="/signup"
          className={
            "inline-flex items-center gap-2 rounded-xl px-4 py-2.5 text-sm font-semibold transition-colors w-full justify-center "
            + (primary
              ? "bg-brand-600 text-white hover:bg-brand-700 shadow-soft"
              : "bg-white text-gray-800 ring-1 ring-gray-300 hover:bg-gray-50")
          }
        >
          {plan.cta}
          <ArrowRight className="h-4 w-4" />
        </Link>
      </div>
    </div>
  );
}

function FaqRow({
  q,
  a,
  isOpen,
  onToggle,
}: {
  q: string;
  a: string;
  isOpen: boolean;
  onToggle: () => void;
}) {
  return (
    <div>
      <button
        type="button"
        onClick={onToggle}
        className="w-full flex items-start gap-3 px-5 py-4 text-left hover:bg-gray-50/60 transition-colors"
        aria-expanded={isOpen}
      >
        <span className="flex-1 text-sm sm:text-base font-semibold text-gray-900">
          {q}
        </span>
        <ChevronDown
          className={
            "mt-0.5 h-4 w-4 shrink-0 text-gray-500 transition-transform "
            + (isOpen ? "rotate-180" : "")
          }
        />
      </button>
      {isOpen && (
        <div className="px-5 pb-5 -mt-1 text-sm sm:text-base text-gray-600 leading-relaxed">
          {a}
        </div>
      )}
    </div>
  );
}

function FeatureIcon({
  name,
}: {
  name: "wand" | "sun" | "swap" | "calendarOff" | "directory" | "meeting";
}) {
  switch (name) {
    case "wand":
      return <Wand2 className="h-5 w-5" />;
    case "sun":
      return <Sun className="h-5 w-5" />;
    case "swap":
      return <ArrowLeftRight className="h-5 w-5" />;
    case "calendarOff":
      return <CalendarRange className="h-5 w-5" />;
    case "directory":
      return <PhoneCall className="h-5 w-5" />;
    case "meeting":
      return <Users className="h-5 w-5" />;
  }
}

function WhyIcon({
  name,
}: {
  name: "hospital" | "sparkles" | "shield";
}) {
  switch (name) {
    case "hospital":
      return <Hospital className="h-5 w-5" />;
    case "sparkles":
      return <Sparkles className="h-5 w-5" />;
    case "shield":
      return <Shield className="h-5 w-5" />;
  }
}

