"use client";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type Holiday } from "@/lib/api";
import {
  Button,
  Card,
  Empty,
  ErrorText,
  Modal,
  PageHeader,
  Select,
  TextField,
} from "@/components/admin/ui";

const REGIONS: { code: string; label: string }[] = [
  { code: "ES-AN", label: "Andalucía" },
  { code: "ES-AR", label: "Aragón" },
  { code: "ES-AS", label: "Asturias" },
  { code: "ES-CB", label: "Cantabria" },
  { code: "ES-CE", label: "Ceuta" },
  { code: "ES-CL", label: "Castilla y León" },
  { code: "ES-CM", label: "Castilla-La Mancha" },
  { code: "ES-CN", label: "Canarias" },
  { code: "ES-CT", label: "Cataluña" },
  { code: "ES-EX", label: "Extremadura" },
  { code: "ES-GA", label: "Galicia" },
  { code: "ES-IB", label: "Islas Baleares" },
  { code: "ES-LO", label: "La Rioja" },
  { code: "ES-MC", label: "Murcia" },
  { code: "ES-MD", label: "Madrid" },
  { code: "ES-ML", label: "Melilla" },
  { code: "ES-NC", label: "Navarra" },
  { code: "ES-PV", label: "País Vasco" },
  { code: "ES-VC", label: "Comunidad Valenciana" },
];

const SOURCE_LABEL: Record<string, string> = {
  national: "Nacional",
  regional: "Autonómico",
  custom: "Personalizado",
};

export default function HolidaysPage() {
  const qc = useQueryClient();
  const me = useQuery({ queryKey: ["me"], queryFn: api.me });
  const [year, setYear] = useState<number>(new Date().getFullYear());
  const [region, setRegion] = useState<string>(
    me.data?.current_tenant.region_code ?? "ES-MD",
  );
  const [adding, setAdding] = useState(false);

  const list = useQuery({
    queryKey: ["holidays", year],
    queryFn: () => api.listHolidays(year),
  });

  const importMut = useMutation({
    mutationFn: () =>
      api.importHolidays({ country_code: "ES", region_code: region, year }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["holidays", year] }),
  });

  const del = useMutation({
    mutationFn: (id: number) => api.deleteHoliday(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["holidays", year] }),
  });

  return (
    <>
      <PageHeader
        title="Festivos"
        action={
          <div className="flex gap-2">
            <Button variant="secondary" onClick={() => setAdding(true)}>
              Añadir festivo
            </Button>
            <Button
              onClick={() => importMut.mutate()}
              disabled={importMut.isPending}
            >
              {importMut.isPending ? "Importando…" : "Importar festivos"}
            </Button>
          </div>
        }
      />
      <div className="mb-4 flex items-end gap-3">
        <div className="w-32">
          <TextField
            label="Año"
            type="number"
            value={String(year)}
            onChange={(v) => setYear(Number(v) || year)}
          />
        </div>
        <div className="w-72">
          <Select
            label="Comunidad autónoma"
            value={region}
            onChange={(v) => setRegion(v as string)}
            options={[
              { value: "", label: "— Sin región —" },
              ...REGIONS.map((r) => ({ value: r.code, label: r.label })),
            ]}
          />
        </div>
      </div>
      {importMut.isSuccess && (
        <p className="mb-3 text-sm text-green-700">
          Importados: {importMut.data.inserted} · Omitidos:{" "}
          {importMut.data.skipped}
        </p>
      )}
      {importMut.isError && (
        <ErrorText>{(importMut.error as Error).message}</ErrorText>
      )}

      {list.isLoading && <p className="text-sm text-gray-500">Cargando…</p>}
      {list.data && list.data.length === 0 && (
        <Empty>No hay festivos para {year}.</Empty>
      )}
      {list.data && list.data.length > 0 && (
        <Card>
          <table className="w-full text-sm">
            <thead className="border-b border-gray-200 bg-gray-50 text-left text-[11px] font-semibold uppercase tracking-wide text-gray-500">
              <tr>
                <th className="px-4 py-2 font-medium">Fecha</th>
                <th className="px-4 py-2 font-medium">Nombre</th>
                <th className="px-4 py-2 font-medium">Origen</th>
                <th className="px-4 py-2 font-medium">Región</th>
                <th className="px-4 py-2 font-medium text-right">Acciones</th>
              </tr>
            </thead>
            <tbody>
              {list.data.map((h: Holiday) => (
                <tr key={h.id} className="border-b border-gray-100 last:border-b-0 hover:bg-gray-50/60 transition-colors">
                  <td className="px-4 py-2">{h.date}</td>
                  <td className="px-4 py-2">{h.name}</td>
                  <td className="px-4 py-2 text-gray-600">
                    {SOURCE_LABEL[h.source] ?? h.source}
                  </td>
                  <td className="px-4 py-2 text-gray-600">
                    {h.region_code ?? "—"}
                  </td>
                  <td className="px-4 py-2 text-right">
                    <Button
                      variant="danger"
                      onClick={() => del.mutate(h.id)}
                      disabled={del.isPending}
                    >
                      Eliminar
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}

      {adding && (
        <AddHolidayModal
          onClose={() => setAdding(false)}
          year={year}
        />
      )}
    </>
  );
}

function AddHolidayModal({
  onClose,
  year,
}: {
  onClose: () => void;
  year: number;
}) {
  const qc = useQueryClient();
  const [date, setDate] = useState(`${year}-01-01`);
  const [name, setName] = useState("");
  const create = useMutation({
    mutationFn: () =>
      api.createHoliday({ date, name, source: "custom" }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["holidays"] });
      onClose();
    },
  });
  return (
    <Modal open={true} onClose={onClose} title="Añadir festivo">
      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          create.mutate();
        }}
      >
        <TextField label="Fecha" type="date" value={date} onChange={setDate} />
        <TextField label="Nombre" value={name} onChange={setName} />
        {create.isError && (
          <ErrorText>{(create.error as Error).message}</ErrorText>
        )}
        <div className="flex justify-end gap-2 pt-1">
          <Button variant="secondary" onClick={onClose}>
            Cancelar
          </Button>
          <Button type="submit" disabled={!name || create.isPending}>
            {create.isPending ? "Guardando…" : "Guardar"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
