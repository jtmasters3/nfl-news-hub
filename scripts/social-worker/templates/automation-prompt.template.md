# The Aggregate social graphic — automated generation

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
   bottom-left branding area visually clean (dark background/gradient only,
   no text, no mark, no wordmark, no placeholder shape) so that step has
   clear space to work with. Do not read or reference any logo file for
   this purpose, even if one exists in `{{template_pack_dir}}`.
4. Read the base photograph directly from the local file
   `{{base_image_path}}` (already downloaded from `{{source_name}}` and
   verified locally — do not download or fetch it again from any URL).
   Use it as the factual base image. Preserve the real NFL subject's
   identity, face, uniform, jersey number, and photographic realism. Do
   not substitute or invent a player. If this local photograph does not
   clearly show a real, identifiable NFL player (for example, it shows
   only equipment, a logo, or a crowd with no usable subject), do not
   generate a substitute or invented player — treat this as a failure and
   report it exactly per step 15, the same as any other validation
   failure.
5. Treat `BREAKING NEWS: [post_headline]` as creative direction. The words
   `BREAKING NEWS` do not have to appear unless naturally required by the
   selected approved template.
6. Select whichever one of the six references best fits the photograph,
   negative space, subject placement, and headline length.
7. Generate exactly ONE finished 1024 x 1280 (4:5) social-media news
   graphic using the supplied photograph and approved reference system.
8. The fixture's `post_headline` is the only story-specific news copy
   permitted. It must appear verbatim, although capitalization, line
   breaks, typography, and positioning may be adjusted. Do not add facts,
   statistics, quotes, summaries, subheadlines, dates, source copy, or
   explanatory copy.
9. Use The Aggregate black, white, and vivid-red branding, dark gradients,
   condensed high-impact headline typography, and restrained red accents —
   everything EXCEPT the logo itself (per step 3).
10. Do not create a carousel, second slide, alternate concept, explainer,
    follow-up image, or multiple output images.
11. Use the built-in image-generation capability associated with the
    current ChatGPT/Codex login. Do not use an OpenAI API key and do not
    call a separately billed Images API script.
12. Save or copy the single final deliverable to exactly:
    `{{output_path}}`
13. Do not overwrite any unrelated file. If that exact output path already
    exists from a previous attempt for this same story_id, replace only
    that exact file.
14. Before exiting, verify that the saved file exists, is a readable
    nonzero-byte PNG, is 1024 x 1280 or approximately 4:5, contains the
    correct supplied NFL subject, visibly uses The Aggregate color palette
    and typography treatment, leaves the bottom-left branding area clean
    (no logo/wordmark of any kind — that is added afterward, separately),
    and contains the fixture headline without additional story copy.
15. Exit with a concise result stating the output path and verification
    outcome. If generation or validation fails, do not create substitutes
    or additional concepts; report the failure and exit non-successfully
    if possible.
