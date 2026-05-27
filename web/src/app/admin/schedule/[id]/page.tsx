"use client";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft } from "lucide-react";
import { api } from "@/lib/api";
import { Button, ErrorText } from "@/components/admin/ui";
import { BalanceStats } from "@/components/schedule/BalanceStats";
import { NotifyConfirmModal } from "@/components/schedule/NotifyConfirmModal";
import { ScheduleSection } from "@/components/schedule/ScheduleSection";
import { formatPeriod } from "@/components/admin/month-picker";

const STATUS_LABEL: Record<string, string> = {
  draft: "Borrador",
  published: "Publicada",
  archived: "Archivada",
};

// Plain-language explainer rendered next to the bold status word
// so non-technical admins can tell at a glance what changes for
// the team in each state. See also: /admin/schedule list view.
const STATUS_SUBTITLE: Record<string, string> = {
  draft: "solo tú la ves",
  published: "visible para el equipo",
  archived: "ya no visible para el equipo",
};

/**
 * Per-month schedule detail page. The editable body (grid, modals,
 * violations banner, periodo banner, per-cell mutations) lives in
 * <ScheduleSection />; this page owns the page-level chrome — title,
 * status pill, Publicar/Reabrir/Archivar/Eliminar buttons, the
 * NotifyConfirmModal, the Estado/Visibilidad explainer line, and the
 * Reparto-por-persona stats table at the bottom.
 *
 * Sharing this split with /admin/schedule/periodo/[id] is the whole
 * reason for the extraction: the period view stacks several sections
 * (one per month) under one combined header and one combined
 * Reparto-por-persona table.
 */
export default function ScheduleDetailPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const qc = useQueryClient();
  const id = Number(params.id);
  // Which lifecycle action is currently being confirmed via the
  // notify-members modal. Null when no modal is open.
  const [confirmingAction, setConfirmingAction] = useState<
    "publish" | "reopen" | null
  >(null);

  const detail = useQuery({
    queryKey: ["schedule", id],
    queryFn: () => api.getSchedule(id),
    enabled: !Number.isNaN(id),
  });
  // Holidays + team are loaded here for BalanceStats. ScheduleSection
  // also uses the same query keys for holidays internally, so react-
  // query dedupes the request — only one network roundtrip total.
  const holidays = useQuery({
    queryKey: ["holidays-detail", detail.data?.period],
    queryFn: () =>
      api.listHolidays(new Date(detail.data!.period).getFullYear()),
    enabled: !!detail.data,
  });
  // Loaded here so BalanceStats can sort columns by (categoría, name).
  // Same query key used inside ManageAbsencesModal — react-query
  // dedupes the request.
  const team = useQuery({ queryKey: ["team"], queryFn: api.listTeam });

  const publish = useMutation({
    mutationFn: (notifyMembers: boolean) =>
      api.publishSchedule(id, notifyMembers),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["schedule", id] }),
  });
  const archive = useMutation({
    mutationFn: () => api.archiveSchedule(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["schedule", id] }),
  });
  const unarchive = useMutation({
    mutationFn: () => api.unarchiveSchedule(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["schedule", id] });
      qc.invalidateQueries({ queryKey: ["schedules"] });
    },
  });
  const reopen = useMutation({
    mutationFn: (notifyMembers: boolean) =>
      api.reopenSchedule(id, notifyMembers),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["schedule", id] });
      qc.invalidateQueries({ queryKey: ["schedules"] });
    },
  });
  const regenerate = useMutation({
    mutationFn: () => api.generateSchedule(detail.data!.period),
    onSuccess: (data) => {
      qc.invalidateQueries({ queryKey: ["schedules"] });
      router.replace(`/admin/schedule/${data.id}`);
    },
  });
  const remove = useMutation({
    mutationFn: () => api.deleteSchedule(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["schedules"] });
      router.replace("/admin/schedule");
    },
  });
  const downloadPdf = useMutation({
    mutationFn: () => api.downloadSchedulePdf(id),
  });

  const holidayDates = useMemo(
    () => new Set((holidays.data ?? []).map((h) => h.date)),
    [holidays.data],
  );

  if (detail.isLoading) {
    return <p className="text-sm text-gray-500">Cargando…</p>;
  }
  if (detail.isError || !detail.data) {
    return <ErrorText>{(detail.error as Error)?.message ?? "Error"}</ErrorText>;
  }

  const s = detail.data;
  const isEditable = s.status === "draft";
  // Surface mutation errors that until now were swallowed silently
  // (e.g. unarchive failing → button briefly disables, nothing else).
  // First non-null wins; refreshing detail.data implicitly clears the
  // visible error after a successful retry.
  const actionError =
    (publish.error as Error | null)
    ?? (archive.error as Error | null)
    ?? (unarchive.error as Error | null)
    ?? (reopen.error as Error | null)
    ?? (regenerate.error as Error | null)
    ?? (remove.error as Error | null)
    ?? (downloadPdf.error as Error | null);
  return (
    <>
      <div className="mb-6 flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-semibold">{`Planificación · ${formatPeriod(s.period)}`}</h1>
        <div className="flex gap-2">
          {s.status === "draft" && (
            <>
              <Button
                variant="secondary"
                onClick={() => regenerate.mutate()}
                disabled={regenerate.isPending}
              >
                Regenerar
              </Button>
              <Button
                onClick={() => setConfirmingAction("publish")}
                disabled={publish.isPending}
              >
                {publish.isPending ? "Publicando…" : "Publicar"}
              </Button>
              <Button
                variant="danger"
                onClick={() => {
                  if (
                    confirm(
                      `¿Eliminar el borrador de ${formatPeriod(s.period)}? Esta acción no se puede deshacer.`,
                    )
                  ) {
                    remove.mutate();
                  }
                }}
                disabled={remove.isPending}
              >
                Eliminar
              </Button>
            </>
          )}
          {s.status === "published" && (
            <>
              <Button
                variant="secondary"
                onClick={() => setConfirmingAction("reopen")}
                disabled={reopen.isPending}
              >
                {reopen.isPending ? "Reabriendo…" : "Reabrir"}
              </Button>
              <Button
                variant="secondary"
                onClick={() => archive.mutate()}
                disabled={archive.isPending}
              >
                Archivar
              </Button>
            </>
          )}
          {s.status === "archived" && (
            <Button
              variant="secondary"
              onClick={() => unarchive.mutate()}
              disabled={unarchive.isPending}
            >
              {unarchive.isPending ? "Desarchivando…" : "Desarchivar"}
            </Button>
          )}
          <Button
            variant="secondary"
            onClick={() => downloadPdf.mutate()}
            disabled={downloadPdf.isPending}
          >
            {downloadPdf.isPending ? "Generando PDF…" : "Descargar PDF"}
          </Button>
          {/* Mirror of the Volver button on the period view. Always
              points back to /admin/schedule (the planificación list).
              Period-aware "back" — sending the user to the periodo
              page when they came in via "Abrir mes individual" —
              would need referrer/history sniffing; the list is the
              one parent every entry point converges on, so we
              standardise on that. */}
          <Link
            href="/admin/schedule"
            className="inline-flex items-center gap-1.5 rounded-lg ring-1 ring-gray-300 bg-white px-3 py-1.5 text-sm font-medium text-gray-800 hover:bg-gray-50 transition-colors"
          >
            <ArrowLeft className="h-4 w-4" />
            Volver
          </Link>
        </div>
      </div>
      {actionError && (
        <div className="mb-3">
          <ErrorText>{actionError.message}</ErrorText>
        </div>
      )}
      <p className="mb-4 text-sm text-gray-600">
        Estado: <span className="font-medium">{STATUS_LABEL[s.status]}</span>
        {STATUS_SUBTITLE[s.status] && (
          <span className="ml-1 text-gray-500">
            · {STATUS_SUBTITLE[s.status]}
          </span>
        )}
        {s.reopened_at && (
          <span
            className="ml-3 inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide bg-amber-50 text-amber-800 border border-amber-200"
            title={
              "Esta planificación fue reabierta el "
              + new Date(s.reopened_at).toLocaleString()
              + ". Los miembros del equipo no la verán hasta que se publique de nuevo."
            }
          >
            Reabierta
          </span>
        )}
        {s.solver_used && (
          <span
            className={
              "ml-3 inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide "
              + (s.solver_used === "cpsat"
                ? "bg-emerald-50 text-emerald-700 border border-emerald-200"
                : "bg-amber-50 text-amber-800 border border-amber-200")
            }
            title={
              s.solver_used === "cpsat"
                ? "Equilibrada: equidad, descansos y reglas cruzadas aplicadas."
                : "Simplificada (respaldo): no se pudo equilibrar con todas las reglas activas — la planificación es válida pero el reparto puede ser desigual."
            }
          >
            {s.solver_used === "cpsat" ? "Equilibrada" : "Simplificada"}
          </span>
        )}
        {isEditable && (
          <span className="ml-3 text-xs text-gray-500">
            (haz clic en una celda para editarla)
          </span>
        )}
      </p>

      <ScheduleSection scheduleId={id} />

      <BalanceStats
        assignments={s.assignments}
        holidayDates={holidayDates}
        team={team.data ?? []}
      />

      {confirmingAction === "publish" && (
        <NotifyConfirmModal
          title="Publicar planificación"
          description={
            s.reopened_at
              ? "La planificación volverá a estar visible en \"Mis turnos\" con los ajustes que has hecho."
              : "La planificación quedará visible para todos los miembros del equipo en \"Mis turnos\"."
          }
          confirmLabel="Publicar"
          notifyLabel="Avisar por email a los miembros del equipo"
          onClose={() => setConfirmingAction(null)}
          onConfirm={(notify) => {
            publish.mutate(notify, {
              onSuccess: () => setConfirmingAction(null),
            });
          }}
          isPending={publish.isPending}
        />
      )}
      {confirmingAction === "reopen" && (
        <NotifyConfirmModal
          title="Reabrir planificación"
          description={
            "Volver a borrador para hacer cambios. Los cambios de turno pendientes se cancelarán y la planificación dejará de estar visible en \"Mis turnos\" hasta volver a publicarla."
          }
          confirmLabel="Reabrir"
          notifyLabel="Avisar por email a los miembros del equipo"
          onClose={() => setConfirmingAction(null)}
          onConfirm={(notify) => {
            reopen.mutate(notify, {
              onSuccess: () => setConfirmingAction(null),
            });
          }}
          isPending={reopen.isPending}
        />
      )}
    </>
  );
}
