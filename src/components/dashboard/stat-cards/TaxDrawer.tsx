"use client";

interface TaxYear {
  year: number;
  gross: number;
  estimated_tax: number;
}

interface Props {
  data: {
    years: TaxYear[];
  };
}

const gbp = (n: number) => `£${Math.round(n).toLocaleString("en-GB")}`;

export default function TaxDrawer({ data }: Props) {
  if (data.years.length === 0) {
    return (
      <div className="text-xs text-slate-500 italic py-4 text-center">
        No data yet — wiring pending in next session.
      </div>
    );
  }

  const sorted = data.years.slice().sort((a, b) => b.year - a.year);

  return (
    <div className="text-sm text-slate-300 space-y-2">
      <table className="w-full text-xs border-collapse">
        <thead>
          <tr className="text-slate-500 border-b border-slate-700">
            <th className="text-left py-1 pr-2">Year</th>
            <th className="text-right py-1 pr-2">Gross</th>
            <th className="text-right py-1">Est. Tax</th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((y) => (
            <tr key={y.year} className="even:bg-slate-900/30">
              <td className="py-1 pr-2 font-medium text-slate-200">{y.year}</td>
              <td className="py-1 pr-2 text-right text-emerald-400">{gbp(y.gross)}</td>
              <td className="py-1 text-right text-amber-400">{gbp(y.estimated_tax)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
