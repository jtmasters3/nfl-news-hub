# The Aggregate Instagram Story graphic — automated generation

Do not read, claim, update, or write any production queue, social-state,
feed, news, cron, GitHub workflow, or processed-ID file. Do not publish
anything. Do not make any HTTP POST request. Claiming the story and
uploading the finished graphic are both handled outside this session, by
the process that invoked you — your only job is producing the image file.
The base photograph has ALREADY been downloaded and verified locally —
never fetch `base_image_url` or any other URL yourself.

Perform the following workflow as a fresh run using only the local files
named below. Do not rely on conversation history or memory.

1. Read `{{fixture_path}}` (an absolute path).
2. Read the reference guide and these six approved The Aggregate templates
   from `{{template_pack_dir}}`:
   - `01-split-editorial.jpg`
   - `02-action-hero.jpg`
   - `03-breaking-cutout.jpg`
   - `04-compact-mobile.png`
   - `05-dynamic-diagonal.png`
   - `06-cinematic-trade.png`
3. Do NOT render, draw, recreate, approximate, reinterpret, or spell out
   The Aggregate logo or the words "THE AGGREGATE" anywhere in the image.
   The official logo is composited on afterward by a separate deterministic
   step, from the real logo file — never by image generation. Leave the
   bottom-left branding area visually clean (dark background only, no
   text, no mark, no wordmark, no placeholder shape) so that step has
   clear space to work with, respecting the same bottom safe-area margin
   as step 10 below. Do not read or reference any logo file for this
   purpose, even if one exists in `{{template_pack_dir}}`.
4. Read the base photograph directly from the local file
   `{{base_image_path}}` (already downloaded from `{{source_name}}` and
   verified locally — do not download or fetch it again from any URL).
   Use it as the factual base image — the SAME photograph and the SAME
   real NFL subject already used for this story's separate Feed graphic.
   Preserve the real subject's identity, face, uniform, jersey number, and
   photographic realism. Do not substitute or invent a player. If this
   local photograph does not clearly show a real, identifiable NFL player
   (for example, it shows only equipment, a logo, or a crowd with no
   usable subject), do not generate a substitute or invented player —
   treat this as a failure and report it exactly per step 16, the same as
   any other validation failure.
5. Treat `BREAKING NEWS: [post_headline]` as creative direction. The words
   `BREAKING NEWS` do not have to appear unless naturally required.
6. This is a DIFFERENT, independent composition from the Feed graphic —
   NOT a resize, crop, stretch, or repositioned copy of it. Recompose the
   subject and headline specifically for a true 9:16 vertical frame:
   select whichever of the six references best fits the photograph
   recomposed vertically, negative space, subject placement, and headline
   length at this aspect ratio.
7. Generate exactly ONE finished 1080 x 1920 (9:16) vertical social-media
   Story graphic using the supplied photograph and approved reference
   system. A nearby valid 9:16 resolution is acceptable if 1080x1920
   exactly is not achievable; the composition must genuinely be a true
   vertical frame, never a stretched or letterboxed 4:5 image.
8. The fixture's `post_headline` is the only story-specific news copy
   permitted. It must appear verbatim, although capitalization, line
   breaks, typography, and positioning may be adjusted for the vertical
   frame. Do not add facts, statistics, quotes, summaries, subheadlines,
   dates, source copy, or explanatory copy. Do NOT include a full caption
   on the graphic — headline only.
9. Use The Aggregate black, white, and vivid-red branding: a dark/black
   background, bold condensed white headline typography, and restrained
   red accents — everything EXCEPT the logo itself (per step 3) —
   optimized for a phone screen held vertically.
10. Keep the headline fully legible and inside safe areas for a phone
    Story viewer: do not place any critical text (headline) too close to
    the very top or very bottom of the frame, where a viewing app's own UI
    chrome (progress bar, reply field, controls) typically sits, and where
    the deterministically-composited logo will also sit near the bottom.
    Leave clear vertical margin above and below the headline block.
11. Do not create a carousel, second slide, alternate concept, explainer,
    follow-up image, duplicate slide, or multiple output images — exactly
    ONE Story image for this story.
12. Use the built-in image-generation capability associated with the
    current ChatGPT/Codex login. Do not use an OpenAI API key and do not
    call a separately billed Images API script.
13. Save or copy the single final deliverable to exactly:
    `{{output_path}}`
14. Do not overwrite any unrelated file. If that exact output path already
    exists from a previous attempt for this same story_id, replace only
    that exact file.
15. Before exiting, verify that the saved file exists, is a readable
    nonzero-byte PNG, is approximately 9:16 (1080x1920 or a nearby valid
    vertical resolution), contains the correct supplied NFL subject,
    visibly uses The Aggregate color palette and typography treatment,
    leaves the bottom-left branding area clean (no logo/wordmark of any
    kind — that is added afterward, separately), contains the fixture
    headline without additional story copy, and keeps the headline clear
    of the top/bottom safe-area margins.
16. Exit with a concise result stating the output path and verification
    outcome. If generation or validation fails, do not create substitutes
    or additional concepts; report the failure and exit non-successfully
    if possible.
