import { redirect } from "next/navigation";

/**
 * The standalone /me/servicio page got folded into /me/turnos as a
 * third Scope option ("Servicio") because keeping two separate
 * surfaces for "my team" and "my team + siblings" was redundant
 * — the Servicio view always wanted the user's own team's grid at
 * the top anyway. This redirect preserves deep links (admin pages
 * + bookmarks) that still point here.
 *
 * `?scope=servicio` tells /me/turnos to override whatever scope the
 * user last had stored so they land where they expected.
 */
export default function ServicioRedirect() {
  redirect("/me/turnos?scope=servicio");
}
