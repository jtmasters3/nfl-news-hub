/**
 * Absolute, human-readable timestamp for static content (story pages,
 * Munch briefs) — deliberately NOT relative ("3 hours ago"), since that
 * would go stale the moment the file is written. Pinned to America/New_York
 * so output is identical whether generated on a CI runner (UTC) or a local
 * machine in another timezone.
 */
export function formatHumanDateTime(iso) {
  if (!iso) return "(unknown)";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "(unknown)";
  return date.toLocaleString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone: "America/New_York",
    timeZoneName: "short",
  });
}
