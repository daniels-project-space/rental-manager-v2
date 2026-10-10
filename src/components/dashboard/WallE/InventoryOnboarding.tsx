'use client';

import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery } from 'convex/react';
import { makeFunctionReference } from 'convex/server';
import type { Id } from '../../../../convex/_generated/dataModel';

const createRef = makeFunctionReference<'mutation'>('inventory_onboarding:create');
const saveDraftRef = makeFunctionReference<'mutation'>('inventory_onboarding:saveDraft');
const draftRef = makeFunctionReference<'query'>('inventory_onboarding:recentDrafts');
const accountsRef = makeFunctionReference<'query'>('inventory_onboarding:accounts');
const registerRef = makeFunctionReference<'mutation'>('inventory_onboarding:registerListing');
const updateTargetsRef = makeFunctionReference<'mutation'>('inventory_onboarding:updateListingTargets');
const availabilityRef = makeFunctionReference<'mutation'>('inventory_onboarding:confirmAvailability');
const detailRef = makeFunctionReference<'query'>('inventory_onboarding:get');
const recentRef = makeFunctionReference<'query'>('inventory_onboarding:recent');
const choicesRef = makeFunctionReference<'query'>('inventory_onboarding:accessoryChoices');
const updateRef = makeFunctionReference<'mutation'>('inventory_onboarding:updateInsuranceDetails');
const progressRef = makeFunctionReference<'mutation'>('inventory_onboarding:recordInsuranceProgress');
const retryRef = makeFunctionReference<'mutation'>('inventory_onboarding:retryPropagation');

type Ownership = 'owned' | 'hired_in' | 'marketing_only';
type Form = {
  name: string; exact_model: string; kind: string; quantity: string; ownership: Ownership;
  serials: string; missing_serial_reasons: string; specifications: string; compatibility_note: string;
  included_accessories: string; lens_mount: string; owner_name: string; acquisition_date: string;
  purchase_price_gbp: string; purchase_value_basis: string; replacement_value_gbp: string;
  replacement_value_basis: string; vat_basis: string; valuation_source: string; valuation_date: string;
  requested_cover_date: string;
};
const blank: Form = {
  name: '', exact_model: '', kind: '', quantity: '1', ownership: 'owned', serials: '',
  missing_serial_reasons: '', specifications: '', compatibility_note: '', included_accessories: '',
  lens_mount: '', owner_name: '', acquisition_date: '', purchase_price_gbp: '', purchase_value_basis: '',
  replacement_value_gbp: '', replacement_value_basis: '', vat_basis: 'to_confirm', valuation_source: '',
  valuation_date: '', requested_cover_date: '',
};
const lines = (s: string) => s.split(/\r?\n/).map(x => x.trim()).filter(Boolean);
const optionalMoney = (s: string) => s.trim() ? Number(s) : undefined;
const optional = (s: string) => s.trim() || undefined;
const inputClass = 'w-full rounded-md border border-white/15 bg-zinc-900 px-2 py-1.5 text-sm text-white';
const labelClass = 'block space-y-1 text-xs text-zinc-300';
const buttonClass = 'rounded-md border border-indigo-400/30 bg-indigo-500/20 px-3 py-1.5 text-sm text-indigo-100 hover:bg-indigo-500/35 disabled:opacity-40';
type Intake = {
  item_name: string; exact_model: string; specifications: string; physical_quantity: number;
  serials: string[]; missing_serial_count: number; missing_serial_reasons: string[];
  owner_name?: string; acquisition_date?: string; replacement_value_gbp?: number;
  replacement_value_basis?: 'per_unit' | 'total'; vat_basis?: string;
  requested_cover_date?: string; availability_confirmed_at?: number; availability_evidence?: string;
  details_verified_at?: number; target_account_slugs: string[]; ownership: Ownership;
  insurance_status: string; propagation_status: string; propagation_attempts: number; propagation_error?: string;
};
const serialExceptionText = (intake: Intake) => {
  const reasons = Array.isArray(intake.missing_serial_reasons) ? intake.missing_serial_reasons : [];
  return reasons.length ? reasons.map((reason: string, i: number) => `Unit ${intake.serials.length + i + 1}: ${reason}`).join('; ') : 'none';
};

function insuranceDraft(intake: Intake) {
  const missing = (value: unknown, label: string) => value == null || value === '' ? `[${label} needed]` : String(value);
  const qty = Number(intake.physical_quantity ?? 0);
  const amount = (value: unknown, basis: string | undefined) => {
    if (value == null || !basis) return missing(value, 'replacement value and basis');
    const n = Number(value);
    const total = basis === 'per_unit' ? n * qty : n;
    return `£${total.toFixed(2)} total (${basis === 'per_unit' ? `£${n.toFixed(2)} per unit` : 'total basis'}; GBP; VAT ${missing(intake.vat_basis, 'VAT basis')})`;
  };
  const serials = Array.isArray(intake.serials) && intake.serials.length ? intake.serials.join(', ') : 'none recorded';
  return `To: darren@taylormaderisksolutions.co.uk\nSubject: ARCL-00732 – Additional equipment – ${missing(intake.item_name, 'item name')}\n\nHi Darren,\n\nPlease arrange the addition of ${qty} ${missing(intake.exact_model, 'make/model and description')} under policy ARCL-00732.\nSerial numbers: ${serials}. Unserialised units: ${serialExceptionText(intake)}.\nOwner: ${missing(intake.owner_name, 'verified owner')}\nReplacement value: ${amount(intake.replacement_value_gbp, intake.replacement_value_basis)}\nAcquired: ${missing(intake.acquisition_date, 'purchase date')}\nRequested cover start: ${missing(intake.requested_cover_date, 'requested cover date')}\n\nPlease confirm any further evidence needed, any additional premium or fees, the effective cover date and revised equipment sum insured, and send the endorsement.\n\nKind regards,\nDaniel\nDB Cinema Rentals Ltd`;
}

export default function InventoryOnboarding({ onClose }: { onClose: () => void }) {
  const create = useMutation(createRef);
  const saveDraft = useMutation(saveDraftRef);
  const register = useMutation(registerRef);
  const updateTargets = useMutation(updateTargetsRef);
  const confirmAvailability = useMutation(availabilityRef);
  const update = useMutation(updateRef);
  const progress = useMutation(progressRef);
  const retry = useMutation(retryRef);
  const drafts = useQuery(draftRef, {}) as Array<{ request_key: string; form: Form; compatible_accessory_ids: Id<'items'>[]; target_account_slugs: string[]; updated_at: number }> | undefined;
  const accounts = useQuery(accountsRef, {}) as Array<{ slug: string; display_name?: string }> | undefined;
  const recent = useQuery(recentRef, {}) as Array<{ item_id: Id<'items'>; name: string; form: Form; insurance_status: string; propagation_status: string; availability_confirmed_at?: number; target_account_slugs: string[] }> | undefined;
  const choices = useQuery(choicesRef, {}) as Array<{ id: Id<'items'>; name: string; kind: string }> | undefined;
  const [form, setForm] = useState<Form>(blank);
  const [key, setKey] = useState(() => crypto.randomUUID());
  const [targets, setTargets] = useState<string[]>([]);
  const [selectedAccessories, setSelectedAccessories] = useState<string[]>([]);
  const [listedComponents, setListedComponents] = useState<Array<{ item_id: string; qty: string }>>([]);
  const [review, setReview] = useState(false);
  const [itemId, setItemId] = useState<Id<'items'> | null>(null);
  const [account, setAccount] = useState('');
  const [productId, setProductId] = useState('');
  const [publicUrl, setPublicUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [evidence, setEvidence] = useState('');
  const [evidenceKind, setEvidenceKind] = useState<'sent_message' | 'broker_reply' | 'endorsement'>('sent_message');
  const [confirmedCoverDate, setConfirmedCoverDate] = useState('');
  const detail = useQuery(detailRef, itemId ? { item_id: itemId } : 'skip') as {
    item: { qty: number; name_canonical: string; status: string } | null;
    intake: Intake | null;
    listings: Array<{ account_slug: string; product_id: number; public_url?: string }>;
  } | undefined;
  const serials = useMemo(() => lines(form.serials), [form.serials]);
  const serialExceptions = useMemo(() => lines(form.missing_serial_reasons), [form.missing_serial_reasons]);
  const quantity = form.ownership === 'marketing_only' ? 0 : Number(form.quantity);
  const missingCount = quantity - serials.length;
  const set = (name: keyof Form, value: string) => setForm(f => ({ ...f, [name]: value }));
  const field = (title: string, name: keyof Form, hint?: string, type = 'text') => (
    <label className={labelClass}>{title}<input className={inputClass} type={type} value={form[name]}
      placeholder={hint} onChange={e => set(name, e.target.value)} /></label>
  );
  const valid = !!form.name.trim() && !!form.exact_model.trim() && !!form.kind.trim() &&
    !!form.specifications.trim() && !!form.compatibility_note.trim() && !!form.included_accessories.trim() &&
    Number.isSafeInteger(quantity) && quantity >= 0 && missingCount >= 0 &&
    missingCount === serialExceptions.length && (form.ownership === 'marketing_only' || (quantity > 0 && !!form.owner_name.trim()));

  // Draft writes are idempotent and separate from stock. They make a closed or
  // interrupted intake recoverable without creating an item accidentally.
  useEffect(() => {
    const started = Object.entries(form).some(([name, value]) => name !== 'vat_basis' && name !== 'quantity' && name !== 'ownership' && !!value.trim()) || targets.length > 0 || selectedAccessories.length > 0;
    if (itemId || !started) return;
    const timer = setTimeout(() => {
      void saveDraft({ request_key: key, form, compatible_accessory_ids: selectedAccessories, target_account_slugs: targets })
        .catch(() => {});
    }, 900);
    return () => clearTimeout(timer);
  }, [itemId, valid, key, form, selectedAccessories, targets, saveDraft]);

  const loadDraft = (d: NonNullable<typeof drafts>[number]) => {
    setKey(d.request_key); setForm(d.form); setSelectedAccessories(d.compatible_accessory_ids.map(String));
    setTargets(d.target_account_slugs); setReview(false); setNotice('Draft restored. No stock changed.');
  };
  const createItem = async () => {
    if (!valid) return;
    setBusy(true); setNotice('');
    try {
      const result = await create({ request_key: key, name: form.name, exact_model: form.exact_model,
        kind: form.kind, quantity, ownership: form.ownership, serials, missing_serial_reasons: serialExceptions,
        specifications: form.specifications, compatibility_note: form.compatibility_note,
        included_accessories: form.included_accessories, lens_mount: optional(form.lens_mount),
        compatible_accessory_ids: selectedAccessories as Id<'items'>[], target_account_slugs: targets,
        details_confirmed: true, owner_name: optional(form.owner_name), acquisition_date: optional(form.acquisition_date),
        purchase_price_gbp: optionalMoney(form.purchase_price_gbp), purchase_value_basis: optional(form.purchase_value_basis),
        replacement_value_gbp: optionalMoney(form.replacement_value_gbp), replacement_value_basis: optional(form.replacement_value_basis),
        vat_basis: optional(form.vat_basis), valuation_source: optional(form.valuation_source), valuation_date: optional(form.valuation_date),
        requested_cover_date: optional(form.requested_cover_date) });
      setItemId(result.item_id as Id<'items'>); setReview(false);
      setNotice(result.repeated ? 'This submission was already committed. No stock was added again.' :
        `Committed ${quantity} physical unit(s). Availability, listing and insurance checklist steps remain visible below.`);
    } catch (e) { setNotice(e instanceof Error ? e.message : 'Inventory commit failed; no change confirmed.'); }
    finally { setBusy(false); }
  };
  const registerListing = async () => {
    if (!itemId) return;
    setBusy(true); setNotice('');
    try {
      const components = detail?.intake?.ownership === 'owned'
        ? [{ item_id: itemId, qty: 1 }, ...listedComponents.map(c => ({ item_id: c.item_id as Id<'items'>, qty: Number(c.qty) }))]
        : [];
      const result = await register({ item_id: itemId, account_slug: account, product_id: Number(productId), public_url: publicUrl, stock_components: components });
      setNotice(`Registered ${result.account_slug} listing ${result.product_id}. It references the same stock pool; added zero units.`);
      setProductId(''); setPublicUrl('');
    } catch (e) { setNotice(e instanceof Error ? e.message : 'Listing registration failed; check the mapping.'); }
    finally { setBusy(false); }
  };
  const saveInsuranceDetails = async () => {
    if (!itemId || !detail?.intake) return;
    setBusy(true); setNotice('');
    try {
      const result = await update({ item_id: itemId, serials, missing_serial_reasons: serialExceptions,
        owner_name: optional(form.owner_name), acquisition_date: optional(form.acquisition_date),
        purchase_price_gbp: optionalMoney(form.purchase_price_gbp), purchase_value_basis: optional(form.purchase_value_basis),
        replacement_value_gbp: optionalMoney(form.replacement_value_gbp), replacement_value_basis: optional(form.replacement_value_basis),
        vat_basis: optional(form.vat_basis), valuation_source: optional(form.valuation_source), valuation_date: optional(form.valuation_date),
        requested_cover_date: optional(form.requested_cover_date) });
      setNotice(`Insurance details saved: ${result.insurance_status}. No email sent and no cover confirmed.`);
    } catch (e) { setNotice(e instanceof Error ? e.message : 'Insurance details were not saved.'); }
    finally { setBusy(false); }
  };
  const advanceInsurance = async (status: 'sent_to_broker' | 'awaiting_confirmation' | 'addition_confirmed') => {
    if (!itemId) return;
    setBusy(true); setNotice('');
    try {
      const result = await progress({ item_id: itemId, status, evidence_kind: evidenceKind,
        evidence_reference: evidence, confirmed_cover_date: confirmedCoverDate || undefined });
      setNotice(`Recorded ${result.insurance_status} with evidence. This action does not send email.`);
      setEvidence('');
    } catch (e) { setNotice(e instanceof Error ? e.message : 'Insurance progress was not recorded.'); }
    finally { setBusy(false); }
  };
  const targetUpdate = async (next: string[]) => {
    if (!itemId) { setTargets(next); return; }
    setBusy(true);
    try { await updateTargets({ item_id: itemId, target_account_slugs: next }); setNotice('Listing targets saved.'); }
    catch (e) { setNotice(e instanceof Error ? e.message : 'Listing targets were not saved.'); }
    finally { setBusy(false); }
  };
  const outstanding = detail?.intake ? [
    !detail.intake.details_verified_at && 'verify item details',
    !detail.intake.availability_confirmed_at && 'confirm availability',
    ...(detail.intake.target_account_slugs ?? []).filter((slug: string) => !detail.listings?.some(l => l.account_slug === slug)).map((slug: string) => `create and register ${slug} listing`),
    detail.intake.ownership === 'owned' && detail.intake.insurance_status !== 'addition_confirmed' && `insurance: ${String(detail.intake.insurance_status).replaceAll('_', ' ')}`,
    detail.intake.propagation_status !== 'complete' && `consumer propagation: ${detail.intake.propagation_status}`,
  ].filter(Boolean) : [];

  return <div className="flex h-full flex-col overflow-hidden rounded-xl bg-zinc-950 text-zinc-100">
    <div className="flex shrink-0 items-center justify-between border-b border-white/10 px-3 py-2">
      <div><strong className="text-sm">WallE · inventory intake</strong><p className="text-[11px] text-zinc-400">Review each physical unit before committing.</p></div>
      <button className={buttonClass} onClick={onClose}>Back to chat</button>
    </div>
    <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3 text-xs">
      <p className="rounded-lg border border-amber-500/25 bg-amber-500/10 p-2 text-amber-100">Leo’s checklist: verify item details and serials, confirm live availability, create marketplace listings on the appropriate accounts, then register each exact account, ID and public URL here. External listings that are not registered cannot reliably be recognised. Registration never publishes listings, and all accounts share one physical stock pool.</p>
      {!itemId && <>
        {!!recent?.length && <section className="space-y-2 rounded-lg border border-white/10 p-2"><strong>Continue a committed item’s checklist</strong>{recent.slice(0, 8).map(r => <button key={r.item_id} className={`${buttonClass} mr-1`} onClick={() => { setForm(r.form); setItemId(r.item_id); setNotice('Loaded saved inventory and checklist. No stock changed.'); }}>{r.name} · {r.propagation_status}</button>)}</section>}
        {!!drafts?.length && <section className="space-y-2 rounded-lg border border-white/10 p-2"><strong>Resume an interrupted intake</strong>{drafts.slice(0, 8).map(d => <button key={d.request_key} className={`${buttonClass} mr-1`} onClick={() => loadDraft(d)}>{d.form.name || d.form.exact_model || 'Untitled draft'} · {new Date(d.updated_at).toLocaleDateString()}</button>)}</section>}
        <section className="space-y-2">
          <label className={labelClass}>Stock type<select className={inputClass} value={form.ownership} onChange={e => set('ownership', e.target.value)}><option value="owned">Owned physical stock</option><option value="hired_in">Hired-in equipment (not bookable until dated supply is recorded)</option><option value="marketing_only">Marketing-only listing (zero physical units)</option></select></label>
          {field('Exact canonical make and model', 'name', 'Use the exact manufacturer and variant')}
          {field('Confirm exact make and model', 'exact_model')}
          {field('Inventory category', 'kind', 'camera, lens, audio, lighting…')}
          {form.ownership !== 'marketing_only' && field('Physical quantity', 'quantity', undefined, 'number')}
          <label className={labelClass}>Serial numbers, one per unit<textarea className={inputClass} rows={3} value={form.serials} onChange={e => set('serials', e.target.value)} placeholder="One real serial per line; never invent one" /></label>
          <label className={labelClass}>Per-unit serial exceptions, one reason per unserialised unit<textarea className={inputClass} rows={2} value={form.missing_serial_reasons} onChange={e => set('missing_serial_reasons', e.target.value)} placeholder="e.g. Unit not labelled; confirm with supplier" /></label>
          <p className={missingCount < 0 || missingCount !== serialExceptions.length ? 'text-red-300' : 'text-amber-200'}>{form.ownership === 'marketing_only' ? 'Marketing-only: no physical stock is added.' : `${serials.length} serial(s) + ${serialExceptions.length} explicit exception(s) must equal ${quantity} physical unit(s).`}</p>
          <label className={labelClass}>Relevant technical specifications<textarea className={inputClass} rows={2} value={form.specifications} onChange={e => set('specifications', e.target.value)} placeholder="Exact variant, mount, power, media, dimensions, or explicitly say unknown" /></label>
          {field('Lens mount, if relevant', 'lens_mount')}
          <label className={labelClass}>Compatibility and limits<textarea className={inputClass} rows={2} value={form.compatibility_note} onChange={e => set('compatibility_note', e.target.value)} placeholder="Verified fits/adapters or explicitly say unknown" /></label>
          <label className={labelClass}>Included accessories<textarea className={inputClass} rows={2} value={form.included_accessories} onChange={e => set('included_accessories', e.target.value)} placeholder="List what is included, or state none / unknown" /></label>
          <label className={labelClass}>Compatible owned accessories (optional)<select multiple className={`${inputClass} h-24`} value={selectedAccessories} onChange={e => setSelectedAccessories(Array.from(e.target.selectedOptions, o => o.value))}>{choices?.map(c => <option key={c.id} value={c.id}>{c.name} · {c.kind}</option>)}</select><span>Compatibility does not mean an accessory is included in the rental.</span></label>
          {form.ownership !== 'marketing_only' && <>
            {field('Legal owner / equipment provider', 'owner_name')}
            {field('Purchase / acquisition date', 'acquisition_date', undefined, 'date')}
            {field('Purchase price GBP', 'purchase_price_gbp', undefined, 'number')}
            <label className={labelClass}>Purchase price basis<select className={inputClass} value={form.purchase_value_basis} onChange={e => set('purchase_value_basis', e.target.value)}><option value="">Choose basis</option><option value="per_unit">Per unit</option><option value="total">Total for all units</option></select></label>
            {field('Replacement / new-equivalent value GBP', 'replacement_value_gbp', undefined, 'number')}
            <label className={labelClass}>Replacement value basis<select className={inputClass} value={form.replacement_value_basis} onChange={e => set('replacement_value_basis', e.target.value)}><option value="">Choose basis</option><option value="per_unit">Per unit</option><option value="total">Total for all units</option></select></label>
            <label className={labelClass}>VAT basis<select className={inputClass} value={form.vat_basis} onChange={e => set('vat_basis', e.target.value)}><option value="to_confirm">To confirm</option><option value="including_vat">Including VAT</option><option value="excluding_vat">Excluding VAT</option><option value="not_applicable">Not applicable</option></select></label>
            {field('Valuation source', 'valuation_source')}{field('Valuation date', 'valuation_date', undefined, 'date')}{field('Requested cover start date', 'requested_cover_date', undefined, 'date')}
          </>}
          <label className={labelClass}>Listing accounts to create and register<select multiple className={`${inputClass} h-20`} value={targets} onChange={e => setTargets(Array.from(e.target.selectedOptions, o => o.value))}>{accounts?.map(a => <option key={a.slug} value={a.slug}>{a.display_name || a.slug}</option>)}</select></label>
        </section>
        {!review ? <div className="flex gap-2"><button className={buttonClass} disabled={!valid} onClick={() => setReview(true)}>Review exact stock</button><button className={buttonClass} onClick={async () => { try { await saveDraft({ request_key: key, form, compatible_accessory_ids: selectedAccessories, target_account_slugs: targets }); setNotice('Draft saved. No stock changed.'); } catch (e) { setNotice(e instanceof Error ? e.message : 'Draft save failed.'); } }}>Save draft</button></div> :
          <div className="space-y-2 rounded-lg border border-indigo-400/30 p-3"><strong>Confirm inventory commit</strong><p>{form.name} · {quantity} {form.ownership} unit(s) · {serials.length} serials · {serialExceptions.length} exceptions.</p><p>The external marketplace listings will not be published or changed.</p><div className="flex gap-2"><button className={buttonClass} disabled={busy} onClick={createItem}>Confirm and save</button><button className={buttonClass} onClick={() => setReview(false)}>Edit</button></div></div>}
      </>}
      {itemId && <>
        <section className="space-y-1 rounded-lg border border-white/10 p-2"><strong>Leo’s outstanding checklist</strong><ul className="list-disc pl-5">{outstanding.length ? outstanding.map((step, i) => <li key={i}>{step}</li>) : <li>All checklist steps complete.</li>}</ul><p>{detail?.item?.name_canonical ?? 'Loading…'} · {detail?.intake?.physical_quantity ?? '?'} physical units · {detail?.item?.qty ?? '?'} bookable units.</p></section>
        <section className="space-y-2 rounded-lg border border-white/10 p-2"><strong>Confirm availability</strong><p>Checks the live shared stock source. Hired-in units remain at zero bookable until a dated supply agreement is implemented. Existing bookings are not edited.</p><button className={buttonClass} disabled={busy || !detail?.intake} onClick={async () => { setBusy(true); try { const r = await confirmAvailability({ item_id: itemId }); setNotice(r.evidence); } catch (e) { setNotice(e instanceof Error ? e.message : 'Availability was not confirmed.'); } finally { setBusy(false); } }}>{detail?.intake?.availability_confirmed_at ? 'Recheck live availability' : 'Confirm live availability'}</button><p>{detail?.intake?.availability_evidence || 'Availability has not been confirmed yet.'}</p></section>
        <section className="space-y-2 rounded-lg border border-white/10 p-2"><strong>Listings · never auto-published</strong><p>Create the listing externally first. Registration validates the synced account catalogue, exact product ID and public URL. Every mapping references this shared stock pool.</p>
          <label className={labelClass}>Target accounts<select multiple className={`${inputClass} h-20`} value={detail?.intake?.target_account_slugs ?? []} onChange={e => void targetUpdate(Array.from(e.target.selectedOptions, o => o.value))}>{accounts?.map(a => <option key={a.slug} value={a.slug}>{a.display_name || a.slug}</option>)}</select></label>
          <label className={labelClass}>Rental Manager account<select className={inputClass} value={account} onChange={e => setAccount(e.target.value)}><option value="">Choose account</option>{accounts?.filter(a => detail?.intake?.target_account_slugs?.includes(a.slug)).map(a => <option key={a.slug} value={a.slug}>{a.display_name || a.slug}</option>)}</select></label>
          <label className={labelClass}>Exact marketplace product ID<input className={inputClass} type="number" value={productId} onChange={e => setProductId(e.target.value)} /></label>
          <label className={labelClass}>Public listing URL<input className={inputClass} type="url" value={publicUrl} onChange={e => setPublicUrl(e.target.value)} /></label>
          {detail?.intake?.ownership === 'owned' && <div className="space-y-2 rounded border border-white/10 p-2"><p>Map separately tracked owned accessories that are included in this listing, with the exact quantity reserved per rental. Compatibility and free-text accessory notes do not automatically consume stock.</p>{listedComponents.map((component, index) => <div key={index} className="flex gap-2"><select className={inputClass} value={component.item_id} onChange={e => setListedComponents(rows => rows.map((row, i) => i === index ? { ...row, item_id: e.target.value } : row))}><option value="">Choose included stock item</option>{choices?.filter(c => c.id !== itemId).map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select><input className={`${inputClass} max-w-24`} aria-label="Included component quantity" type="number" min="1" value={component.qty} onChange={e => setListedComponents(rows => rows.map((row, i) => i === index ? { ...row, qty: e.target.value } : row))} /></div>)}<button type="button" className={buttonClass} onClick={() => setListedComponents(rows => [...rows, { item_id: '', qty: '1' }])}>Add included stock component</button></div>}
          <button className={buttonClass} disabled={busy || !account || !productId || !publicUrl || listedComponents.some(c => !c.item_id || !Number.isSafeInteger(Number(c.qty)) || Number(c.qty) < 1)} onClick={registerListing}>Register listing</button>
          <ul>{detail?.listings.map(l => <li key={`${l.account_slug}#${l.product_id}`}>{l.account_slug} #{l.product_id} · {l.public_url ? <a href={l.public_url} target="_blank" rel="noreferrer" className="underline">public listing</a> : 'URL unavailable'}</li>)}</ul>
          {!!detail?.intake?.target_account_slugs?.filter((slug: string) => !detail.listings.some(l => l.account_slug === slug)).length && <p className="text-amber-200">Each selected account needs its own external listing and exact registration before this step is complete.</p>}
        </section>
        {detail?.intake?.ownership === 'owned' && <section className="space-y-2 rounded-lg border border-white/10 p-2"><strong>Equipment insurance · ARCL-00732</strong><p>Draft for Darren Vickery at Taylor Made Risk Solutions. The supplied policy material describes £35,000 UK All Risks equipment with JRP Underwriting Limited for Great Lakes Insurance UK Ltd; check the latest schedule before relying on any limit. The buildings capital-additions allowance is not rental-equipment cover. VAT treatment remains to be confirmed. Saving or sending a draft does not prove cover.</p>
          <label className={labelClass}>Reviewable email draft<textarea readOnly className={`${inputClass} h-56 font-mono text-[11px]`} value={insuranceDraft(detail.intake)} /></label>
          <details><summary className="cursor-pointer">Update insurance record</summary><div className="mt-2 space-y-2"><label className={labelClass}>Serials, one per unit<textarea className={inputClass} rows={2} value={form.serials} onChange={e => set('serials', e.target.value)} /></label><label className={labelClass}>One explicit exception per unserialised unit<textarea className={inputClass} rows={2} value={form.missing_serial_reasons} onChange={e => set('missing_serial_reasons', e.target.value)} /></label>{field('Owner', 'owner_name')}{field('Purchase date', 'acquisition_date', undefined, 'date')}{field('Purchase price GBP', 'purchase_price_gbp', undefined, 'number')}<label className={labelClass}>Purchase basis<select className={inputClass} value={form.purchase_value_basis} onChange={e => set('purchase_value_basis', e.target.value)}><option value="">Choose</option><option value="per_unit">Per unit</option><option value="total">Total</option></select></label>{field('Replacement value GBP', 'replacement_value_gbp', undefined, 'number')}<label className={labelClass}>Replacement basis<select className={inputClass} value={form.replacement_value_basis} onChange={e => set('replacement_value_basis', e.target.value)}><option value="">Choose</option><option value="per_unit">Per unit</option><option value="total">Total</option></select></label><label className={labelClass}>VAT basis<select className={inputClass} value={form.vat_basis} onChange={e => set('vat_basis', e.target.value)}><option value="to_confirm">To confirm</option><option value="including_vat">Including VAT</option><option value="excluding_vat">Excluding VAT</option><option value="not_applicable">Not applicable</option></select></label>{field('Valuation source', 'valuation_source')}{field('Valuation date', 'valuation_date', undefined, 'date')}{field('Requested cover date', 'requested_cover_date', undefined, 'date')}<button className={buttonClass} disabled={busy || serials.length + serialExceptions.length !== detail.intake.physical_quantity} onClick={saveInsuranceDetails}>Save insurance details</button></div></details>
          <label className={labelClass}>Evidence type<select className={inputClass} value={evidenceKind} onChange={e => setEvidenceKind(e.target.value as typeof evidenceKind)}><option value="sent_message">Sent email evidence</option><option value="broker_reply">Broker reply evidence</option><option value="endorsement">Endorsement evidence</option></select></label>
          <label className={labelClass}>Evidence reference (email thread, document, or record ID)<input className={inputClass} value={evidence} onChange={e => setEvidence(e.target.value)} /></label>
          <label className={labelClass}>Confirmed effective date<input className={inputClass} type="date" value={confirmedCoverDate} onChange={e => setConfirmedCoverDate(e.target.value)} /></label>
          <div className="flex flex-wrap gap-2">{detail.intake.insurance_status === 'ready_for_review' && <button className={buttonClass} disabled={busy || !evidence} onClick={() => advanceInsurance('sent_to_broker')}>Record email actually sent</button>}{detail.intake.insurance_status === 'sent_to_broker' && <button className={buttonClass} disabled={busy || !evidence} onClick={() => advanceInsurance('awaiting_confirmation')}>Record broker reply / awaiting endorsement</button>}{detail.intake.insurance_status === 'awaiting_confirmation' && <button className={buttonClass} disabled={busy || !evidence || evidenceKind !== 'endorsement' || !confirmedCoverDate} onClick={() => advanceInsurance('addition_confirmed')}>Confirm evidenced endorsement</button>}</div>
          <p>Insurance status: {String(detail.intake.insurance_status).replaceAll('_', ' ')}. Existing Didit/90-day approval remains a separate unresolved item.</p>
        </section>}
        <section className="space-y-2 rounded-lg border border-white/10 p-2"><strong>Propagation to consumers</strong><p>Status: {detail?.intake?.propagation_status || 'pending'} · attempt {detail?.intake?.propagation_attempts ?? 1}. The shared master row is read by availability, calendar and bot stock checks; inventory widgets refresh separately.</p>{detail?.intake?.propagation_error && <p className="text-amber-200">{detail.intake.propagation_error}</p>}{detail?.intake?.propagation_status && detail.intake.propagation_status !== 'complete' && <button className={buttonClass} disabled={busy} onClick={async () => { setBusy(true); try { const r = await retry({ item_id: itemId }); setNotice(`Consumer refresh queued, attempt ${r.attempt}.`); } catch (e) { setNotice(e instanceof Error ? e.message : 'Retry was not queued.'); } finally { setBusy(false); } }}>{detail.intake.propagation_status === 'pending' ? 'Retry if pending for 10 minutes' : 'Retry incomplete refresh'}</button>}</section>
        <button className={buttonClass} onClick={() => { setItemId(null); setForm(blank); setSelectedAccessories([]); setTargets([]); setKey(crypto.randomUUID()); setNotice(''); }}>Start another item</button>
      </>}
      {notice && <p role="status" className="rounded-md border border-white/15 bg-zinc-800 p-2">{notice}</p>}
    </div>
  </div>;
}
