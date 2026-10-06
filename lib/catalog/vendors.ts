/**
 * Only products from these vendors are imported into the catalog and shown on
 * the storefront. Compared case-insensitively on the trimmed vendor string.
 */
const ALLOWED_VENDORS = new Set(["trackify"]);

export function isAllowedVendor(vendor: string | null | undefined): boolean {
  return ALLOWED_VENDORS.has((vendor ?? "").trim().toLowerCase());
}

/** Shopify Admin search filter so the API returns only allowed vendors. */
export const VENDOR_SEARCH_QUERY = "vendor:Trackify";
