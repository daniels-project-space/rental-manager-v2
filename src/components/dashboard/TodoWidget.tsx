"use client";
import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
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
  const [mounted, setMounted] = useState(false);
  const [draft, setDraft] = useState("");
  useEffect(() => {
    setMounted(true);
  }, []);

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

  const inner = (
    <>
      {/* Header */}
      <div className="flex flex-shrink-0 items-center justify-between gap-2 border-b border-white/5 px-3 py-2">
        <h2 className="flex items-center gap-1.5 text-sm font-semibold text-[#e4e6eb]">
          <span className="text-[15px] leading-none">📋</span> To Do List
        </h2>
        <div className="flex items-center gap-2">
          {openCount > 0 && (
            <span className="rounded-full bg-blue-500/15 px-1.5 py-0.5 text-[10px] font-semibold text-blue-300">
              {openCount}
            </span>
          )}
          <button
            type="button"
            onClick={() => setExpanded((x) => !x)}
            title={expanded ? "Collapse" : "Expand"}
            aria-label={expanded ? "Collapse to-do list" : "Expand to-do list"}
            className="flex h-6 w-6 items-center justify-center rounded-md border border-white/10 bg-white/5 text-[12px] leading-none text-slate-300 transition-colors hover:bg-white/10 hover:text-white"
          >
            {expanded ? "✕" : "⤢"}
          </button>
        </div>
      </div>

      {/* List tabs */}
      <div className="flex flex-shrink-0 items-center gap-1 overflow-x-auto px-3 py-1.5">
        {lists.map((l) => (
          <button
            key={l._id}
            type="button"
            onClick={() => setActiveId(l._id)}
            className={`flex-shrink-0 rounded-full px-2.5 py-0.5 text-[11px] font-medium transition-colors ${
              active?._id === l._id
                ? "bg-blue-500/20 text-blue-200 ring-1 ring-blue-500/40"
                : "bg-white/5 text-slate-400 hover:bg-white/10 hover:text-slate-200"
            }`}
          >
            {l.name}
          </button>
        ))}
        <button
          type="button"
          onClick={handleNewList}
          title="New list"
          aria-label="New list"
          className="flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-full bg-white/5 text-[13px] font-bold leading-none text-slate-400 transition-colors hover:bg-white/10 hover:text-white"
        >
          +
        </button>
      </div>

      {/* Items — scrollable */}
      <div className="min-h-0 flex-1 space-y-0.5 overflow-y-auto px-2 py-0.5">
        {active && active.items.length > 0 ? (
          active.items.map((it) => (
            <label
              key={it.id}
              className="group flex cursor-pointer items-center gap-2 rounded-md px-1.5 py-1 text-[12px] hover:bg-white/5"
            >
              <input
                type="checkbox"
                checked={it.done}
                onChange={() => toggleItem({ listId: active._id, itemId: it.id })}
                className="h-3.5 w-3.5 flex-shrink-0 accent-blue-500"
              />
              <span className={`flex-1 truncate ${it.done ? "text-slate-600 line-through" : "text-slate-200"}`}>
                {it.text}
              </span>
              <button
                type="button"
                onClick={(e) => {
                  e.preventDefault();
                  void removeItem({ listId: active._id, itemId: it.id });
                }}
                className="flex-shrink-0 text-slate-600 opacity-0 transition-opacity hover:text-red-400 group-hover:opacity-100"
                title="Remove"
              >
                ✕
              </button>
            </label>
          ))
        ) : (
          <p className="px-1.5 py-2 text-[11px] text-slate-500">
            {lists.length === 0 ? "No lists yet — tap + to create one." : "Nothing here yet."}
          </p>
        )}
      </div>

      {/* Add item */}
      {active && (
        <form
          onSubmit={handleSubmit}
          className="flex flex-shrink-0 items-center gap-1.5 border-t border-white/5 px-2 py-2"
        >
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="Add an item…"
            className="min-w-0 flex-1 rounded-lg border border-white/10 bg-white/5 px-2 py-1 text-[12px] text-slate-100 outline-none placeholder:text-slate-500 focus:border-blue-500/40"
          />
          <button
            type="submit"
            disabled={!draft.trim()}
            className="flex-shrink-0 rounded-lg bg-blue-500/20 px-2.5 py-1 text-[12px] font-medium text-blue-200 ring-1 ring-blue-500/40 transition-colors hover:bg-blue-500/30 disabled:opacity-40"
          >
            Add
          </button>
        </form>
      )}

      {expanded && active && lists.length > 0 && (
        <button
          type="button"
          onClick={() => {
            if (window.confirm(`Delete list "${active.name}"?`)) {
              void deleteList({ id: active._id });
              setActiveId(null);
            }
          }}
          className="flex-shrink-0 px-3 py-1.5 text-left text-[10px] text-slate-600 transition-colors hover:text-red-400"
        >
          Delete this list
        </button>
      )}
    </>
  );

  return (
    <>
      {!expanded && (
        <div className="stat-card flex h-[150px] w-full flex-col overflow-hidden p-0">{inner}</div>
      )}

      {expanded &&
        mounted &&
        createPortal(
          <div
            className="fixed inset-0 z-[100] flex items-center justify-center p-4"
            onClick={() => setExpanded(false)}
          >
            <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" />
            <div
              className="relative z-10 flex h-[min(560px,86vh)] w-[min(420px,94vw)] flex-col overflow-hidden rounded-xl border border-white/10 bg-[#0e111c] shadow-2xl"
              onClick={(e) => e.stopPropagation()}
            >
              {inner}
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}
