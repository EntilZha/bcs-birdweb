import { useState } from "react";

/**
 * The abundance grid editor.
 *
 * This is the reason the editor exists. Each species carries a 10 x 12 matrix of abundance
 * codes, and hand-editing that in YAML is both miserable and easy to get subtly wrong --
 * one dropped cell shifts a whole year. Here it is a grid you click: pick a code, paint
 * cells, done.
 */

const CODES = ["C", "F", "U", "R", "I", ""] as const;
type Code = (typeof CODES)[number];

const LABEL: Record<Code, string> = {
  C: "Common",
  F: "Fairly common",
  U: "Uncommon",
  R: "Rare",
  I: "Irregular",
  "": "Not recorded",
};
const SWATCH: Record<Code, string> = {
  C: "bg-abundance-c text-white",
  F: "bg-abundance-f text-white",
  U: "bg-abundance-u text-brand",
  R: "bg-abundance-r text-brand",
  I: "bg-abundance-i text-brand",
  "": "bg-abundance-none text-ink-faint",
};

const MONTHS = ["J", "F", "M", "A", "M", "J", "J", "A", "S", "O", "N", "D"];
const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

interface Props {
  ecoregions: ReadonlyArray<{ slug: string; name: string }>;
  value: Record<string, string[]>;
  onChange: (next: Record<string, string[]>) => void;
}

export default function AbundanceEditor({ ecoregions, value, onChange }: Props) {
  const [brush, setBrush] = useState<Code>("C");
  // Drag to paint a run of months, which is how abundance actually gets entered: a bird
  // is present Apr-Aug, not in eight unrelated cells.
  const [painting, setPainting] = useState(false);

  function setCell(slug: string, month: number, code: Code) {
    const row = [...(value[slug] ?? Array(12).fill(""))];
    if (row[month] === code) return;
    row[month] = code;
    onChange({ ...value, [slug]: row });
  }

  function fillRow(slug: string, code: Code) {
    onChange({ ...value, [slug]: Array(12).fill(code) });
  }

  return (
    <div
      onPointerUp={() => setPainting(false)}
      onPointerLeave={() => setPainting(false)}
      className="select-none"
    >
      <div className="flex flex-wrap items-center gap-2 mb-3">
        <span className="text-xs font-semibold uppercase tracking-wide text-ink-muted">
          Paint with
        </span>
        {CODES.map((code) => (
          <button
            key={code || "none"}
            type="button"
            onClick={() => setBrush(code)}
            aria-pressed={brush === code}
            className={[
              "rounded-lg px-3 py-1.5 text-sm font-semibold transition",
              SWATCH[code],
              brush === code ? "ring-2 ring-brand ring-offset-1" : "opacity-80 hover:opacity-100",
            ].join(" ")}
          >
            {code || "—"} {LABEL[code]}
          </button>
        ))}
      </div>

      <div className="overflow-x-auto">
        <table className="border-separate border-spacing-0.5 text-xs">
          <thead>
            <tr>
              <th className="w-44" />
              {MONTHS.map((m, i) => (
                <th
                  key={i}
                  className="w-8 pb-1 font-semibold text-ink-muted"
                  title={MONTH_NAMES[i]}
                >
                  {m}
                </th>
              ))}
              <th className="pl-2" />
            </tr>
          </thead>
          <tbody>
            {ecoregions.map((eco) => {
              const row = value[eco.slug] ?? Array(12).fill("");
              return (
                <tr key={eco.slug}>
                  <th className="text-left font-medium text-ink pr-2 py-0.5">
                    {eco.name}
                  </th>
                  {row.map((code, month) => (
                    <td key={month}>
                      <button
                        type="button"
                        onPointerDown={() => {
                          setPainting(true);
                          setCell(eco.slug, month, brush);
                        }}
                        onPointerEnter={() => painting && setCell(eco.slug, month, brush)}
                        title={`${eco.name}, ${MONTH_NAMES[month]}: ${LABEL[(code || "") as Code]}`}
                        className={[
                          "h-8 w-8 rounded font-semibold transition",
                          SWATCH[(code || "") as Code],
                          "hover:ring-2 hover:ring-brand/40",
                        ].join(" ")}
                      >
                        {code || ""}
                      </button>
                    </td>
                  ))}
                  <td className="pl-2 whitespace-nowrap">
                    <button
                      type="button"
                      onClick={() => fillRow(eco.slug, brush)}
                      className="rounded px-2 py-1 text-[0.6875rem] text-ink-muted hover:bg-black/5 hover:text-brand"
                    >
                      fill row
                    </button>
                    <button
                      type="button"
                      onClick={() => fillRow(eco.slug, "")}
                      className="rounded px-2 py-1 text-[0.6875rem] text-ink-muted hover:bg-black/5 hover:text-brand"
                    >
                      clear
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="mt-2 text-xs text-ink-faint">
        Click a cell to set it, or drag across a row to paint a season.
      </p>
    </div>
  );
}
