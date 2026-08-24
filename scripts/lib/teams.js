export const TEAMS = [
  { abbr: "ARI", name: "Arizona Cardinals", city: "Arizona", nickname: "Cardinals", aliases: ["Cards"] },
  { abbr: "ATL", name: "Atlanta Falcons", city: "Atlanta", nickname: "Falcons", aliases: [] },
  { abbr: "BAL", name: "Baltimore Ravens", city: "Baltimore", nickname: "Ravens", aliases: [] },
  { abbr: "BUF", name: "Buffalo Bills", city: "Buffalo", nickname: "Bills", aliases: [] },
  { abbr: "CAR", name: "Carolina Panthers", city: "Carolina", nickname: "Panthers", aliases: [] },
  { abbr: "CHI", name: "Chicago Bears", city: "Chicago", nickname: "Bears", aliases: [] },
  { abbr: "CIN", name: "Cincinnati Bengals", city: "Cincinnati", nickname: "Bengals", aliases: [] },
  { abbr: "CLE", name: "Cleveland Browns", city: "Cleveland", nickname: "Browns", aliases: [] },
  { abbr: "DAL", name: "Dallas Cowboys", city: "Dallas", nickname: "Cowboys", aliases: [] },
  { abbr: "DEN", name: "Denver Broncos", city: "Denver", nickname: "Broncos", aliases: [] },
  { abbr: "DET", name: "Detroit Lions", city: "Detroit", nickname: "Lions", aliases: [] },
  { abbr: "GB", name: "Green Bay Packers", city: "Green Bay", nickname: "Packers", aliases: ["GB"] },
  { abbr: "HOU", name: "Houston Texans", city: "Houston", nickname: "Texans", aliases: [] },
  { abbr: "IND", name: "Indianapolis Colts", city: "Indianapolis", nickname: "Colts", aliases: [] },
  { abbr: "JAX", name: "Jacksonville Jaguars", city: "Jacksonville", nickname: "Jaguars", aliases: ["Jags"] },
  { abbr: "KC", name: "Kansas City Chiefs", city: "Kansas City", nickname: "Chiefs", aliases: ["KC"] },
  { abbr: "LV", name: "Las Vegas Raiders", city: "Las Vegas", nickname: "Raiders", aliases: ["Oakland Raiders"] },
  { abbr: "LAC", name: "Los Angeles Chargers", city: "Los Angeles", nickname: "Chargers", aliases: ["LA Chargers", "San Diego Chargers"] },
  { abbr: "LAR", name: "Los Angeles Rams", city: "Los Angeles", nickname: "Rams", aliases: ["LA Rams", "St. Louis Rams"] },
  { abbr: "MIA", name: "Miami Dolphins", city: "Miami", nickname: "Dolphins", aliases: [] },
  { abbr: "MIN", name: "Minnesota Vikings", city: "Minnesota", nickname: "Vikings", aliases: [] },
  { abbr: "NE", name: "New England Patriots", city: "New England", nickname: "Patriots", aliases: ["Pats"] },
  { abbr: "NO", name: "New Orleans Saints", city: "New Orleans", nickname: "Saints", aliases: [] },
  { abbr: "NYG", name: "New York Giants", city: "New York", nickname: "Giants", aliases: ["NY Giants"] },
  { abbr: "NYJ", name: "New York Jets", city: "New York", nickname: "Jets", aliases: ["NY Jets"] },
  { abbr: "PHI", name: "Philadelphia Eagles", city: "Philadelphia", nickname: "Eagles", aliases: [] },
  { abbr: "PIT", name: "Pittsburgh Steelers", city: "Pittsburgh", nickname: "Steelers", aliases: [] },
  { abbr: "SF", name: "San Francisco 49ers", city: "San Francisco", nickname: "49ers", aliases: ["Niners", "SF"] },
  { abbr: "SEA", name: "Seattle Seahawks", city: "Seattle", nickname: "Seahawks", aliases: [] },
  { abbr: "TB", name: "Tampa Bay Buccaneers", city: "Tampa Bay", nickname: "Buccaneers", aliases: ["Bucs"] },
  { abbr: "TEN", name: "Tennessee Titans", city: "Tennessee", nickname: "Titans", aliases: [] },
  { abbr: "WAS", name: "Washington Commanders", city: "Washington", nickname: "Commanders", aliases: ["Washington Football Team"] },
];

export const TEAM_BY_ABBR = Object.fromEntries(TEAMS.map((t) => [t.abbr, t]));

export function teamName(abbr) {
  return TEAM_BY_ABBR[abbr]?.name ?? abbr;
}

/**
 * Detects which teams are mentioned in a piece of text. Matches on full team
 * name, nickname, city, and known aliases as whole words/phrases. Nicknames
 * that collide with common English words ("Bills", "Titans", "Saints") are
 * fine here since false positives just add an extra filter tag, not a fact.
 */
export function detectTeams(text) {
  const found = new Set();

  for (const team of TEAMS) {
    const candidates = [team.name, team.nickname, team.city, ...team.aliases];
    for (const candidate of candidates) {
      if (candidate.length < 4) continue;
      const pattern = new RegExp(`\\b${escapeRegExp(candidate)}\\b`, "i");
      if (pattern.test(text)) {
        found.add(team.abbr);
        break;
      }
    }
  }

  return Array.from(found);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
