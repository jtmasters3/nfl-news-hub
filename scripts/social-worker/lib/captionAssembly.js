// Stage 4C: pure, deterministic assembly of the exact Instagram caption
// string from an already-approved record. No AI call, no rewriting, no
// network — this is called once, at posting-claim time, to produce the
// EXACT string that gets snapshotted into Stage 4B's
// publishing.instagram.feed.caption_used (see scripts/lib/postingEvents.js's
// applyPostingClaimedEvent) and never recomputed after that.
//
// record.caption.text already embeds the "Source: ..." attribution line as
// its own last paragraph (see captionEvents.js's applyCaptionCompleteEvent)
// — this function must never duplicate that by also appending
// caption.attribution_line separately.
export function assembleInstagramCaption(record) {
  if (record?.caption?.status !== "ready") {
    return { ok: false, error: "caption_not_ready" };
  }

  const text = record.caption.text;
  if (typeof text !== "string" || !text.trim()) {
    return { ok: false, error: "caption_missing" };
  }

  const hashtags = record.caption.hashtags ?? [];
  if (!Array.isArray(hashtags) || hashtags.some((h) => typeof h !== "string" || !h.trim())) {
    return { ok: false, error: "malformed_hashtags" };
  }

  if (hashtags.length === 0) {
    return { ok: true, caption: text };
  }

  return { ok: true, caption: `${text}\n\n${hashtags.join(" ")}` };
}
