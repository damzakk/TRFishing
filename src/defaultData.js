const fs = require("node:fs");
const path = require("node:path");

const gameDataPath = path.join(__dirname, "..", "GAME_DATA.txt");

function cleanId(value) {
  return String(value || "").trim().toLowerCase().replace(/[^a-z0-9_]/g, "_");
}

function readNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function parseGameData() {
  const text = fs.readFileSync(gameDataPath, "utf8");
  const fish = [];
  const rods = [];
  let section = "";

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.startsWith("Fish fields:")) {
      section = "fish";
      continue;
    }
    if (line.startsWith("Rod fields:")) {
      section = "rods";
      continue;
    }
    if (!line || !line.includes("|") || line.startsWith("ID |")) {
      continue;
    }

    const parts = line.split("|").map((part) => part.trim());
    if (section === "fish" && parts.length >= 10) {
      const minWeight = readNumber(parts[4], 0.1);
      const maxWeight = Math.max(minWeight, readNumber(parts[5], minWeight));
      fish.push({
        id: cleanId(parts[0]),
        name: parts[1],
        rarity: parts[2] || "Common",
        baseWeight: readNumber(parts[3], 1),
        minWeight,
        maxWeight,
        luckScale: readNumber(parts[6], 0),
        exp: readNumber(parts[7], 0),
        gold: readNumber(parts[8], 0),
        description: parts.slice(9).join(" | "),
        iconBase64: ""
      });
    }

    if (section === "rods" && parts.length >= 8) {
      rods.push({
        id: cleanId(parts[0]),
        name: parts[1],
        price: readNumber(parts[2], 0),
        speed: Math.max(1, readNumber(parts[3], 1)),
        luck: readNumber(parts[4], 0),
        maxWeight: Math.max(0.01, readNumber(parts[5], 10)),
        accuracy: Math.max(0, Math.min(100, readNumber(parts[6], 50))),
        description: parts.slice(7).join(" | "),
        iconBase64: ""
      });
    }
  }

  return { defaultFish: fish, defaultRods: rods };
}

const { defaultFish, defaultRods } = parseGameData();

module.exports = {
  defaultFish,
  defaultRods
};
