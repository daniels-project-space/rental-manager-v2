type CameraIdentitySpec={verified_model?:string;verified_at?:number;camera_capabilities?:{identity_review?:{verified_model:string;verified_at:number}}};
/** Legacy review dates remain conservative. A separate, model-bound identity
 * review lets independently sourced modes survive later property corrections. */
export function cameraIdentityReviewedAt(spec:CameraIdentitySpec) {
 const identity=spec.camera_capabilities?.identity_review;
 return identity&&identity.verified_model===spec.verified_model&&Number.isFinite(identity.verified_at)&&identity.verified_at>0&&
  Number.isFinite(spec.verified_at)&&identity.verified_at<=spec.verified_at! ? identity.verified_at:spec.verified_at!;
}
