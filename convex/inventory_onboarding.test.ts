/* eslint-disable @typescript-eslint/no-explicit-any -- The generic Convex test adapter accepts varied table fixtures. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./auth', () => ({ authComponent: { safeGetAuthUser: vi.fn() } }));
vi.mock('./owner_functions', async () => {
  const actual = await vi.importActual<any>('./owner_functions');
  return { ...actual, requireOwner: vi.fn(async () => undefined) };
});

import { requireOwner } from './owner_functions';
import { create, saveDraft, recentDrafts, registerListing, confirmAvailability, retryPropagation, refreshConsumers, setPropagationResult } from './inventory_onboarding';
import { __service_catalogueForStorefront } from './hygglo_products';
import { lookup } from './walle_inventory';
import { loadStockSources, stockForItem } from './lib/renter_stock';

function database(seed: Record<string, any[]> = {}) {
  const tables: Record<string, any[]> = Object.fromEntries(Object.entries(seed).map(([k, v]) => [k, [...v]]));
  let nextId = 0;
  const db = {
    query(table: string) {
      const rows = tables[table] ?? (tables[table] = []);
      const q: any = {
        withIndex: (_index: string, constrain?: (builder: any) => void) => {
          const filters: Array<(row: any) => boolean> = [];
          const builder = { eq: (field: string, value: any) => { filters.push(row => row[field] === value); return builder; }, gte: (field: string, value: any) => { filters.push(row => row[field] >= value); return builder; } };
          constrain?.(builder);
          q.current = () => rows.filter(row => filters.every(filter => filter(row)));
          return q;
        },
        current: () => rows,
        collect: async () => q.current(),
        first: async () => q.current()[0] ?? null,
        unique: async () => { const found = q.current(); if (found.length > 1) throw new Error('Expected unique row'); return found[0] ?? null; },
        take: async (n: number) => q.current().slice(0, n),
        order: () => q,
      };
      return q;
    },
    async insert(table: string, value: any) {
      const row = { ...value, _id: `${table}_${++nextId}`, _creationTime: Date.now() };
      (tables[table] ??= []).push(row);
      return row._id;
    },
    async patch(id: string, patch: any) {
      const row = Object.values(tables).flat().find(x => x._id === id);
      if (!row) throw new Error(`Missing row ${id}`);
      for (const [key, value] of Object.entries(patch)) {
        if (value === undefined) delete row[key];
        else row[key] = value;
      }
    },
    async delete(id: string) { for (const rows of Object.values(tables)) { const index = rows.findIndex(row => row._id === id); if (index >= 0) rows.splice(index, 1); } },
    async get(id: string) { return Object.values(tables).flat().find(row => row._id === id) ?? null; },
  };
  return { tables, db };
}

const args = (extra: Record<string, unknown> = {}) => ({
  request_key: 'intake-1', name: 'Sony FX3', exact_model: 'Sony FX3', kind: 'camera_body', quantity: 2,
  ownership: 'owned' as const, serials: ['SERIAL-A'], missing_serial_reasons: ['Unit label missing; verify before listing'],
  specifications: 'Owner-entered: exact model confirmed; technical details otherwise unknown',
  compatibility_note: 'Unknown; verify before making fit claims', included_accessories: 'None confirmed',
  compatible_accessory_ids: [], target_account_slugs: ['leo', 'dbcinema'], details_confirmed: true,
  owner_name: 'DB Cinema Rentals Ltd', acquisition_date: '2025-05-04', purchase_price_gbp: 3200,
  purchase_value_basis: 'per_unit' as const, replacement_value_gbp: 3500, replacement_value_basis: 'per_unit' as const,
  vat_basis: 'to_confirm' as const, valuation_source: 'Supplier quote', valuation_date: '2026-09-01',
  requested_cover_date: '2026-10-15', ...extra,
});
const invoke = (fn: any, ctx: any, input: any) => fn._handler(ctx, input);
const emptyTables = () => ({ accounts: [{ _id: 'account-leo', slug: 'leo', display_name: 'Leo' }, { _id: 'account-dbc', slug: 'dbcinema', display_name: 'DB Cinema' }], items: [], reservations: [], hygglo_products: [], online_listings: [],
  listing_resolution_override: [], hygglo_product_index: [], insurance_claims: [], owner_unavailability: [], vacation_periods: [], item_specs: [] });

beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.restoreAllMocks());

describe('Walle inventory onboarding', () => {
  it('requires an owner gate, validates physical-unit counts, writes one unit ledger and makes duplicate submissions idempotent', async () => {
    const { db, tables } = database(emptyTables());
    const ctx = { db, scheduler: { runAfter: vi.fn() } };
    await expect(invoke(create, ctx, args({ serials: ['SERIAL-A'], missing_serial_reasons: [] }))).rejects.toThrow('equal physical quantity');
    expect(tables.items).toHaveLength(0);
    const first = await invoke(create, ctx, args());
    expect(requireOwner).toHaveBeenCalledWith(ctx, true);
    expect(first).toMatchObject({ repeated: false, insurance_status: 'needs_details' });
    expect(tables.items[0]).toMatchObject({ qty: 2, status: 'active', is_marketing_only: false, acquisition_cost_gbp: 3200, replacement_cost_gbp: 3500 });
    expect(tables.inventory_unit_serials.map(x => [x.unit_number, x.serial, x.exception_reason])).toEqual([
      [1, 'SERIAL-A', undefined], [2, undefined, 'Unit label missing; verify before listing'],
    ]);
    const again = await invoke(create, ctx, args());
    expect(again).toMatchObject({ repeated: true, item_id: first.item_id });
    expect(tables.items).toHaveLength(1);
    expect(tables.audit_log).toHaveLength(1);
  });

  it('rejects duplicate serials and duplicate master items, and keeps hired-in and marketing stock unbookable', async () => {
    const { db, tables } = database(emptyTables());
    const ctx = { db, scheduler: { runAfter: vi.fn() } };
    await expect(invoke(create, ctx, args({ serials: ['same', 'SAME'], missing_serial_reasons: [] }))).rejects.toThrow('Duplicate serial within this intake');
    const owned = await invoke(create, ctx, args());
    await expect(invoke(create, ctx, args({ request_key: 'new-key', serials: ['SERIAL-B', 'SERIAL-C'], missing_serial_reasons: [] }))).rejects.toThrow('Existing master item');
    const hired = await invoke(create, ctx, args({ request_key: 'hired', name: 'Canon C70', exact_model: 'Canon C70', ownership: 'hired_in', owner_name: 'Rental supplier', serials: [], missing_serial_reasons: ['Supplier serial not provided', 'Supplier serial not provided'] }));
    expect(tables.items.find(x => x._id === hired.item_id)).toMatchObject({ qty: 0, status: 'inactive', is_marketing_only: true });
    const marketing = await invoke(create, ctx, args({ request_key: 'market', name: 'Sony Venice listing', exact_model: 'Sony Venice listing', ownership: 'marketing_only', quantity: 0, serials: [], missing_serial_reasons: [], owner_name: undefined, target_account_slugs: [] }));
    expect(tables.items.find(x => x._id === marketing.item_id)).toMatchObject({ qty: 0, status: 'marketing_only', is_marketing_only: true });
    expect(tables.items.find(x => x._id === owned.item_id).qty).toBe(2);
  });

  it('persists an interrupted draft without creating stock', async () => {
    const { db, tables } = database(emptyTables());
    const ctx = { db };
    const form = { name: 'Sony FX3', exact_model: '', kind: '', quantity: '2', ownership: 'owned' as const,
      serials: 'SERIAL-A', missing_serial_reasons: 'Need supplier confirmation', specifications: '', compatibility_note: '',
      included_accessories: '', lens_mount: '', owner_name: '', acquisition_date: '', purchase_price_gbp: '',
      purchase_value_basis: '', replacement_value_gbp: '', replacement_value_basis: '', vat_basis: 'to_confirm',
      valuation_source: '', valuation_date: '', requested_cover_date: '' };
    await invoke(saveDraft, ctx, { request_key: 'unfinished-1', form, compatible_accessory_ids: [], target_account_slugs: [] });
    const [draft] = await invoke(recentDrafts, ctx, {});
    expect(draft).toMatchObject({ request_key: 'unfinished-1', form: { name: 'Sony FX3', exact_model: '' } });
    expect(tables.items).toHaveLength(0);
  });

  it('registers exact published listings across accounts to one shared stock pool and feeds DB Cinema the same quantities', async () => {
    const seed: Record<string, any[]> = emptyTables();
    seed.items.push({ _id: 'battery', name_canonical: 'NP-FZ100 battery', status: 'active', is_marketing_only: false, qty: 6 });
    const { db, tables } = database(seed);
    const ctx = { db, scheduler: { runAfter: vi.fn() } };
    const intake = await invoke(create, ctx, args());
    const urls = { leo: 'https://hygglo.com/i/sony-fx3-leo', dbcinema: 'https://hygglo.com/i/sony-fx3-dbcinema' };
    for (const slug of ['leo', 'dbcinema']) tables.hygglo_products.push({ _id: `product-${slug}`, accountSlug: slug, productId: slug === 'leo' ? 101 : 202,
      name: 'Sony FX3', masterItemId: undefined, isPublished: true, isMarketingOnly: false, listings: [{ publicUrl: urls[slug as keyof typeof urls] }] });
    tables.hygglo_products[0].isPublished = false;
    await expect(invoke(registerListing, ctx, { item_id: intake.item_id, account_slug: 'leo', product_id: 101, public_url: urls.leo })).rejects.toThrow('never publishes');
    tables.hygglo_products[0].isPublished = true;
    await expect(invoke(registerListing, ctx, { item_id: intake.item_id, account_slug: 'leo', product_id: 101, public_url: 'https://hygglo.com/i/wrong' })).rejects.toThrow('does not match');
    for (const [slug, product_id] of [['leo', 101], ['dbcinema', 202]] as const)
      await invoke(registerListing, ctx, { item_id: intake.item_id, account_slug: slug, product_id, public_url: urls[slug],
        stock_components: [{ item_id: intake.item_id, qty: 1 }, { item_id: 'battery', qty: 2 }] });
    expect(tables.items.find(x => x._id === intake.item_id).qty).toBe(2);
    expect(tables.listing_resolution_override.map(x => [x.account_slug, x.stock_item_id, x.components])).toEqual([
      ['leo', intake.item_id, [{ item_id: intake.item_id, qty: 1 }, { item_id: 'battery', qty: 2 }]],
      ['dbcinema', intake.item_id, [{ item_id: intake.item_id, qty: 1 }, { item_id: 'battery', qty: 2 }]],
    ]);
    const [storefront] = await invoke(__service_catalogueForStorefront, ctx, { accountSlug: 'dbcinema' });
    expect(storefront.stockMapping).toMatchObject({ complete: true, owned: true, components: [
      { masterItemId: intake.item_id, qty: 1, quantityOwned: 2, active: true },
      { masterItemId: 'battery', qty: 2, quantityOwned: 6, active: true },
    ] });
    expect(tables.items.find(x => x._id === intake.item_id).qty).toBe(2);
    tables.reservations.push(
      { _id: 'booking-leo', account_slug: 'leo', status: 'confirmed', order_step: 'BOOKED', start_date: '2030-01-03', end_date: '2030-01-03', hygglo_order_id: 'leo-1', renter_name: 'Leo renter', hygglo_items: [{ product_id: 101, qty: 1 }] },
      { _id: 'booking-dbc', account_slug: 'dbcinema', status: 'confirmed', order_step: 'BOOKED', start_date: '2030-01-03', end_date: '2030-01-03', hygglo_order_id: 'dbc-1', renter_name: 'DBC renter', hygglo_items: [{ product_id: 202, qty: 1 }] },
    );
    const shared = await loadStockSources(ctx as any);
    expect(shared.reservationUnits?.get('booking-leo')).toEqual(new Map([[intake.item_id, 1], ['battery', 2]]));
    expect(shared.reservationUnits?.get('booking-dbc')).toEqual(new Map([[intake.item_id, 1], ['battery', 2]]));
    expect(stockForItem(shared, tables.items.find(x => x._id === intake.item_id), { item_name: 'Sony FX3', start_date: '2030-01-03', end_date: '2030-01-03', quantity: 1 } as any)).toMatchObject({ available: false, free_units: 0 });
  });

  it('shows the committed item to WallE, calendar stock reads and live availability checks', async () => {
    const { db, tables } = database(emptyTables());
    const ctx = { db, scheduler: { runAfter: vi.fn() } };
    const created = await invoke(create, ctx, args({ target_account_slugs: [] }));
    const bot = await invoke(lookup, ctx, { query: 'Sony FX3' });
    expect(bot.matches[0]).toMatchObject({ name: 'Sony FX3', qty: 2, is_marketing_only: false, lens_mount: null });
    const stock = await loadStockSources(ctx as any);
    const item = tables.items[0];
    const result = stockForItem(stock, item, { item_name: item.name_canonical, start_date: '2030-01-01', end_date: '2030-01-01', quantity: 1 } as any);
    expect(result).toMatchObject({ owned: true, total_units: 2, free_units: 2 });
    const confirmation = await invoke(confirmAvailability, ctx, { item_id: created.item_id });
    expect(confirmation).toMatchObject({ confirmed: true, bookable_quantity: 2 });
    expect(tables.inventory_intakes[0].availability_confirmed_at).toBeTypeOf('number');
  });

  it('reports partial consumer refreshes and prevents overlapping retry requests', async () => {
    const { db, tables } = database(emptyTables());
    const ctx = { db, scheduler: { runAfter: vi.fn() } };
    const item = await invoke(create, ctx, args({ target_account_slugs: [] }));
    const actions = vi.fn().mockResolvedValueOnce({ results: [{ name: 'out-of-stock', ok: false, error: 'cache unavailable' }] })
      .mockRejectedValueOnce(new Error('timeout'));
    const mutations = vi.fn().mockResolvedValue({ saved: true });
    const result = await invoke(refreshConsumers, { runAction: actions, runMutation: mutations }, { item_id: item.item_id, attempt: 1 });
    expect(result.status).toBe('partial');
    expect(mutations.mock.calls[0][1]).toMatchObject({ status: 'partial', item_id: item.item_id, attempt: 1 });
    tables.inventory_intakes[0].propagation_status = 'pending';
    await expect(invoke(retryPropagation, ctx, { item_id: item.item_id })).rejects.toThrow('still running');
    tables.inventory_intakes[0].propagation_updated_at = Date.now() - 11 * 60 * 1000;
    await expect(invoke(retryPropagation, ctx, { item_id: item.item_id })).resolves.toMatchObject({ status: 'pending', attempt: 2 });
    expect(ctx.scheduler.runAfter).toHaveBeenCalledTimes(2);
    await expect(invoke(setPropagationResult, ctx, { item_id: item.item_id, attempt: 1, status: 'complete' })).resolves.toMatchObject({ saved: false, stale: true });
    expect(tables.inventory_intakes[0].propagation_status).toBe('pending');
  });
});
