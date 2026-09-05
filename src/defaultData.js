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
  const fishBags = [];
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
    if (line.startsWith("Fish Bag fields:")) {
      section = "fishBags";
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
        serverId: "",
        iconBase64: ""
      });
    }

    if (section === "rods" && parts.length >= 8) {
      rods.push({
        id: cleanId(parts[0]),
        name: parts[1],
        rarity: parts[8] || "Common",
        price: readNumber(parts[2], 0),
        speed: Math.max(1, readNumber(parts[3], 1)),
        luck: readNumber(parts[4], 0),
        maxWeight: Math.max(0.01, readNumber(parts[5], 10)),
        accuracy: Math.max(0, Math.min(100, readNumber(parts[6], 50))),
        description: parts.slice(7).join(" | "),
        iconBase64: ""
      });
    }

    if (section === "fishBags" && parts.length >= 6) {
      fishBags.push({
        id: cleanId(parts[0]),
        name: parts[1],
        rarity: parts[2] || "Common",
        price: readNumber(parts[3], 0),
        spaceKg: Math.max(1, readNumber(parts[4], 50)),
        description: parts.slice(5).join(" | "),
        iconBase64: ""
      });
    }
  }

  return { defaultFish: fish, defaultRods: rods, defaultFishBags: fishBags };
}

const { defaultFish, defaultRods, defaultFishBags } = parseGameData();

const defaultRodBonuses = {
  pancing_legenda: [
    { id: "fishcomp_focus", type: "accuracy", value: 3, mode: "competition", target: "self", condition: "", description: "+3 Accuracy saat FishComp." }
  ],
  pancing_mistis_abadi: [
    { id: "raid_focus", type: "accuracy", value: 4, mode: "raid", target: "self", condition: "", description: "+4 Accuracy saat FishRaid." }
  ],
  pancing_pembelah_kahyangan: [
    { id: "fishcomp_precision", type: "accuracy", value: 5, mode: "competition", target: "self", condition: "", description: "+5 Accuracy saat FishComp." }
  ],
  pancing_keraton_jawa_keramat_surgawi: [
    { id: "raid_aura", type: "accuracy", value: 6, mode: "raid", target: "self", condition: "", description: "+6 Accuracy saat FishRaid." }
  ],
  pancing_kosmik: [
    { id: "duel_focus", type: "accuracy", value: 5, mode: "duel", target: "self", condition: "", description: "+5 Accuracy saat FishDuel." }
  ]
};

const defaultFishBagBonuses = {
  tas_ransel_nelayan: [
    { id: "underdog_capacity", type: "spaceKg", value: 20, mode: "duel", target: "self", condition: "opponent_higher_level", description: "+20 Kg Capacity saat duel melawan pemain level lebih tinggi." }
  ],
  tas_kulkas_portabel: [
    { id: "steady_capacity", type: "spaceKg", value: 35, mode: "duel", target: "self", condition: "", description: "+35 Kg Capacity saat FishDuel." }
  ],
  tas_dermawan_legenda: [
    { id: "legendary_capacity", type: "spaceKg", value: 75, mode: "duel", target: "self", condition: "", description: "+75 Kg Capacity saat FishDuel." }
  ],
  tas_kahyangan_gotong_royong: [
    { id: "high_level_grace", type: "spaceKg", value: 150, mode: "duel", target: "self", condition: "opponent_higher_level", description: "+150 Kg Capacity saat duel melawan pemain level lebih tinggi." }
  ]
};

for (const rod of defaultRods) {
  rod.bonuses = defaultRodBonuses[rod.id] || [];
}

for (const bag of defaultFishBags) {
  bag.bonuses = defaultFishBagBonuses[bag.id] || [];
}

module.exports = {
  defaultFish,
  defaultRods,
  defaultFishBags
};
