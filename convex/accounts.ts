import { query } from "./_generated/server";

// W01 account selector — list all accounts with their profiles
export const list = query({
  args: {},
  handler: async (ctx) => {
    const accounts = await ctx.db.query("accounts").collect();
    return accounts;
  },
});

