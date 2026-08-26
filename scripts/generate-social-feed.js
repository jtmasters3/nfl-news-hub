// Writes social-feed.json: the lightweight, vendor-neutral machine-readable
// feed a downstream creative/posting system (Munch or otherwise) consumes.
// Deliberately NOT a dump of the full news.json story object — only the
// fields a graphic/caption generator actually needs. See
// scripts/lib/socialPayload.js for how story.social is computed.
import { writeFile } from "node:fs/promises";
import { SOCIAL_FEED_JSON_PATH } from "./lib/store.js";

function toFeedEntry(story) {
  const social = story.social;
  return {
    story_id: story.id,
    post_headline: social.post_headline,
    base_image_url: social.base_image_url,
    base_image_source: social.base_image_source,
    base_image_credit: social.base_image_credit,
    caption: social.caption,
    caption_generation: social.caption_generation,
    creative_brief: social.creative_brief,
    source_url: social.source_url,
    source_name: social.source_name,
    source_urls: social.source_urls,
    category: social.category,
    published_at: story.latest_published_at,
    social_status: social.social_status,
  };
}

/**
 * Always writes the full current feed, unconditionally — never gated on
 * whether news.json's content happened to change this run. story.social is
 * pure computation over already-in-memory data (see socialPayload.js), so
 * this is cheap, and "regenerate unconditionally every run" is the
 * simplest possible way to guarantee social-feed.json can never drift out
 * of sync with news.json, without needing a separate staleness check.
 */
export async function generateSocialFeed(stories) {
  const entries = stories.map(toFeedEntry);
  await writeFile(SOCIAL_FEED_JSON_PATH, JSON.stringify(entries, null, 2) + "\n", "utf-8");
  return { count: entries.length };
}
