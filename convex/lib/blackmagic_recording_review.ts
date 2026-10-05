import type {RecordingMode} from "./camera_requirements";
export const FULL_FRAME_RECORDING_SOURCE="https://documents.blackmagicdesign.com/UserManuals/BlackmagicCinemaCameraManual.pdf#page=20";
/** Manufacturer manual: resolution/sensor table p20; project rates p60.
 * This positive mode review is not an exhaustive list of supported modes. */
export function fullFrameDci4kMode(verified_at:number):RecordingMode {
 return {resolution:"dci_4k",nominal_fps:[23.98,24,25,29.97,30,50,59.94,60],full_width:false,internal:true,
  conditions:["4K DCI is 4096×2160 Blackmagic RAW with a windowed sensor; it is not full-sensor-width capture.",
   "The manufacturer's maximum sensor rate for this resolution is 60 fps. Select compatible recording settings and media; storage supplied with the rental is a separate inventory fact."],
  verified_model:"Blackmagic Cinema Camera 6K",source_url:FULL_FRAME_RECORDING_SOURCE,verified_at};
}
