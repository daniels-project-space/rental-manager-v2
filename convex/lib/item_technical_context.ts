import type { LensCapabilities } from "./lens_requirements";
import type { CameraCapabilities } from "./camera_requirements";
import { bestMatch } from "./item_name_match";
import { ownedInventoryItem } from "./inventory_spec_grounding";

export type ItemTechnicalEvidence = {
  spec_text?: string | null;
  spec_verification?: { model: string; source_url: string | null } | null;
  lens_capabilities?: LensCapabilities | null;
  camera_capabilities?: CameraCapabilities | null;
};

/** Resolve facts against the full inventory before excluding unowned items.
 * Filtering first could turn an exact marketing item into a different owned
 * substitute. Fact lookup never substitutes equipment. */
export function equipmentFactRequests<T extends {name_canonical:string;aliases?:string[];status:string;qty:number;is_marketing_only?:boolean}>(names:string[],items:T[]) {
  if(names.length>6 || names.some(name=>!name.trim() || name.length>160))throw new Error("Request one to six short equipment names");
  return [...new Set(names.map(name=>name.trim()))].map(requested_name=>{
    const match=bestMatch(requested_name,items,item=>item.name_canonical,item=>item.aliases??[]);
    return {requested_name,item:match.confident && match.match && ownedInventoryItem(match.match)?match.match:null};
  });
}

type RequestedEquipment = {
  inventory_components?: Array<{ name: string | null; kind?: string | null; owned?: boolean | null }>;
};

/** Physical rental contents establish supplied bodies, not which body the
 * renter is using. In particular, a lens mount is never a camera identity. */
export function equipmentUsageContext(items: RequestedEquipment[]) {
  const supplied_camera_bodies = [...new Set(items.flatMap(item =>
    (item.inventory_components ?? []).filter(component =>
      component.owned === true && ["camera", "camera_body"].includes(component.kind ?? "") && component.name?.trim(),
    ).map(component => component.name!),
  ))];
  return {
    supplied_camera_bodies,
    source: "native_rental_components" as const,
    renter_camera_body: null,
    setup_advice: {
      camera_controls: "Only identify controls verified for the renter's actual body. With an unknown body, describe focus-assist options conditionally, if supported.",
      depth_of_field: "A numerical focusing distance or guarantee of sharpness requires the actual sensor, aperture and focus distance. Lens focal length alone does not establish those setup parameters; give general advice without guessed distances or sharpness promises.",
    },
    guidance: "These are recorded rental contents, not proof of the renter's chosen camera. Establish the body from the renter's explicit statement before body-specific setup advice; a lens brand or mount does not identify it. Answer verified lens facts immediately. When the body is unspecified, give general manual-focus advice and ask its model only for camera-specific controls. With several supplied bodies, do not choose one implicitly.",
  };
}

/** Preserve the same reviewed evidence in requested-item and recommendation
 * prompts. Names, mount, advertising and old messages are lookup context,
 * not a substitute for a missing technical property. */
export function itemTechnicalContext(item: ItemTechnicalEvidence): string {
  const spec = item.spec_verification;
  const lens = item.lens_capabilities;
  const sections = [
    spec && item.spec_text
      ? `Reviewed model ${spec.model}; source ${spec.source_url ?? "owner"}; specifications: ${item.spec_text}`
      : "Technical specifications are not reviewed for this exact item.",
  ];
  if (lens) {
    sections.push(`Reviewed lens capabilities: ${JSON.stringify(lens)}. Omitted properties are unknown.`);
  }
  if (item.camera_capabilities) {
    sections.push(`Reviewed camera capabilities: ${JSON.stringify(item.camera_capabilities)}. Omitted properties and recording modes are unknown. Mandatory recording-mode conditions still apply.`);
  }
  sections.push("Use this evidence for technical claims. A listing name, brand, mount or prior reply does not establish an unrecorded property. Focus mode does not establish electronic contacts, EXIF transmission or camera menu settings; those require their own reviewed evidence. Body-specific controls also require the actual body model from the renter, not the lens mount.");
  return sections.join(" ");
}
