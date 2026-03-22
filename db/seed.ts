import pg from "pg";
import dotenv from "dotenv";
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: join(__dirname, "..", ".env") });

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

async function seed() {
  const client = await pool.connect();
  try {
    // Run schema
    const schema = readFileSync(join(__dirname, "schema.sql"), "utf-8");
    await client.query(schema);
    console.log("Schema created successfully.");

    // Seed teams
    const teams = [
      { name: "Atlanta Hawks", abbr: "ATL", conf: "East", div: "Southeast", w: 36, l: 46, ppg: 118.2, rpg: 44.1, apg: 26.3, spg: 7.8, bpg: 4.9, fg: 47.5, three: 36.2, ft: 79.1, tov: 14.2 },
      { name: "Boston Celtics", abbr: "BOS", conf: "East", div: "Atlantic", w: 64, l: 18, ppg: 120.6, rpg: 46.8, apg: 27.1, spg: 8.2, bpg: 5.8, fg: 49.2, three: 38.8, ft: 81.3, tov: 12.8 },
      { name: "Brooklyn Nets", abbr: "BKN", conf: "East", div: "Atlantic", w: 32, l: 50, ppg: 110.4, rpg: 43.2, apg: 24.8, spg: 7.1, bpg: 4.3, fg: 45.8, three: 35.1, ft: 77.6, tov: 14.8 },
      { name: "Charlotte Hornets", abbr: "CHA", conf: "East", div: "Southeast", w: 21, l: 61, ppg: 106.8, rpg: 42.5, apg: 24.1, spg: 6.9, bpg: 4.1, fg: 44.9, three: 34.5, ft: 78.2, tov: 15.1 },
      { name: "Chicago Bulls", abbr: "CHI", conf: "East", div: "Central", w: 39, l: 43, ppg: 112.3, rpg: 43.8, apg: 25.6, spg: 7.5, bpg: 4.6, fg: 46.7, three: 35.8, ft: 79.8, tov: 13.5 },
      { name: "Cleveland Cavaliers", abbr: "CLE", conf: "East", div: "Central", w: 48, l: 34, ppg: 110.8, rpg: 44.2, apg: 26.8, spg: 7.3, bpg: 5.2, fg: 47.1, three: 36.9, ft: 78.5, tov: 13.1 },
      { name: "Dallas Mavericks", abbr: "DAL", conf: "West", div: "Southwest", w: 50, l: 32, ppg: 117.9, rpg: 43.5, apg: 26.5, spg: 7.6, bpg: 4.8, fg: 48.1, three: 37.5, ft: 80.2, tov: 13.3 },
      { name: "Denver Nuggets", abbr: "DEN", conf: "West", div: "Northwest", w: 57, l: 25, ppg: 116.7, rpg: 45.1, apg: 28.3, spg: 7.4, bpg: 5.1, fg: 48.5, three: 37.1, ft: 80.8, tov: 13.6 },
      { name: "Detroit Pistons", abbr: "DET", conf: "East", div: "Central", w: 14, l: 68, ppg: 104.5, rpg: 41.8, apg: 23.5, spg: 6.8, bpg: 3.9, fg: 44.2, three: 33.8, ft: 76.9, tov: 15.5 },
      { name: "Golden State Warriors", abbr: "GSW", conf: "West", div: "Pacific", w: 46, l: 36, ppg: 117.1, rpg: 44.8, apg: 29.1, spg: 8.1, bpg: 5.3, fg: 47.8, three: 38.2, ft: 79.5, tov: 14.1 },
      { name: "Houston Rockets", abbr: "HOU", conf: "West", div: "Southwest", w: 41, l: 41, ppg: 111.2, rpg: 44.5, apg: 24.2, spg: 8.5, bpg: 5.6, fg: 45.5, three: 34.8, ft: 77.1, tov: 14.5 },
      { name: "Indiana Pacers", abbr: "IND", conf: "East", div: "Central", w: 47, l: 35, ppg: 123.4, rpg: 43.1, apg: 28.5, spg: 7.9, bpg: 5.1, fg: 49.8, three: 37.8, ft: 80.5, tov: 13.2 },
      { name: "LA Clippers", abbr: "LAC", conf: "West", div: "Pacific", w: 51, l: 31, ppg: 115.8, rpg: 44.6, apg: 25.9, spg: 8.0, bpg: 4.7, fg: 48.3, three: 37.3, ft: 81.1, tov: 13.0 },
      { name: "Los Angeles Lakers", abbr: "LAL", conf: "West", div: "Pacific", w: 47, l: 35, ppg: 117.2, rpg: 45.3, apg: 26.7, spg: 7.7, bpg: 5.4, fg: 47.9, three: 36.5, ft: 78.8, tov: 14.3 },
      { name: "Memphis Grizzlies", abbr: "MEM", conf: "West", div: "Southwest", w: 27, l: 55, ppg: 108.6, rpg: 43.4, apg: 25.3, spg: 7.2, bpg: 5.0, fg: 45.6, three: 34.2, ft: 77.4, tov: 15.2 },
      { name: "Miami Heat", abbr: "MIA", conf: "East", div: "Southeast", w: 46, l: 36, ppg: 110.5, rpg: 43.9, apg: 25.8, spg: 7.6, bpg: 4.5, fg: 46.5, three: 36.1, ft: 80.3, tov: 13.4 },
      { name: "Milwaukee Bucks", abbr: "MIL", conf: "East", div: "Central", w: 49, l: 33, ppg: 119.3, rpg: 47.2, apg: 26.4, spg: 7.3, bpg: 5.9, fg: 48.7, three: 37.6, ft: 78.9, tov: 13.7 },
      { name: "Minnesota Timberwolves", abbr: "MIN", conf: "West", div: "Northwest", w: 56, l: 26, ppg: 112.1, rpg: 46.5, apg: 25.1, spg: 8.3, bpg: 6.2, fg: 46.8, three: 36.4, ft: 79.2, tov: 12.9 },
      { name: "New Orleans Pelicans", abbr: "NOP", conf: "West", div: "Southwest", w: 49, l: 33, ppg: 115.3, rpg: 45.8, apg: 26.2, spg: 7.8, bpg: 5.5, fg: 47.4, three: 36.7, ft: 78.1, tov: 14.0 },
      { name: "New York Knicks", abbr: "NYK", conf: "East", div: "Atlantic", w: 50, l: 32, ppg: 112.9, rpg: 46.1, apg: 25.5, spg: 7.5, bpg: 4.8, fg: 47.2, three: 36.3, ft: 80.6, tov: 13.3 },
      { name: "Oklahoma City Thunder", abbr: "OKC", conf: "West", div: "Northwest", w: 57, l: 25, ppg: 120.1, rpg: 44.3, apg: 27.5, spg: 9.1, bpg: 5.7, fg: 48.9, three: 38.1, ft: 80.1, tov: 12.5 },
      { name: "Orlando Magic", abbr: "ORL", conf: "East", div: "Southeast", w: 47, l: 35, ppg: 110.2, rpg: 44.7, apg: 24.9, spg: 7.4, bpg: 5.8, fg: 46.3, three: 35.5, ft: 77.8, tov: 13.8 },
      { name: "Philadelphia 76ers", abbr: "PHI", conf: "East", div: "Atlantic", w: 47, l: 35, ppg: 114.6, rpg: 44.4, apg: 25.7, spg: 7.7, bpg: 5.3, fg: 47.6, three: 37.0, ft: 81.5, tov: 13.6 },
      { name: "Phoenix Suns", abbr: "PHX", conf: "West", div: "Pacific", w: 49, l: 33, ppg: 116.5, rpg: 43.7, apg: 27.8, spg: 7.5, bpg: 4.6, fg: 48.0, three: 37.4, ft: 80.9, tov: 13.9 },
      { name: "Portland Trail Blazers", abbr: "POR", conf: "West", div: "Northwest", w: 21, l: 61, ppg: 107.3, rpg: 42.9, apg: 23.8, spg: 6.7, bpg: 4.2, fg: 44.7, three: 33.5, ft: 77.3, tov: 15.3 },
      { name: "Sacramento Kings", abbr: "SAC", conf: "West", div: "Pacific", w: 46, l: 36, ppg: 118.8, rpg: 42.8, apg: 27.2, spg: 7.8, bpg: 4.4, fg: 48.4, three: 37.2, ft: 79.7, tov: 14.4 },
      { name: "San Antonio Spurs", abbr: "SAS", conf: "West", div: "Southwest", w: 22, l: 60, ppg: 109.1, rpg: 44.0, apg: 25.0, spg: 7.0, bpg: 5.0, fg: 45.3, three: 34.0, ft: 78.0, tov: 14.7 },
      { name: "Toronto Raptors", abbr: "TOR", conf: "East", div: "Atlantic", w: 25, l: 57, ppg: 108.9, rpg: 43.3, apg: 24.5, spg: 7.1, bpg: 4.5, fg: 45.1, three: 34.3, ft: 77.5, tov: 14.9 },
      { name: "Utah Jazz", abbr: "UTA", conf: "West", div: "Northwest", w: 31, l: 51, ppg: 111.5, rpg: 44.9, apg: 25.4, spg: 7.2, bpg: 5.1, fg: 46.1, three: 35.9, ft: 78.3, tov: 14.1 },
      { name: "Washington Wizards", abbr: "WAS", conf: "East", div: "Southeast", w: 15, l: 67, ppg: 105.2, rpg: 42.1, apg: 23.2, spg: 6.5, bpg: 3.8, fg: 43.8, three: 33.1, ft: 76.5, tov: 15.8 },
    ];

    for (const t of teams) {
      await client.query(
        `INSERT INTO teams (name, abbreviation, conference, division, wins, losses, ppg, rpg, apg, spg, bpg, fg_pct, three_pct, ft_pct, tov)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
         ON CONFLICT DO NOTHING`,
        [t.name, t.abbr, t.conf, t.div, t.w, t.l, t.ppg, t.rpg, t.apg, t.spg, t.bpg, t.fg, t.three, t.ft, t.tov]
      );
    }
    console.log(`Seeded ${teams.length} teams.`);

    // Seed players
    const players = [
      { name: "Luka Doncic", team: "DAL", pos: "PG", ppg: 33.9, rpg: 9.2, apg: 9.8, spg: 1.4, bpg: 0.5, fg: 48.7, three: 35.4, ft: 78.6, tov: 4.0, mpg: 37.5, gp: 70 },
      { name: "Shai Gilgeous-Alexander", team: "OKC", pos: "SG", ppg: 30.1, rpg: 5.5, apg: 6.2, spg: 2.0, bpg: 0.9, fg: 53.5, three: 35.3, ft: 87.4, tov: 2.1, mpg: 34.8, gp: 75 },
      { name: "Giannis Antetokounmpo", team: "MIL", pos: "PF", ppg: 30.4, rpg: 11.5, apg: 6.5, spg: 1.2, bpg: 1.1, fg: 61.1, three: 27.4, ft: 65.7, tov: 3.4, mpg: 35.2, gp: 73 },
      { name: "Jayson Tatum", team: "BOS", pos: "SF", ppg: 26.9, rpg: 8.1, apg: 4.9, spg: 1.0, bpg: 0.6, fg: 47.1, three: 37.6, ft: 83.8, tov: 2.5, mpg: 36.4, gp: 74 },
      { name: "Nikola Jokic", team: "DEN", pos: "C", ppg: 26.4, rpg: 12.4, apg: 9.0, spg: 1.4, bpg: 0.9, fg: 58.3, three: 35.9, ft: 81.7, tov: 3.0, mpg: 34.6, gp: 79 },
      { name: "Anthony Edwards", team: "MIN", pos: "SG", ppg: 25.9, rpg: 5.4, apg: 5.1, spg: 1.3, bpg: 0.5, fg: 46.1, three: 35.7, ft: 83.6, tov: 3.2, mpg: 35.8, gp: 79 },
      { name: "Kevin Durant", team: "PHX", pos: "SF", ppg: 27.1, rpg: 6.6, apg: 5.0, spg: 0.9, bpg: 1.2, fg: 52.3, three: 41.3, ft: 85.6, tov: 3.3, mpg: 37.2, gp: 75 },
      { name: "Stephen Curry", team: "GSW", pos: "PG", ppg: 26.4, rpg: 4.5, apg: 5.1, spg: 0.7, bpg: 0.4, fg: 45.0, three: 40.8, ft: 92.3, tov: 2.8, mpg: 32.7, gp: 74 },
      { name: "LeBron James", team: "LAL", pos: "SF", ppg: 25.7, rpg: 7.3, apg: 8.3, spg: 1.3, bpg: 0.5, fg: 54.0, three: 41.0, ft: 75.0, tov: 3.5, mpg: 35.3, gp: 71 },
      { name: "Joel Embiid", team: "PHI", pos: "C", ppg: 34.7, rpg: 11.0, apg: 5.6, spg: 1.0, bpg: 1.7, fg: 52.9, three: 38.8, ft: 88.3, tov: 3.8, mpg: 33.6, gp: 39, injury_status: "Out", injury_detail: "Knee soreness" },
      { name: "Tyrese Haliburton", team: "IND", pos: "PG", ppg: 20.1, rpg: 3.9, apg: 10.9, spg: 1.2, bpg: 0.3, fg: 47.7, three: 36.4, ft: 85.5, tov: 2.5, mpg: 33.5, gp: 69 },
      { name: "Jaylen Brown", team: "BOS", pos: "SG", ppg: 23.0, rpg: 5.5, apg: 3.6, spg: 1.2, bpg: 0.5, fg: 49.9, three: 35.4, ft: 70.3, tov: 2.5, mpg: 33.9, gp: 70 },
      { name: "Devin Booker", team: "PHX", pos: "SG", ppg: 27.1, rpg: 4.5, apg: 6.9, spg: 1.0, bpg: 0.3, fg: 49.2, three: 36.4, ft: 87.3, tov: 2.9, mpg: 36.2, gp: 68 },
      { name: "Anthony Davis", team: "LAL", pos: "C", ppg: 24.7, rpg: 12.6, apg: 3.5, spg: 1.2, bpg: 2.3, fg: 55.6, three: 27.1, ft: 81.6, tov: 2.1, mpg: 35.5, gp: 76 },
      { name: "Damian Lillard", team: "MIL", pos: "PG", ppg: 24.3, rpg: 4.4, apg: 7.0, spg: 1.0, bpg: 0.3, fg: 42.4, three: 35.4, ft: 92.0, tov: 2.8, mpg: 35.4, gp: 73 },
      { name: "Trae Young", team: "ATL", pos: "PG", ppg: 25.7, rpg: 2.8, apg: 10.8, spg: 1.1, bpg: 0.2, fg: 43.0, three: 37.3, ft: 86.3, tov: 4.4, mpg: 34.8, gp: 73 },
      { name: "De'Aaron Fox", team: "SAC", pos: "PG", ppg: 26.6, rpg: 4.6, apg: 5.6, spg: 2.0, bpg: 0.5, fg: 46.5, three: 32.9, ft: 73.8, tov: 2.6, mpg: 35.8, gp: 74 },
      { name: "Jalen Brunson", team: "NYK", pos: "PG", ppg: 28.7, rpg: 3.5, apg: 6.7, spg: 0.9, bpg: 0.2, fg: 47.9, three: 40.1, ft: 84.7, tov: 2.4, mpg: 35.8, gp: 77 },
      { name: "Donovan Mitchell", team: "CLE", pos: "SG", ppg: 26.6, rpg: 5.1, apg: 5.1, spg: 1.8, bpg: 0.4, fg: 46.2, three: 36.9, ft: 86.7, tov: 2.6, mpg: 34.3, gp: 55 },
      { name: "Kawhi Leonard", team: "LAC", pos: "SF", ppg: 23.7, rpg: 6.1, apg: 3.6, spg: 1.6, bpg: 0.9, fg: 52.5, three: 41.7, ft: 88.5, tov: 1.8, mpg: 34.3, gp: 68, injury_status: "GTD", injury_detail: "Knee management" },
      { name: "Zion Williamson", team: "NOP", pos: "PF", ppg: 22.9, rpg: 5.8, apg: 5.0, spg: 1.1, bpg: 0.7, fg: 57.0, three: 33.3, ft: 71.5, tov: 2.9, mpg: 30.2, gp: 29, injury_status: "Out", injury_detail: "Hamstring injury" },
      { name: "Chet Holmgren", team: "OKC", pos: "C", ppg: 16.5, rpg: 7.9, apg: 2.4, spg: 0.8, bpg: 2.3, fg: 53.0, three: 37.2, ft: 79.5, tov: 1.8, mpg: 29.4, gp: 82 },
      { name: "Victor Wembanyama", team: "SAS", pos: "C", ppg: 21.4, rpg: 10.6, apg: 3.9, spg: 1.2, bpg: 3.6, fg: 46.5, three: 32.5, ft: 79.2, tov: 3.7, mpg: 29.7, gp: 71 },
      { name: "Paolo Banchero", team: "ORL", pos: "PF", ppg: 22.6, rpg: 6.9, apg: 5.4, spg: 0.9, bpg: 0.6, fg: 45.8, three: 33.9, ft: 73.0, tov: 3.1, mpg: 34.1, gp: 80 },
      { name: "Scottie Barnes", team: "TOR", pos: "PF", ppg: 19.9, rpg: 8.2, apg: 6.1, spg: 1.3, bpg: 0.9, fg: 47.2, three: 34.1, ft: 77.8, tov: 2.8, mpg: 34.8, gp: 60 },
      { name: "Bam Adebayo", team: "MIA", pos: "C", ppg: 19.3, rpg: 10.4, apg: 3.9, spg: 1.1, bpg: 0.8, fg: 52.0, three: 18.0, ft: 80.1, tov: 2.6, mpg: 33.8, gp: 71 },
      { name: "Ja Morant", team: "MEM", pos: "PG", ppg: 25.1, rpg: 5.6, apg: 8.1, spg: 0.8, bpg: 0.3, fg: 47.2, three: 30.5, ft: 74.1, tov: 3.4, mpg: 32.5, gp: 9, injury_status: "Out", injury_detail: "Shoulder surgery" },
      { name: "Domantas Sabonis", team: "SAC", pos: "C", ppg: 19.4, rpg: 13.7, apg: 8.2, spg: 0.9, bpg: 0.5, fg: 56.0, three: 37.5, ft: 73.0, tov: 3.2, mpg: 35.2, gp: 82 },
      { name: "Jimmy Butler", team: "MIA", pos: "SF", ppg: 20.8, rpg: 5.3, apg: 5.0, spg: 1.3, bpg: 0.3, fg: 49.9, three: 35.5, ft: 85.0, tov: 2.2, mpg: 33.5, gp: 60 },
      { name: "Paul George", team: "LAC", pos: "SF", ppg: 22.6, rpg: 5.2, apg: 3.5, spg: 1.5, bpg: 0.4, fg: 44.7, three: 37.1, ft: 90.3, tov: 2.1, mpg: 34.5, gp: 74 },
      { name: "Cade Cunningham", team: "DET", pos: "PG", ppg: 22.7, rpg: 4.5, apg: 7.5, spg: 1.0, bpg: 0.4, fg: 44.9, three: 35.5, ft: 86.8, tov: 3.5, mpg: 34.6, gp: 62 },
      { name: "Lauri Markkanen", team: "UTA", pos: "PF", ppg: 23.2, rpg: 8.2, apg: 2.0, spg: 0.6, bpg: 0.5, fg: 48.0, three: 39.1, ft: 87.8, tov: 1.7, mpg: 33.4, gp: 55 },
      { name: "Jaren Jackson Jr.", team: "MEM", pos: "PF", ppg: 22.5, rpg: 5.5, apg: 2.1, spg: 1.0, bpg: 1.6, fg: 48.0, three: 32.5, ft: 80.0, tov: 2.5, mpg: 32.2, gp: 66 },
      { name: "Tyrese Maxey", team: "PHI", pos: "SG", ppg: 25.9, rpg: 3.7, apg: 6.2, spg: 1.0, bpg: 0.5, fg: 45.0, three: 37.3, ft: 87.5, tov: 1.6, mpg: 37.5, gp: 70 },
      { name: "Evan Mobley", team: "CLE", pos: "PF", ppg: 15.7, rpg: 9.4, apg: 3.2, spg: 0.8, bpg: 1.4, fg: 57.8, three: 37.2, ft: 72.0, tov: 1.5, mpg: 33.0, gp: 82 },
      { name: "Franz Wagner", team: "ORL", pos: "SF", ppg: 19.7, rpg: 5.3, apg: 3.7, spg: 1.1, bpg: 0.4, fg: 46.5, three: 34.7, ft: 85.0, tov: 2.2, mpg: 33.8, gp: 72 },
      { name: "Mikal Bridges", team: "BKN", pos: "SF", ppg: 19.6, rpg: 4.5, apg: 3.6, spg: 1.0, bpg: 0.5, fg: 44.5, three: 37.3, ft: 83.5, tov: 1.7, mpg: 35.2, gp: 82 },
      { name: "LaMelo Ball", team: "CHA", pos: "PG", ppg: 23.9, rpg: 5.1, apg: 8.0, spg: 1.8, bpg: 0.3, fg: 43.5, three: 35.5, ft: 87.0, tov: 3.1, mpg: 32.2, gp: 22, injury_status: "Out", injury_detail: "Ankle injury" },
      { name: "DeMar DeRozan", team: "CHI", pos: "SF", ppg: 24.0, rpg: 4.3, apg: 5.3, spg: 1.1, bpg: 0.5, fg: 48.0, three: 33.5, ft: 85.0, tov: 2.1, mpg: 36.0, gp: 79 },
      { name: "Jalen Williams", team: "OKC", pos: "SG", ppg: 19.1, rpg: 4.5, apg: 4.5, spg: 1.4, bpg: 0.7, fg: 53.0, three: 34.2, ft: 76.0, tov: 1.8, mpg: 31.5, gp: 71 },
    ];

    for (const p of players) {
      await client.query(
        `INSERT INTO players (name, team, position, ppg, rpg, apg, spg, bpg, fg_pct, three_pct, ft_pct, tov, mpg, gp, injury_status, injury_detail)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
         ON CONFLICT DO NOTHING`,
        [p.name, p.team, p.pos, p.ppg, p.rpg, p.apg, p.spg, p.bpg, p.fg, p.three, p.ft, p.tov, p.mpg, p.gp,
         (p as any).injury_status || null, (p as any).injury_detail || null]
      );
    }
    console.log(`Seeded ${players.length} players.`);

    // Seed games
    const games = [
      { home: "Boston Celtics", away: "New York Knicks", date: "2026-03-18", hs: 112, as: 108, status: "Final" },
      { home: "Los Angeles Lakers", away: "Golden State Warriors", date: "2026-03-18", hs: 118, as: 121, status: "Final" },
      { home: "Denver Nuggets", away: "Phoenix Suns", date: "2026-03-18", hs: null, as: null, status: "7:00 PM ET" },
      { home: "Milwaukee Bucks", away: "Cleveland Cavaliers", date: "2026-03-18", hs: null, as: null, status: "8:00 PM ET" },
      { home: "Dallas Mavericks", away: "Minnesota Timberwolves", date: "2026-03-18", hs: null, as: null, status: "8:30 PM ET" },
      { home: "Miami Heat", away: "Philadelphia 76ers", date: "2026-03-17", hs: 105, as: 99, status: "Final" },
      { home: "Oklahoma City Thunder", away: "Sacramento Kings", date: "2026-03-17", hs: 128, as: 115, status: "Final" },
      { home: "Indiana Pacers", away: "Chicago Bulls", date: "2026-03-17", hs: 131, as: 124, status: "Final" },
    ];

    for (const g of games) {
      await client.query(
        `INSERT INTO games (home_team, away_team, game_date, home_score, away_score, status)
         VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT DO NOTHING`,
        [g.home, g.away, g.date, g.hs, g.as, g.status]
      );
    }
    console.log(`Seeded ${games.length} games.`);

    // Seed a fantasy league and team
    const leagueRes = await client.query(
      `INSERT INTO fantasy_leagues (name) VALUES ('Demo League') RETURNING id`
    );
    const leagueId = leagueRes.rows[0].id;

    const teamRes = await client.query(
      `INSERT INTO fantasy_teams (league_id, team_name) VALUES ($1, 'My First Team') RETURNING id`,
      [leagueId]
    );
    const teamId = teamRes.rows[0].id;

    // Add some players to the fantasy team
    const rosterPlayers = ["Luka Doncic", "Jayson Tatum", "Nikola Jokic", "Anthony Edwards", "Jaylen Brown"];
    for (const pName of rosterPlayers) {
      const pRes = await client.query(`SELECT id FROM players WHERE name = $1`, [pName]);
      if (pRes.rows.length > 0) {
        await client.query(
          `INSERT INTO fantasy_roster (fantasy_team_id, player_id, slot) VALUES ($1, $2, 'STARTER')
           ON CONFLICT DO NOTHING`,
          [teamId, pRes.rows[0].id]
        );
      }
    }
    console.log("Seeded demo fantasy league, team, and roster.");

    console.log("\nSeed complete!");
  } catch (err) {
    console.error("Seed error:", err);
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

seed();
