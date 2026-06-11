"use client";
import { useMemo, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import type { Id } from "../../../convex/_generated/dataModel";
import { api } from "../../../convex/_generated/api";

type TodoItem = { id: string; text: string; done: boolean };
type TodoList = { _id: Id<"todo_lists">; name: string; items: TodoItem[] };

export default function TodoWidget() {
  const lists = (useQuery(api.todos.listAll) ?? []) as TodoList[];
  const createList = useMutation(api.todos.createList);
  const deleteList = useMutation(api.todos.deleteList);
  const addItem = useMutation(api.todos.addItem);
  const toggleItem = useMutation(api.todos.toggleItem);
  const removeItem = useMutation(api.todos.removeItem);

  const [activeId, setActiveId] = useState<Id<"todo_lists"> | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [draft, setDraft] = useState("");

  const active = useMemo(
    () => lists.find((l) => l._id === activeId) ?? lists[0],
    [lists, activeId],
  );
  const openCount = active?.items.filter((i) => !i.done).length ?? 0;

  async function handleNewList() {
    const name = window.prompt("New list name:", "");
    if (!name || !name.trim()) return;
    const id = await createList({ name: name.trim() });
    setActiveId(id as Id<"todo_lists">);
  }
  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!active || !draft.trim()) return;
    await addItem({ listId: active._id, text: draft.trim() });
    setDraft("");
  }

  const body = (
    <>
      <div className="flex flex-wrap items-center gap-1 mb-2">
        {lists.map((l) => (
          <button
            key={l._id}
            onClick={() => setActiveId(l._id)}
            className={`px-2 py-0.5 rounded text-[11px] font-medium border ${
              active?._id === l._id
                ? "bg-blue-500/20 border-blue-500/40 text-blue-200"
                : "bg-white/5 border-white/10 text-slate-300 hover:bg-white/10"
            }`}
          >
            {l.name}
          </button>
        ))}
        <button
          onClick={handleNewList}
          title="New list"
          className="px-1.5 py-0.5 rounded text-[12px] font-bold bg-white/5 border border-white/10 text-slate-300 hover:bg-white/10 hover:text-white"
        >
          +
        </button>
        {expanded && active && lists.length > 0 && (
          <button
            onClick={() => {
              if (window.confirm(`Delete list "${active.name}"?`)) {
                void deleteList({ id: active._id });
                setActiveId(null);
              }
            }}
            title="Delete this list"
            className="ml-auto px-1.5 py-0.5 rounded text-[11px] text-slate-500 hover:text-red-400"
          >
            Delete
          </button>
        )}
      </div>

      <div className={expanded ? "flex-1 min-h-0 overflow-y-auto space-y-1 pr-1" : "space-y-1 max-h-[84px] overflow-y-auto pr-1"}>
        {active && active.items.length > 0 ? (
          active.items.map((it) => (
            <div key={it.id} className="group flex items-center gap-2 text-[12px]">
              <input
                type="checkbox"
                checked={it.done}
                onChange={() => toggleItem({ listId: active._id, itemId: it.id })}
                className="accent-blue-500 flex-shrink-0"
              />
              <span className={`flex-1 truncate ${it.done ? "line-through text-slate-500" : "text-slate-200"}`}>
                {it.text}
              </span>
              <button
                onClick={() => removeItem({ listId: active._id, itemId: it.id })}
                className="opacity-0 group-hover:opacity-100 text-slate-500 hover:text-red-400 text-xs flex-shrink-0"
                title="Remove"
              >
                &times;
              </button>
            </div>
          ))
        ) : (
          <p className="text-[11px] text-slate-500 py-1">
            {lists.length === 0 ? "No lists yet — click + to create one." : "No items yet."}
          </p>
        )}
      </div>

      {active && (
        <form onSubmit={handleSubmit} className="mt-2 flex items-center gap-1">
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="Add an item…"
            className="flex-1 text-[12px] rounded-lg px-2 py-1 bg-white/5 border border-white/10 text-slate-100 placeholder:text-slate-500 outline-none focus:border-blue-500/40"
          />
          <button
            type="submit"
            disabled={!draft.trim()}
            className="px-2 py-1 rounded-lg text-[12px] bg-blue-500/20 border border-blue-500/40 text-blue-200 disabled:opacity-40"
          >
            Add
          </button>
        </form>
      )}
    </>
  );

  return (
    <>
      {expanded && (
        <div className="fixed inset-0 z-[55] bg-black/55 backdrop-blur-sm" onClick={() => setExpanded(false)} />
      )}
      <div
        className={
          expanded
            ? "fixed z-[60] bottom-4 right-4 flex h-[520px] max-h-[85vh] w-[380px] max-w-[92vw] flex-col rounded-xl bg-[#0e111c] border border-white/10 p-3 shadow-2xl"
            : "stat-card w-full flex flex-col p-3"
        }
      >
        <div className="flex items-center justify-between mb-2">
          <div className="min-w-0">
            <h2 className="text-sm font-semibold text-[#e4e6eb] truncate">{active?.name ?? "To-Do"}</h2>
            <span className="text-[10px] text-slate-500">
              {openCount} open · {lists.length} list{lists.length === 1 ? "" : "s"}
            </span>
          </div>
          <button
            onClick={() => setExpanded((x) => !x)}
            title={expanded ? "Collapse" : "Expand"}
            aria-label={expanded ? "Collapse to-do" : "Expand to-do"}
            className="flex-shrink-0 flex h-6 w-6 items-center justify-center rounded-md border border-white/10 bg-white/10 text-[13px] leading-none text-slate-200 hover:bg-white/20 hover:text-white"
          >
            {expanded ? "✕" : "⤢"}
          </button>
        </div>
        {body}
      </div>
    </>
  );
}
