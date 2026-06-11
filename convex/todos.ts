import { mutation, query } from "./_generated/server";
import { v } from "convex/values";

/** Owner personal to-do lists (e.g. "items to buy next"). Global, not account-scoped. */
export const listAll = query({
  args: {},
  handler: async (ctx) => {
    const lists = await ctx.db.query("todo_lists").collect();
    return lists.sort((a, b) => a.created_at - b.created_at);
  },
});

export const createList = mutation({
  args: { name: v.string() },
  handler: async (ctx, { name }) => {
    return await ctx.db.insert("todo_lists", {
      name: name.trim() || "Untitled",
      items: [],
      created_at: Date.now(),
    });
  },
});

export const renameList = mutation({
  args: { id: v.id("todo_lists"), name: v.string() },
  handler: async (ctx, { id, name }) => {
    await ctx.db.patch(id, { name: name.trim() || "Untitled" });
  },
});

export const deleteList = mutation({
  args: { id: v.id("todo_lists") },
  handler: async (ctx, { id }) => {
    await ctx.db.delete(id);
  },
});

export const addItem = mutation({
  args: { listId: v.id("todo_lists"), text: v.string() },
  handler: async (ctx, { listId, text }) => {
    const list = await ctx.db.get(listId);
    if (!list) return;
    const t = text.trim();
    if (!t) return;
    const id = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
    await ctx.db.patch(listId, { items: [...list.items, { id, text: t, done: false }] });
  },
});

export const toggleItem = mutation({
  args: { listId: v.id("todo_lists"), itemId: v.string() },
  handler: async (ctx, { listId, itemId }) => {
    const list = await ctx.db.get(listId);
    if (!list) return;
    await ctx.db.patch(listId, {
      items: list.items.map((i) => (i.id === itemId ? { ...i, done: !i.done } : i)),
    });
  },
});

export const removeItem = mutation({
  args: { listId: v.id("todo_lists"), itemId: v.string() },
  handler: async (ctx, { listId, itemId }) => {
    const list = await ctx.db.get(listId);
    if (!list) return;
    await ctx.db.patch(listId, { items: list.items.filter((i) => i.id !== itemId) });
  },
});
