// Several photos of one garment, each given a role: its front, its back, a close-up of its cloth, its size
// tag, or someone wearing it (print.js's photoTraits reads the numbers these go by). A wrong guess is changed
// by hand; a photo whose role was set by hand keeps it.
export const ROLES = { front: "Front", back: "Back", closeup: "Close-up", tag: "Size tag", worn: "Worn", other: "Other" }

// One photo's kind, from its traits: "worn" (skin that isn't the garment's colour), "tag" (a frame of small
// dark-on-light words, filling the frame or small in it), "closeup" (cloth filling the frame), or
// "garment" (a full shot, clear of its backdrop).
export function photoKind(traits) {
  if (!traits) return "garment"
  if (traits.skin > 0.03) return "worn"
  const wordy = traits.busy > 0.05 && traits.dark > 0.04 && traits.light > 0.2
  if (!traits.garment) return wordy ? "tag" : "closeup"
  if (traits.fills < 0.3 && wordy) return "tag"
  return "garment"
}

// Roles for the photos in order: those set by hand keep theirs; of the rest, the first full shot is the
// front and the next the back (when no photo is the front or back by hand), later ones "other".
// photos: [{ traits, role?, picked? }] (picked: the role was set by hand). Returns the roles.
export function guessRoles(photos) {
  const taken = new Set(photos.filter(p => p.picked).map(p => p.role))
  return photos.map(p => {
    if (p.picked) return p.role
    const kind = photoKind(p.traits)
    if (kind !== "garment") return kind
    for (const role of ["front", "back"]) if (!taken.has(role)) { taken.add(role); return role }
    return "other"
  })
}

// The photo for each role the garment uses (the first of each), from the tray.
export function photosByRole(photos) {
  const out = {}
  for (const p of photos) if (p.role && p.role !== "other" && !out[p.role]) out[p.role] = p.url
  // No front: the first full shot (or the first photo) stands in.
  out.front ??= photos.find(p => p.role === "other")?.url ?? photos.find(p => p.role !== "tag" && p.role !== "closeup")?.url ?? null
  return out
}
