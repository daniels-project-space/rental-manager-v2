import {internalMutation} from './_generated/server';
import {v} from 'convex/values';
import {sharedLensFacts} from './lib/lens_variant_review';

/** A reviewed classification, not an assertion of the owned generation.
 * Both Sony models specify a 35mm full-frame 16–35mm wide-angle zoom with
 * 107–63 degree view. Rectilinear is the reviewer's classification of that
 * conventional perspective design; it does not mean zero optical distortion.
 * Existing generation-specific properties are neither added nor overwritten. */
export const run=internalMutation({args:{apply:v.optional(v.boolean())},handler:async(ctx,{apply})=>{
 const item=await ctx.db.query('items').withIndex('by_canonical_name',q=>q.eq('name_canonical','Sony GM 16-35mm f2.8')).unique();
 if(!item||item.kind!=='lens'||item.status!=='active'||item.is_marketing_only||item.qty<1)throw new Error('Owned Sony lens identity changed');
 const spec=await ctx.db.query('item_specs').withIndex('by_item',q=>q.eq('item_id',item._id)).unique();
 const reviews=spec?.lens_variant_reviews;
 if(!spec||spec.source!=='manufacturer-verified'||!reviews||reviews.length!==2||
   reviews.map(r=>r.model).sort().join(',')!=='SEL1635GM,SEL1635GM2'||!sharedLensFacts(reviews,spec.verified_at!,spec.source_url??null))throw new Error('Shared generation review changed');
 const verified_at=Date.now();
 const next=reviews.map(review=>{
  if(review.capabilities.projection&&review.capabilities.projection!=='rectilinear')throw new Error('Conflicting recorded projection requires review');
  const source=review.model==='SEL1635GM'
   ? 'https://www.sony.co.uk/electronics/camera-lenses/sel1635gm/specifications'
   : 'https://www.sony.co.uk/electronics/support/lenses-e-mount-lenses/sel1635gm2/specifications';
  return {...review,verified_at,source_urls:[...new Set([...review.source_urls,source])],
   review_notes:'Reviewer inference: rectilinear perspective, based on Sony’s full-frame 16–35mm wide-angle zoom specification and 107–63 degree angle of view for this exact model. This excludes fisheye/anamorphic design; it does not establish zero distortion or any generation-specific performance.',
   capabilities:{...review.capabilities,projection:'rectilinear' as const}};
 });
 const common=sharedLensFacts(next,spec.verified_at!,spec.source_url??null);
 if(common?.projection!=='rectilinear')throw new Error('Projection must be independently reviewed for both generations');
 if(apply)await ctx.db.patch(spec._id,{lens_variant_reviews:next});
 return {applied:!!apply,item:item.name_canonical,previous:reviews,reviewed:next,common};
}});
