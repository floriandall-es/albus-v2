import Image from "next/image";
import Link from "next/link";

// IMPORTANT: this is PLACEHOLDER text. Have it reviewed and replaced
// by a Spanish-qualified abogado before public launch — particularly
// the data-categories list, retention periods, and any references to
// the Responsable del Tratamiento, DPO, and supervisory authority
// (AEPD). Keep the version number here in sync with the corresponding
// version in /terms/page.tsx and with `terms_current_version` in
// api/app/core/config.py.

// Version + last-updated stamp shown at the top of the page. Bump
// this AND the matching strings in /terms/page.tsx AND
// `terms_current_version` in api/app/core/config.py together when
// the legal text changes substantively, so existing acceptances
// become stale and the frontend can re-prompt.
const PRIVACY_VERSION = "1.0";
const LAST_UPDATED = "20 de mayo de 2026";

export default function PrivacyPage() {
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
          <h1>Política de Privacidad</h1>
          <p className="text-xs text-gray-500">
            Versión {PRIVACY_VERSION} · Última actualización: {LAST_UPDATED}
          </p>

          <p className="mt-2 rounded-md bg-amber-50 ring-1 ring-amber-200 p-3 text-xs text-amber-900">
            <strong>PENDIENTE DE REVISIÓN LEGAL.</strong> Este texto es
            un borrador interno. Antes del lanzamiento público debe
            revisarse con un abogado especialista en protección de
            datos para asegurar el cumplimiento del RGPD y la LOPDGDD.
          </p>

          <section className="mt-6">
            <h2>1. Responsable del tratamiento</h2>
            <p>
              El responsable del tratamiento es{" "}
              <em>[Razón social pendiente]</em>, con domicilio en{" "}
              <em>[dirección pendiente]</em> y correo de contacto{" "}
              <em>[contacto pendiente]</em>.
            </p>
          </section>

          <section>
            <h2>2. Datos que tratamos</h2>
            <ul>
              <li>
                Datos identificativos: nombre, apellidos, dirección de
                correo electrónico.
              </li>
              <li>
                Datos profesionales: categoría profesional, equipo o
                sub-equipo, jornada (FTE).
              </li>
              <li>
                Datos de planificación: turnos asignados, bloqueos por
                vacaciones, formación o baja médica, reuniones.
              </li>
              <li>
                Datos técnicos: registros de acceso, dirección IP,
                identificadores de sesión.
              </li>
            </ul>
            <p className="text-xs">
              Algunos de estos datos pueden tener la consideración de
              <strong> categorías especiales de datos</strong> (datos
              relativos a la salud) cuando se registran bajas médicas.
              El tratamiento de estas categorías se ampara en el
              artículo 9.2.b del RGPD (cumplimiento de obligaciones
              laborales).
            </p>
          </section>

          <section>
            <h2>3. Finalidad y base jurídica</h2>
            <p>
              Tratamos los datos con la finalidad de gestionar la
              planificación de turnos, ausencias y cambios entre
              miembros del equipo. La base jurídica es la ejecución
              del contrato laboral entre el centro y sus profesionales
              (artículo 6.1.b RGPD) y el interés legítimo del centro
              en organizar su actividad.
            </p>
          </section>

          <section>
            <h2>4. Plazo de conservación</h2>
            <p>
              Conservamos los datos mientras se mantenga la relación
              contractual entre el centro y Trivu, y durante los
              plazos legales aplicables tras su finalización.
            </p>
          </section>

          <section>
            <h2>5. Destinatarios</h2>
            <p>
              No cedemos datos a terceros salvo obligación legal. Los
              datos se alojan en servidores ubicados en la Unión
              Europea.
            </p>
          </section>

          <section>
            <h2>6. Derechos</h2>
            <p>
              El interesado puede ejercer los derechos de acceso,
              rectificación, supresión, oposición, limitación y
              portabilidad escribiendo a{" "}
              <em>[contacto pendiente]</em>. También tiene derecho a
              presentar una reclamación ante la Agencia Española de
              Protección de Datos (www.aepd.es).
            </p>
          </section>

          <section>
            <h2>7. Cambios en esta política</h2>
            <p>
              Esta política puede actualizarse. Las modificaciones
              sustantivas se notificarán a los usuarios.
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
