import Image from "next/image";
import Link from "next/link";

// IMPORTANT: this is PLACEHOLDER text. Have it reviewed and replaced
// by a Spanish-qualified abogado before public launch. The structure
// is meant to be edit-friendly: each section is a single <section>
// with an <h2> and one or more <p>/<ul> blocks. Keep the version
// number in this file in sync with `terms_current_version` in
// api/app/core/config.py — when the text changes substantively, bump
// both so the frontend can prompt existing users for re-acceptance.

// See sibling /privacy/page.tsx for the version-bump protocol.
const TERMS_VERSION = "1.0";
const LAST_UPDATED = "20 de mayo de 2026";

export default function TermsPage() {
  return (
    <main className="min-h-screen px-4 py-12 bg-gradient-to-b from-brand-50/50 to-gray-50">
      <div className="mx-auto max-w-2xl">
        <Link href="/" className="inline-flex items-center gap-2 mb-6">
          <Image
            src="/logo.jpeg"
            alt="Trivu"
            width={48}
            height={48}
            className="h-10 w-10 rounded-lg shadow-soft"
          />
          <span className="font-semibold text-brand-700">Trivu</span>
        </Link>

        <article className="rounded-2xl bg-white shadow-soft ring-1 ring-gray-200 p-8 prose prose-sm max-w-none">
          <h1>Términos y Condiciones de Uso</h1>
          <p className="text-xs text-gray-500">
            Versión {TERMS_VERSION} · Última actualización: {LAST_UPDATED}
          </p>

          <section className="mt-6">
            <h2>1. Objeto</h2>
            <p>
              Estos términos regulan el uso de Trivu (en adelante, «la
              Plataforma»), un servicio de planificación de turnos
              clínicos ofrecido a equipos sanitarios. Al crear una
              cuenta o aceptar una invitación, el usuario acepta
              íntegramente estos términos.
            </p>
          </section>

          <section>
            <h2>2. Cuenta y responsabilidad</h2>
            <p>
              El usuario se compromete a facilitar información veraz
              al registrarse y a mantener la confidencialidad de sus
              credenciales. Es responsable de toda la actividad que se
              realice desde su cuenta.
            </p>
          </section>

          <section>
            <h2>3. Uso aceptable</h2>
            <p>
              El usuario no podrá utilizar la Plataforma para fines
              ilícitos, infringir derechos de terceros, o intentar
              acceder a datos o sistemas para los que no esté
              autorizado.
            </p>
          </section>

          <section>
            <h2>4. Datos personales</h2>
            <p>
              El tratamiento de datos personales se rige por la{" "}
              <Link href="/privacy" className="text-brand-700 underline">
                Política de Privacidad
              </Link>
              , que forma parte integral de estos términos.
            </p>
          </section>

          <section>
            <h2>5. Disponibilidad del servicio</h2>
            <p>
              Trivu hará esfuerzos razonables para mantener la
              Plataforma disponible, pero no garantiza un nivel de
              servicio específico. Podrá realizar mantenimientos
              programados o no programados.
            </p>
          </section>

          <section>
            <h2>6. Modificaciones</h2>
            <p>
              Estos términos pueden actualizarse. Las modificaciones
              sustantivas se notificarán a los usuarios y, en su caso,
              se solicitará una nueva aceptación.
            </p>
          </section>

          <section>
            <h2>7. Ley aplicable</h2>
            <p>
              Estos términos se rigen por la legislación española.
              Cualquier controversia se someterá a los juzgados y
              tribunales competentes del domicilio del usuario cuando
              actúe como consumidor.
            </p>
          </section>
        </article>

        <p className="mt-6 text-center text-sm text-gray-600">
          <Link
            href="/signup"
            className="text-brand-700 font-medium hover:underline"
          >
            Volver al registro
          </Link>
        </p>
      </div>
    </main>
  );
}
