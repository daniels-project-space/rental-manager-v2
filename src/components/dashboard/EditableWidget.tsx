"use client";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { useEditMode } from "@/lib/dashboard/edit-mode-context";

type Props = {
  id: string;
  kind: "panel" | "stat";
  label: string;
  className?: string;
  children: React.ReactNode;
};

export function EditableWidget({ id, kind, label, className, children }: Props) {
  const { editMode, togglePanel, toggleStat } = useEditMode();
  const sortable = useSortable({ id, disabled: !editMode });
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = sortable;

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
    position: "relative",
  };

  const handleDelete = () => {
    if (kind === "panel") togglePanel(id);
    else toggleStat(id);
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      data-widget-id={id}
      className={[
        "editable-widget",
        editMode ? "rounded-2xl ring-2 ring-dashed ring-blue-400/50 transition-shadow" : "",
        className ?? "",
      ].filter(Boolean).join(" ")}
    >
      {editMode && (
        <>
          <button
            type="button"
            {...attributes}
            {...listeners}
            className="absolute z-20 top-2 left-2 rounded-md bg-slate-900/85 backdrop-blur px-1.5 py-0.5 text-slate-300 hover:text-white hover:bg-blue-500/30 cursor-grab active:cursor-grabbing border border-white/10"
            title={`Drag to reorder — ${label}`}
            aria-label={`Drag handle for ${label}`}
          >
            ⋮⋮
          </button>
          <button
            type="button"
            onClick={handleDelete}
            className="absolute z-20 top-2 right-2 rounded-md bg-red-500/90 hover:bg-red-500 text-white text-sm w-7 h-7 inline-flex items-center justify-center shadow-lg"
            title={`Hide ${label}`}
            aria-label={`Hide ${label}`}
          >
            ×
          </button>
        </>
      )}
      {children}
    </div>
  );
}
