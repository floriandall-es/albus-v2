"use client";
import { useEffect, useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  api,
  API_BASE_URL,
  type BulkCommitResponse,
  type BulkPreviewResponse,
} from "@/lib/api";
import { Button, ErrorText, Modal } from "@/components/admin/ui";

type Stage = "pick" | "preview" | "result";

export function BulkInviteModal({
  open,
  onClose,
  onCommitted,
  sendEmail = true,
}: {
  open: boolean;
  onClose: () => void;
  onCommitted?: () => void;
  /** When false the modal both posts send_email=false to the API
   * (so no invitation emails go out) and switches its copy from
   * "Confirmar e invitar" / "Hemos enviado un email…" to the
   * onboarding wording ("Confirmar y añadir" / "Los invitarás
   * más tarde…"). Default true preserves the /admin/team flow. */
  sendEmail?: boolean;
}) {
  const qc = useQueryClient();
  const [stage, setStage] = useState<Stage>("pick");
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<BulkPreviewResponse | null>(null);
  const [result, setResult] = useState<BulkCommitResponse | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) {
      // Reset on close
      setStage("pick");
      setFile(null);
      setPreview(null);
      setResult(null);
      setDragOver(false);
    }
  }, [open]);

  const previewMut = useMutation({
    mutationFn: (f: File) => api.bulkInvitePreview(f),
    onSuccess: (data) => {
      setPreview(data);
      setStage("preview");
    },
  });

  const commitMut = useMutation({
    mutationFn: () => {
      if (!preview) throw new Error("No preview");
      const rows = preview.rows
        .filter((r) => r.status === "ok" || r.status === "warning")
        .map((r) => ({
          row_number: r.row_number,
          email: r.email,
          name: r.name,
          category_id: r.category_id,
        }));
      return api.bulkInviteCommit(rows, { sendEmail });
    },
    onSuccess: (data) => {
      setResult(data);
      setStage("result");
      qc.invalidateQueries({ queryKey: ["invitations"] });
      qc.invalidateQueries({ queryKey: ["team"] });
      onCommitted?.();
    },
  });

  function handleFile(f: File | null) {
    if (!f) return;
    setFile(f);
    previewMut.mutate(f);
  }

  function onDrop(e: React.DragEvent<HTMLDivElement>) {
    e.preventDefault();
    setDragOver(false);
    const f = e.dataTransfer.files?.[0] ?? null;
    handleFile(f);
  }

  const validToCommit = preview
    ? preview.summary.valid_rows + preview.summary.warning_rows
    : 0;

  return (
    <Modal open={open} onClose={onClose} title="Importar equipo desde CSV o Excel" size="lg">
      <div>
        {stage === "pick" && (
          <div className="space-y-4">
            <p className="text-sm text-gray-600">
              El archivo debe tener tres columnas (en cualquier orden):{" "}
              <code className="rounded bg-gray-100 px-1">email</code>,{" "}
              <code className="rounded bg-gray-100 px-1">nombre</code>,{" "}
              <code className="rounded bg-gray-100 px-1">categoría</code>. La
              categoría es opcional, pero si se indica debe coincidir con una
              categoría existente del equipo.
            </p>
            <div
              onDragOver={(e) => {
                e.preventDefault();
                setDragOver(true);
              }}
              onDragLeave={() => setDragOver(false)}
              onDrop={onDrop}
              onClick={() => inputRef.current?.click()}
              className={`flex h-40 cursor-pointer flex-col items-center justify-center rounded-md border-2 border-dashed p-4 text-center text-sm transition-colors ${
                dragOver
                  ? "border-gray-900 bg-gray-50"
                  : "border-gray-300 bg-white"
              }`}
            >
              <p className="font-medium">Arrastra un archivo CSV o Excel aquí</p>
              <p className="mt-1 text-gray-500">o haz click para seleccionarlo</p>
              {file && (
                <p className="mt-2 text-xs text-gray-700">{file.name}</p>
              )}
              <input
                ref={inputRef}
                type="file"
                accept=".csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
                hidden
                onChange={(e) => handleFile(e.target.files?.[0] ?? null)}
              />
            </div>
            <div className="flex items-center justify-between text-xs">
              <a
                href={`${API_BASE_URL}/api/team/invite/bulk/template`}
                className="underline text-gray-700"
              >
                Descargar plantilla (CSV)
              </a>
              <span className="text-gray-500">
                CSV o Excel · Máximo 1 MB · 5000 filas
              </span>
            </div>
            {previewMut.isPending && (
              <p className="text-sm text-gray-500">Validando…</p>
            )}
            {previewMut.isError && (
              <ErrorText>{(previewMut.error as Error).message}</ErrorText>
            )}
          </div>
        )}

        {stage === "preview" && preview && (
          <div className="space-y-3">
            <div className="max-h-80 overflow-auto rounded-md border">
              <table className="w-full text-sm">
                <thead className="sticky top-0 border-b bg-gray-50 text-left text-gray-600">
                  <tr>
                    <th className="px-2 py-1 font-medium w-10">#</th>
                    <th className="px-2 py-1 font-medium w-8"></th>
                    <th className="px-2 py-1 font-medium">Email</th>
                    <th className="px-2 py-1 font-medium">Nombre</th>
                    <th className="px-2 py-1 font-medium">Categoría</th>
                    <th className="px-2 py-1 font-medium">Aviso</th>
                  </tr>
                </thead>
                <tbody>
                  {preview.rows.map((r) => (
                    <tr
                      key={r.row_number}
                      className="border-b last:border-b-0"
                      title={r.error ?? r.warning ?? ""}
                    >
                      <td className="px-2 py-1 text-gray-500">{r.row_number}</td>
                      <td className="px-2 py-1">
                        {r.status === "ok" && (
                          <span className="text-green-600">✓</span>
                        )}
                        {r.status === "warning" && (
                          <span className="text-amber-600">⚠</span>
                        )}
                        {r.status === "error" && (
                          <span className="text-red-600">✗</span>
                        )}
                      </td>
                      <td className="px-2 py-1">{r.email}</td>
                      <td className="px-2 py-1">{r.name}</td>
                      <td className="px-2 py-1 text-gray-600">
                        {r.category ?? "—"}
                      </td>
                      <td className="px-2 py-1 text-xs text-gray-600">
                        {r.error ?? r.warning ?? ""}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="text-sm">
              <span className="text-green-700">
                {preview.summary.valid_rows} válidas
              </span>{" "}
              ·{" "}
              <span className="text-amber-700">
                {preview.summary.warning_rows} avisos
              </span>{" "}
              ·{" "}
              <span className="text-red-700">
                {preview.summary.error_rows} errores
              </span>
            </p>
            {commitMut.isError && (
              <ErrorText>{(commitMut.error as Error).message}</ErrorText>
            )}
            <div className="flex justify-end gap-2 pt-1">
              <Button variant="secondary" onClick={onClose}>
                Cancelar
              </Button>
              <Button
                onClick={() => commitMut.mutate()}
                disabled={validToCommit === 0 || commitMut.isPending}
              >
                {commitMut.isPending
                  ? "Creando…"
                  : `${sendEmail ? "Confirmar e invitar" : "Confirmar y añadir"} ${validToCommit} ${
                      validToCommit === 1 ? "persona" : "personas"
                    }`}
              </Button>
            </div>
          </div>
        )}

        {stage === "result" && result && (
          <div className="space-y-3">
            <p className="text-sm">
              <span className="text-green-700">
                {result.summary.committed} creadas
              </span>{" "}
              ·{" "}
              <span className="text-gray-600">
                {result.summary.skipped} omitidas
              </span>{" "}
              ·{" "}
              <span className="text-red-700">
                {result.summary.errored} errores
              </span>
            </p>
            <div className="max-h-80 overflow-auto rounded-md border">
              <table className="w-full text-sm">
                <thead className="sticky top-0 border-b bg-gray-50 text-left text-gray-600">
                  <tr>
                    <th className="px-2 py-1 font-medium w-10">#</th>
                    <th className="px-2 py-1 font-medium">Email</th>
                    <th className="px-2 py-1 font-medium">Estado</th>
                    <th className="px-2 py-1 font-medium">Enlace / motivo</th>
                  </tr>
                </thead>
                <tbody>
                  {result.results.map((r) => (
                    <tr key={r.row_number} className="border-b last:border-b-0">
                      <td className="px-2 py-1 text-gray-500">{r.row_number}</td>
                      <td className="px-2 py-1">{r.email}</td>
                      <td className="px-2 py-1">
                        {r.status === "ok" && (
                          <span className="text-green-700">creada</span>
                        )}
                        {r.status === "skipped" && (
                          <span className="text-gray-600">omitida</span>
                        )}
                        {r.status === "error" && (
                          <span className="text-red-700">error</span>
                        )}
                      </td>
                      <td className="px-2 py-1 text-xs">
                        {r.invitation ? (
                          <CopyableLink url={r.invitation.accept_url} />
                        ) : (
                          <span className="text-gray-600">{r.reason}</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="text-xs text-gray-500">
              {sendEmail
                ? "Hemos enviado un email a cada persona con su enlace. Puedes copiar los enlaces de abajo como respaldo si alguien no recibe el correo."
                : "Hemos añadido a cada persona al equipo. Cuando termines de configurar todo, podrás enviarles la invitación por email desde Admin → Equipo."}
            </p>
            <div className="flex justify-end pt-1">
              <Button onClick={onClose}>Cerrar</Button>
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
}

function CopyableLink({ url }: { url: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex items-center gap-2">
      <code className="flex-1 break-all rounded bg-gray-100 px-2 py-1">
        {url}
      </code>
      <button
        className="underline"
        onClick={() => {
          navigator.clipboard.writeText(url).then(
            () => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            },
            () => undefined,
          );
        }}
      >
        {copied ? "Copiado" : "Copiar"}
      </button>
    </div>
  );
}
