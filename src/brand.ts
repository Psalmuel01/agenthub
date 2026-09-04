/** Shared AgentHub mark used by every HTML surface and favicon route. */
export const BRAND_MARK_PATH = "M9 22 L16 9 L23 22";

export const BRAND_FAVICON_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">' +
  '<rect width="32" height="32" rx="7" fill="#00806a"/>' +
  `<path d="${BRAND_MARK_PATH}" stroke="#fff" stroke-width="2.4" fill="none" ` +
  'stroke-linecap="round" stroke-linejoin="round"/></svg>';

export const BRAND_FAVICON =
  "data:image/svg+xml," + encodeURIComponent(BRAND_FAVICON_SVG);

export const BRAND_LOGO =
  '<span class="brand-mark" aria-hidden="true"><svg viewBox="0 0 32 32">' +
  '<rect width="32" height="32" rx="7" fill="currentColor"/>' +
  `<path d="${BRAND_MARK_PATH}" stroke="white" stroke-width="2.4" fill="none" ` +
  'stroke-linecap="round" stroke-linejoin="round"/></svg></span>';
