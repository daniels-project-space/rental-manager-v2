type ListingImageReservation = {
  hygglo_items?: Array<{ image_url?: string | null }>;
  photos_urls?: string[];
};

export function returnListingImages(members: ListingImageReservation[], limit = 10): string[] {
  const images: string[] = [];
  const add = (url?: string | null) => {
    if (url && images.length < limit && !images.includes(url)) images.push(url);
  };
  const base = members[0];
  add(base?.hygglo_items?.find((item) => item.image_url)?.image_url ?? base?.photos_urls?.[0]);
  for (const member of members) {
    for (const item of member.hygglo_items ?? []) add(item.image_url);
  }
  return images;
}
