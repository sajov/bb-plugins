// Project colours.
//
// The palette is muted accents in the neighbourhood of the theme tokens. A
// project without a choice of its own gets a stable colour derived from its id,
// so it stays recognisable without anyone configuring anything.
export const BADGE_PALETTE = [
  "#FFFFFF",
  "#A1A1A1",
  "#525252",
  "#000000",
  "#2D9CFF",
  "#9D5CFF",
  "#00F5D4",
  "#39FF6A",
  "#FFE135",
  "#FF8A1E",
  "#FF3864",
  "#FF2EE6",
] as const;

/**
 * What an unchosen colour is drawn from: the colourful ones only. Black and
 * white are a statement ("this project should stay quiet") that you make
 * yourself — handed out automatically they would leave two projects
 * indistinguishable.
 */
export const AUTO_PALETTE = BADGE_PALETTE.slice(4);

const HEX = /^#[0-9A-F]{6}$/;
const CONTROL = /[\u0000-\u001F\u007F]/;

export function normalizeColor(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toUpperCase();
  return HEX.test(normalized) ? normalized : null;
}

export function validProjectId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 200 &&
    !CONTROL.test(value)
  );
}

/** Stable, derived from the project id (FNV-1a). */
export function automaticColor(projectId: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < projectId.length; index += 1) {
    hash ^= projectId.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return AUTO_PALETTE[(hash >>> 0) % AUTO_PALETTE.length];
}

export function badgeColor(projectId: string, override: unknown): string {
  return normalizeColor(override) ?? automaticColor(projectId);
}

function channel(value: number): number {
  const srgb = value / 255;
  return srgb <= 0.04045 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4;
}

function luminance(color: string): number {
  const hex = normalizeColor(color);
  if (hex === null) return 0;
  const [red, green, blue] = [1, 3, 5].map((offset) =>
    channel(Number.parseInt(hex.slice(offset, offset + 2), 16)),
  );
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

export function contrastRatio(left: string, right: string): number {
  const first = luminance(left);
  const second = luminance(right);
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
}

/** Type on the badge: black or white, whichever reads better. */
export function badgeForeground(background: string): "#000000" | "#FFFFFF" {
  return contrastRatio(background, "#000000") >=
    contrastRatio(background, "#FFFFFF")
    ? "#000000"
    : "#FFFFFF";
}

export function badgeLetter(name: string): string {
  return name.trim().charAt(0).toLocaleUpperCase() || "?";
}
