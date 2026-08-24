/**
 * Filter chip definitions. `categories` is the set of story.category values
 * a chip matches; omitted for chips with special logic (latest/breaking/rumor)
 * handled directly in app.js.
 */
export const FILTERS = [
  { key: "latest", label: "Latest" },
  { key: "breaking", label: "Breaking" },
  { key: "trade", label: "Trades", categories: ["trade"] },
  { key: "injury", label: "Injuries", categories: ["injury"] },
  { key: "rumor", label: "Rumors" },
  { key: "contract", label: "Contracts", categories: ["contract"] },
  { key: "free_agency", label: "Free Agency", categories: ["free_agency"] },
  { key: "draft", label: "NFL Draft", categories: ["draft"] },
  { key: "fantasy", label: "Fantasy", categories: ["fantasy"] },
  { key: "team_news", label: "Team News", categories: ["team_news", "roster_move", "coaching"] },
];

export const BREAKING_IMPORTANCE_THRESHOLD = 9;
