require("dotenv").config();

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const {
  adminDeletePlayer,
  adminGetManagerTabData,
  adminGetGameData,
  adminGetPlayerRecord,
  adminListPlayers,
  adminResetPlayerData,
  adminSaveManagerTabData,
  adminSavePlayerData,
  makeDefaultPlayer
} = require("./playfab");
const { defaultFish, defaultRods, defaultFishBags } = require("./defaultData");
const { extensionFromContentType, getCachedImageForUrl, rememberCachedImageForUrl } = require("./imageUtils");
const { resolveDiscordStoredImage } = require("./discordStorage");

const port = Number(process.env.MANAGER_PORT || 3000);
const prefix = process.env.PREFIX || "!";
const runtimeDirectory = path.join(__dirname, "..", ".runtime");
const configSignalPath = path.join(runtimeDirectory, "config-refresh.json");
const enforcedFishingSignalPath = path.join(runtimeDirectory, "enforced-fishing.json");
const giveMoneySignalPath = path.join(runtimeDirectory, "give-money.json");
const fishEntotRefreshSignalPath = path.join(runtimeDirectory, "fish-entot-refresh.json");
const defaultFishingChannelsPath = path.join(runtimeDirectory, "default-fishing-channels.json");
const fishRaidStatePath = path.join(runtimeDirectory, "fish-raid-state.json");
const fishRaidSignalPath = path.join(runtimeDirectory, "fish-raid-signal.json");

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, { "Content-Type": "application/json" });
  response.end(JSON.stringify(payload));
}

function startProgressResponse(response) {
  response.writeHead(200, {
    "Content-Type": "application/x-ndjson; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    "X-Content-Type-Options": "nosniff"
  });
}

function sendProgress(response, payload) {
  response.write(`${JSON.stringify(payload)}\n`);
}

function sendBinary(response, statusCode, buffer, contentType, cacheSeconds = 86400) {
  response.writeHead(statusCode, {
    "Content-Type": contentType,
    "Cache-Control": `private, max-age=${cacheSeconds}`,
    "Content-Length": buffer.length
  });
  response.end(buffer);
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
      if (body.length > 5_000_000) {
        request.destroy();
        reject(new Error("Request body is too large. Use image URLs for big store/event images instead of uploading a large file through the manager."));
      }
    });
    request.on("end", () => resolve(body));
    request.on("error", reject);
  });
}

function isAllowedImageContentType(contentType) {
  return ["image/png", "image/jpeg", "image/jpg", "image/gif", "image/webp"].includes(String(contentType || "").split(";")[0].trim().toLowerCase());
}

async function serveCachedImage(requestUrl, response) {
  const sourceUrl = String(requestUrl.searchParams.get("url") || "").trim();
  const messageUrl = String(requestUrl.searchParams.get("messageUrl") || "").trim();
  const fileName = String(requestUrl.searchParams.get("name") || "image.png").trim();
  if (!sourceUrl && !messageUrl) {
    sendJson(response, 400, { error: "Missing image source." });
    return;
  }

  try {
    const image = await resolveDiscordStoredImage({ messageUrl, fallbackUrl: sourceUrl, fileName });
    if (!image?.buffer?.length) {
      throw new Error("No image could be recovered.");
    }
    sendBinary(response, 200, image.buffer, image.contentType || "application/octet-stream");
  } catch (error) {
    console.warn(`Manager image recovery failed | time=${new Date().toISOString()} | image=${fileName} | messageUrl=${messageUrl || "none"} | url=${sourceUrl || "none"} | message=${error.message}`);
    sendJson(response, 502, { error: "Image could not be recovered." });
  }
}

function cleanNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function imageNeedsRehost(source, key) {
  return source?.[`${key}NeedsRehost`] === true;
}

function cleanItemBonuses(bonuses) {
  return (Array.isArray(bonuses) ? bonuses : []).map((bonus, index) => {
    const source = bonus && typeof bonus === "object" ? bonus : {};
    return {
      id: String(source.id || `bonus_${index + 1}`).trim().toLowerCase().replace(/[^a-z0-9_:-]/g, "_"),
      type: String(source.type || "").trim(),
      value: cleanNumber(source.value, 0),
      mode: String(source.mode || "").trim(),
      target: String(source.target || "").trim(),
      condition: String(source.condition || "").trim(),
      description: String(source.description || "").trim()
    };
  }).filter((bonus) => bonus.id && bonus.type);
}

const fishLuckRarityBaseScores = {
  Common: 1000,
  Uncommon: 2500,
  Rare: 4000,
  Epic: 5500,
  Legendary: 7000,
  Secret: 8500,
  Mythic: 10000,
  Divine: 11500,
  Celestial: 13000,
  Abyssal: 14500,
  Transcendent: 16000
};

function getFishLuckRarityBaseScore(rarity) {
  const rarityName = String(rarity || "Common").trim();
  if (fishLuckRarityBaseScores[rarityName] !== undefined) {
    return fishLuckRarityBaseScores[rarityName];
  }
  return 1000;
}

function normalizeLogRange(value, min, max) {
  const safeValue = Math.max(0, Number(value || 0));
  const safeMin = Math.max(0, Number(min || 0));
  const safeMax = Math.max(safeMin, Number(max || safeMin));
  if (safeMax <= safeMin) {
    return 0;
  }
  const minLog = Math.log10(safeMin + 1);
  const maxLog = Math.log10(safeMax + 1);
  return (Math.log10(safeValue + 1) - minLog) / Math.max(0.000001, maxLog - minLog);
}

function getFishLuckScoreRanges(fish) {
  const fishEntries = Array.isArray(fish) ? fish : [];
  const baseWeights = fishEntries.map((entry) => Math.max(0, Number(entry.baseWeight || 0))).filter((value) => value > 0);
  const minWeights = fishEntries.map((entry) => Math.max(0, Number(entry.minWeight || 0))).filter((value) => value > 0);
  return {
    minBaseWeight: Math.min(...baseWeights, 1),
    maxBaseWeight: Math.max(...baseWeights, 1),
    minWeight: Math.min(...minWeights, 0.01),
    maxWeight: Math.max(...minWeights, 0.01)
  };
}

function formatFishLuckScore(fishEntry, fishPool = []) {
  if (!fishEntry || typeof fishEntry !== "object") {
    return Math.max(0, Math.round((1 + Number(fishEntry || 0)) * 5000));
  }
  const ranges = getFishLuckScoreRanges(fishPool.length ? fishPool : [fishEntry]);
  const baseScore = getFishLuckRarityBaseScore(fishEntry.rarity);
  const scarcityScore = Math.round((1 - normalizeLogRange(fishEntry.baseWeight, ranges.minBaseWeight, ranges.maxBaseWeight)) * 700);
  const weightScore = Math.round(normalizeLogRange(fishEntry.minWeight, ranges.minWeight, ranges.maxWeight) * 500);
  return Math.max(0, baseScore + scarcityScore + weightScore);
}

function findFishEntryByRecord(fish, record) {
  const fishId = String(record?.fishId || "").trim();
  const fishName = String(record?.name || "").trim();
  return (Array.isArray(fish) ? fish : []).find((entry) => entry.id === fishId || entry.name === fishName) || null;
}

function makeLuckiestFishRecord(fishEntry, fishPool = []) {
  return {
    fishId: fishEntry.id,
    name: fishEntry.name,
    luckScale: Number(fishEntry.luckScale || 0),
    score: formatFishLuckScore(fishEntry, fishPool)
  };
}

function cleanPlayer(player) {
  const source = player && typeof player === "object" ? player : {};
  const starterRodId = defaultRods[0]?.id || "twig";
  const inventory = source.inventory && typeof source.inventory === "object" && !Array.isArray(source.inventory)
    ? Object.fromEntries(Object.entries(source.inventory).map(([fishId, quantity]) => [String(fishId), Math.max(0, Math.floor(cleanNumber(quantity, 0)))]))
    : {};
  const fishDex = source.fishDex && typeof source.fishDex === "object" && !Array.isArray(source.fishDex)
    ? source.fishDex
    : {};
  const ownedRods = Array.isArray(source.ownedRods) && source.ownedRods.length
    ? source.ownedRods.map((rodId) => String(rodId || "").trim()).filter(Boolean)
    : [starterRodId];
  const ownedFishBags = Array.isArray(source.ownedFishBags)
    ? source.ownedFishBags.map((bagId) => String(bagId || "").trim()).filter(Boolean)
    : [];
  return {
    ...makeDefaultPlayer(),
    discordUserId: String(source.discordUserId || "").trim(),
    discordUsername: String(source.discordUsername || "").trim(),
    discordGlobalName: String(source.discordGlobalName || "").trim(),
    discordDisplayName: String(source.discordDisplayName || "").trim(),
    discordAvatarUrl: String(source.discordAvatarUrl || "").trim(),
    gold: Math.max(0, Math.floor(cleanNumber(source.gold, 0))),
    exp: Math.max(0, Math.floor(cleanNumber(source.exp, 0))),
    rodId: String(source.rodId || ownedRods[0] || starterRodId).trim(),
    ownedRods,
    fishBagId: String(source.fishBagId || "").trim(),
    ownedFishBags,
    inventory,
    fishDex,
    showcasedFishId: String(source.showcasedFishId || "").trim(),
    fishEntotLastUsedAt: Math.max(0, cleanNumber(source.fishEntotLastUsedAt, 0)),
    totalFishCaught: Math.max(0, Math.floor(cleanNumber(source.totalFishCaught, Object.values(inventory).reduce((sum, quantity) => sum + quantity, 0)))),
    fishCompWins: Math.max(0, Math.floor(cleanNumber(source.fishCompWins, 0))),
    heaviestFish: source.heaviestFish && typeof source.heaviestFish === "object" ? source.heaviestFish : null,
    luckiestFish: source.luckiestFish && typeof source.luckiestFish === "object" ? source.luckiestFish : null,
    progress: Math.max(0, Math.floor(cleanNumber(source.progress, 0))),
    lastCountedAt: Math.max(0, cleanNumber(source.lastCountedAt, 0)),
    lastMessage: String(source.lastMessage || ""),
    lastFishingGuildId: String(source.lastFishingGuildId || "").trim(),
    lastFishingChannelId: String(source.lastFishingChannelId || "").trim(),
    voiceTotalMs: Math.max(0, cleanNumber(source.voiceTotalMs, 0)),
    voiceExpRemainderMs: Math.max(0, cleanNumber(source.voiceExpRemainderMs, 0)),
    dailyLastClaimedAt: Math.max(0, cleanNumber(source.dailyLastClaimedAt, 0)),
    dailyStreak: Math.max(0, Math.floor(cleanNumber(source.dailyStreak, 0)))
  };
}

function rollCatchWeight(fish, rod) {
  const minWeight = Math.max(0.01, Number(fish.minWeight || 0.1));
  const fishMaxWeight = Math.max(minWeight, Number(fish.maxWeight || minWeight));
  const rodMaxWeight = Number(rod.maxWeight || fishMaxWeight);
  const maxWeight = Math.max(minWeight, Math.min(fishMaxWeight, rodMaxWeight));
  return minWeight + Math.random() * (maxWeight - minWeight);
}

function rollFishForManager(data, player, selectedFishId = "") {
  const rods = Array.isArray(data.rods) ? data.rods : [];
  const fish = Array.isArray(data.fish) ? data.fish : [];
  const rod = rods.find((entry) => entry.id === player.rodId) || rods[0];
  if (!rod || !fish.length) {
    throw new Error("Fishing data is not ready yet.");
  }
  const forcedFishId = String(selectedFishId || "").trim();
  if (forcedFishId) {
    const selectedFish = fish.find((entry) => String(entry.id || "") === forcedFishId);
    if (!selectedFish) {
      throw new Error("Selected fish was not found.");
    }
    return { fish: selectedFish, catchWeight: rollCatchWeight(selectedFish, rod) };
  }
  const rodMaxWeight = Number(rod.maxWeight || Infinity);
  const guildId = String(player.lastFishingGuildId || "").trim();
  const fishSource = fish.filter((entry) => {
    const serverId = String(entry.serverId || "").trim();
    return !serverId || (guildId && serverId === guildId);
  });
  if (!fishSource.length) {
    throw new Error("No fish are available for this player's saved server.");
  }
  const fishPool = fishSource.filter((entry) => Number(entry.minWeight || 0) <= rodMaxWeight);
  const weightedFish = (fishPool.length ? fishPool : fish).map((entry) => ({
    fish: entry,
    weight: Math.max(0.1, Number(entry.baseWeight || 0) + Number(rod.luck || 0) * Number(entry.luckScale || 0))
  }));
  const totalWeight = weightedFish.reduce((sum, entry) => sum + entry.weight, 0);
  let roll = Math.random() * totalWeight;
  for (const entry of weightedFish) {
    roll -= entry.weight;
    if (roll <= 0) {
      return { fish: entry.fish, catchWeight: rollCatchWeight(entry.fish, rod) };
    }
  }
  const fallback = weightedFish[0]?.fish;
  return { fish: fallback, catchWeight: rollCatchWeight(fallback, rod) };
}

function normalizeEventBonuses(event) {
  return Array.isArray(event?.bonuses) && event.bonuses.length
    ? event.bonuses
    : [{ type: event?.type, value: event?.value, fishId: event?.fishId }];
}

function isEventRunning(event) {
  if (!event?.title || !event.endsAt || event.stoppedAt) {
    return false;
  }
  const now = Date.now();
  const startsAt = event.startAt ? Date.parse(event.startAt) : Date.parse(event.deployedAt || 0);
  return startsAt <= now && Date.parse(event.endsAt) > now;
}

function getManagerEventMultiplier(data, type, guildId = "", fishId = "") {
  const events = cleanEvents(data.events, data.activeEvent);
  return events.filter((event) => isEventRunning(event) && event.guildId && event.guildId === guildId).reduce((multiplier, event) => {
    const eventMultiplier = normalizeEventBonuses(event)
      .filter((bonus) => bonus.type === type)
      .filter((bonus) => type !== "fish_chance" || !bonus.fishId || bonus.fishId === fishId)
      .reduce((bonusMultiplier, bonus) => bonusMultiplier * Math.max(0, Number(bonus.value || 1)), 1);
    return multiplier * eventMultiplier;
  }, 1);
}

function addManagerCatch(data, player, caughtFish, catchWeight) {
  const settings = data.settings || {};
  const guildId = String(player.lastFishingGuildId || "").trim();
  const expBase = Math.max(0, Math.round(Number(caughtFish.exp || 0) * Number(settings.expMultiplier || 1)));
  const expMultiplier = getManagerEventMultiplier(data, "exp_multiplier", guildId);
  const expGain = Math.max(0, Math.round(expBase * expMultiplier));
  const luckScore = formatFishLuckScore(caughtFish, data.fish);
  player.inventory[caughtFish.id] = (player.inventory[caughtFish.id] || 0) + 1;
  player.fishDex = player.fishDex && typeof player.fishDex === "object" && !Array.isArray(player.fishDex) ? player.fishDex : {};
  const dexEntry = player.fishDex[caughtFish.id] && typeof player.fishDex[caughtFish.id] === "object"
    ? player.fishDex[caughtFish.id]
    : {};
  player.fishDex[caughtFish.id] = {
    count: Math.max(0, Math.floor(cleanNumber(dexEntry.count, 0))) + 1,
    heaviestWeight: Math.max(0, cleanNumber(dexEntry.heaviestWeight, 0), Number(catchWeight || 0))
  };
  player.totalFishCaught = Math.max(0, Number(player.totalFishCaught || 0)) + 1;
  if (!player.heaviestFish || Number(catchWeight || 0) > Number(player.heaviestFish.weight || 0)) {
    player.heaviestFish = { fishId: caughtFish.id, name: caughtFish.name, weight: Number(catchWeight || 0) };
  }
  const currentLuckiestFish = findFishEntryByRecord(data.fish, player.luckiestFish);
  const currentLuckiestScore = currentLuckiestFish
    ? formatFishLuckScore(currentLuckiestFish, data.fish)
    : Number(player.luckiestFish?.score || 0);
  if (!player.luckiestFish || luckScore > currentLuckiestScore) {
    player.luckiestFish = makeLuckiestFishRecord(caughtFish, data.fish);
  } else if (currentLuckiestFish) {
    player.luckiestFish = makeLuckiestFishRecord(currentLuckiestFish, data.fish);
  }
  player.exp += expGain;
  player.progress = 0;
  return {
    expGain,
    expBase,
    expEventInfo: {
      multiplier: expMultiplier,
      active: Math.abs(expMultiplier - 1) > 0.000001
    },
    luckScore
  };
}

function cleanItem(item, type) {
  const common = {
    id: String(item.id || "").trim().toLowerCase().replace(/[^a-z0-9_]/g, "_"),
    name: String(item.name || "").trim(),
    iconBase64: String(item.iconBase64 || ""),
    iconUrl: String(item.iconUrl || "").trim(),
    iconMessageUrl: String(item.iconMessageUrl || item.iconRef?.messageUrl || "").trim(),
    iconRef: item.iconRef && typeof item.iconRef === "object" ? item.iconRef : null,
    iconNeedsRehost: item.iconNeedsRehost === true,
    bonuses: cleanItemBonuses(item.bonuses)
  };

  if (!common.id || !common.name) {
    throw new Error("Every item needs an ID and name.");
  }

  if (type === "fish") {
    const minWeight = cleanNumber(item.minWeight, cleanNumber(item.baseWeight, 1));
    const maxWeight = Math.max(minWeight, cleanNumber(item.maxWeight, minWeight));
    const descriptions = Array.isArray(item.descriptions)
      ? item.descriptions.map((description) => String(description || "").trim()).filter(Boolean)
      : String(item.description || "").split(/\r?\n/).map((description) => description.trim()).filter(Boolean);
    return {
      ...common,
      rarity: String(item.rarity || "Common").trim(),
      baseWeight: cleanNumber(item.baseWeight, 1),
      minWeight,
      maxWeight,
      luckScale: cleanNumber(item.luckScale, 0),
      exp: cleanNumber(item.exp, 0),
      gold: cleanNumber(item.gold, 0),
      serverId: String(item.serverId || "").trim(),
      description: descriptions[0] || "",
      descriptions
    };
  }

  if (type === "fishBag") {
    return {
      ...common,
      rarity: String(item.rarity || "Common").trim(),
      price: Math.max(0, cleanNumber(item.price, 0)),
      spaceKg: Math.max(1, cleanNumber(item.spaceKg ?? item.space ?? item.maxWeight, 50)),
      description: String(item.description || "").trim()
    };
  }

  return {
    ...common,
    rarity: String(item.rarity || "Common").trim(),
    price: cleanNumber(item.price, 0),
    speed: Math.max(1, cleanNumber(item.speed, 1)),
    luck: cleanNumber(item.luck, 0),
    maxWeight: Math.max(0.01, cleanNumber(item.maxWeight, 10)),
    accuracy: Math.max(0, Math.min(100, cleanNumber(item.accuracy, 50))),
    description: String(item.description || "").trim()
  };
}

function cleanSettings(settings) {
  const source = settings && typeof settings === "object" ? settings : {};
  const rodStoreImageUrl = String(source.rodStoreImageUrl || "").trim();
  const fishCompBannerUrl = String(source.fishCompBannerUrl || "").trim();
  const fishCompRegistrationBannerUrl = String(source.fishCompRegistrationBannerUrl || "").trim();
  const fishCompRunningBannerUrl = String(source.fishCompRunningBannerUrl || "").trim();
  const fishCompResultBannerUrl = String(source.fishCompResultBannerUrl || "").trim();
  const fishRaidBannerUrl = String(source.fishRaidBannerUrl || "").trim();
  const fishRaidRegistrationBannerUrl = String(source.fishRaidRegistrationBannerUrl || "").trim();
  const fishRaidRunningBannerUrl = String(source.fishRaidRunningBannerUrl || "").trim();
  const fishRaidResultBannerUrl = String(source.fishRaidResultBannerUrl || "").trim();
  const fishDuelRegistrationBannerUrl = String(source.fishDuelRegistrationBannerUrl || "").trim();
  const fishDuelRunningBannerUrl = String(source.fishDuelRunningBannerUrl || "").trim();
  const fishDuelResultBannerUrl = String(source.fishDuelResultBannerUrl || "").trim();
  const fishGuideBannerUrl = String(source.fishGuideBannerUrl || "").trim();
  const fishHelpBannerUrl = String(source.fishHelpBannerUrl || "").trim();
  const sellFishBannerUrl = String(source.sellFishBannerUrl || "").trim();
  return {
    rodStoreImageBase64: String(source.rodStoreImageBase64 || ""),
    rodStoreImageUrl,
    rodStoreImageRef: source.rodStoreImageRef && typeof source.rodStoreImageRef === "object" ? source.rodStoreImageRef : null,
    rodStoreImageUrlNeedsRehost: imageNeedsRehost(source, "rodStoreImageUrl"),
    fishCompBannerBase64: String(source.fishCompBannerBase64 || ""),
    fishCompBannerUrl,
    fishCompBannerRef: source.fishCompBannerRef && typeof source.fishCompBannerRef === "object" ? source.fishCompBannerRef : null,
    fishCompBannerUrlNeedsRehost: imageNeedsRehost(source, "fishCompBannerUrl"),
    fishCompRegistrationBannerBase64: String(source.fishCompRegistrationBannerBase64 || ""),
    fishCompRegistrationBannerUrl,
    fishCompRegistrationBannerRef: source.fishCompRegistrationBannerRef && typeof source.fishCompRegistrationBannerRef === "object" ? source.fishCompRegistrationBannerRef : null,
    fishCompRegistrationBannerUrlNeedsRehost: imageNeedsRehost(source, "fishCompRegistrationBannerUrl"),
    fishCompRunningBannerBase64: String(source.fishCompRunningBannerBase64 || ""),
    fishCompRunningBannerUrl,
    fishCompRunningBannerRef: source.fishCompRunningBannerRef && typeof source.fishCompRunningBannerRef === "object" ? source.fishCompRunningBannerRef : null,
    fishCompRunningBannerUrlNeedsRehost: imageNeedsRehost(source, "fishCompRunningBannerUrl"),
    fishCompResultBannerBase64: String(source.fishCompResultBannerBase64 || ""),
    fishCompResultBannerUrl,
    fishCompResultBannerRef: source.fishCompResultBannerRef && typeof source.fishCompResultBannerRef === "object" ? source.fishCompResultBannerRef : null,
    fishCompResultBannerUrlNeedsRehost: imageNeedsRehost(source, "fishCompResultBannerUrl"),
    fishRaidBannerBase64: String(source.fishRaidBannerBase64 || ""),
    fishRaidBannerUrl,
    fishRaidBannerRef: source.fishRaidBannerRef && typeof source.fishRaidBannerRef === "object" ? source.fishRaidBannerRef : null,
    fishRaidBannerUrlNeedsRehost: imageNeedsRehost(source, "fishRaidBannerUrl"),
    fishRaidRegistrationBannerBase64: String(source.fishRaidRegistrationBannerBase64 || ""),
    fishRaidRegistrationBannerUrl,
    fishRaidRegistrationBannerRef: source.fishRaidRegistrationBannerRef && typeof source.fishRaidRegistrationBannerRef === "object" ? source.fishRaidRegistrationBannerRef : null,
    fishRaidRegistrationBannerUrlNeedsRehost: imageNeedsRehost(source, "fishRaidRegistrationBannerUrl"),
    fishRaidRunningBannerBase64: String(source.fishRaidRunningBannerBase64 || ""),
    fishRaidRunningBannerUrl,
    fishRaidRunningBannerRef: source.fishRaidRunningBannerRef && typeof source.fishRaidRunningBannerRef === "object" ? source.fishRaidRunningBannerRef : null,
    fishRaidRunningBannerUrlNeedsRehost: imageNeedsRehost(source, "fishRaidRunningBannerUrl"),
    fishRaidResultBannerBase64: String(source.fishRaidResultBannerBase64 || ""),
    fishRaidResultBannerUrl,
    fishRaidResultBannerRef: source.fishRaidResultBannerRef && typeof source.fishRaidResultBannerRef === "object" ? source.fishRaidResultBannerRef : null,
    fishRaidResultBannerUrlNeedsRehost: imageNeedsRehost(source, "fishRaidResultBannerUrl"),
    fishDuelRegistrationBannerBase64: String(source.fishDuelRegistrationBannerBase64 || ""),
    fishDuelRegistrationBannerUrl,
    fishDuelRegistrationBannerRef: source.fishDuelRegistrationBannerRef && typeof source.fishDuelRegistrationBannerRef === "object" ? source.fishDuelRegistrationBannerRef : null,
    fishDuelRegistrationBannerUrlNeedsRehost: imageNeedsRehost(source, "fishDuelRegistrationBannerUrl"),
    fishDuelRunningBannerBase64: String(source.fishDuelRunningBannerBase64 || ""),
    fishDuelRunningBannerUrl,
    fishDuelRunningBannerRef: source.fishDuelRunningBannerRef && typeof source.fishDuelRunningBannerRef === "object" ? source.fishDuelRunningBannerRef : null,
    fishDuelRunningBannerUrlNeedsRehost: imageNeedsRehost(source, "fishDuelRunningBannerUrl"),
    fishDuelResultBannerBase64: String(source.fishDuelResultBannerBase64 || ""),
    fishDuelResultBannerUrl,
    fishDuelResultBannerRef: source.fishDuelResultBannerRef && typeof source.fishDuelResultBannerRef === "object" ? source.fishDuelResultBannerRef : null,
    fishDuelResultBannerUrlNeedsRehost: imageNeedsRehost(source, "fishDuelResultBannerUrl"),
    fishGuideBannerBase64: String(source.fishGuideBannerBase64 || ""),
    fishGuideBannerUrl,
    fishGuideBannerRef: source.fishGuideBannerRef && typeof source.fishGuideBannerRef === "object" ? source.fishGuideBannerRef : null,
    fishGuideBannerUrlNeedsRehost: imageNeedsRehost(source, "fishGuideBannerUrl"),
    fishHelpBannerBase64: String(source.fishHelpBannerBase64 || ""),
    fishHelpBannerUrl,
    fishHelpBannerRef: source.fishHelpBannerRef && typeof source.fishHelpBannerRef === "object" ? source.fishHelpBannerRef : null,
    fishHelpBannerUrlNeedsRehost: imageNeedsRehost(source, "fishHelpBannerUrl"),
    sellFishBannerBase64: String(source.sellFishBannerBase64 || ""),
    sellFishBannerUrl,
    sellFishBannerRef: source.sellFishBannerRef && typeof source.sellFishBannerRef === "object" ? source.sellFishBannerRef : null,
    sellFishBannerUrlNeedsRehost: imageNeedsRehost(source, "sellFishBannerUrl"),
    fishCompEvents: cleanFishCompEvents(source.fishCompEvents),
    fishRaidEvents: cleanFishCompEvents(source.fishRaidEvents),
    fishDuelEvents: cleanFishCompEvents(source.fishDuelEvents),
    fishRaidBosses: cleanFishRaidBosses(source.fishRaidBosses),
    fishCompLogIntervalMs: Math.max(0, cleanNumber(source.fishCompLogIntervalMs, 2500)),
    fishCompExpReward: Math.max(0, cleanNumber(source.fishCompExpReward, 50)),
    fishCompGoldReward: Math.max(0, cleanNumber(source.fishCompGoldReward, 0)),
    fishDuelExpReward: Math.max(0, cleanNumber(source.fishDuelExpReward, 40)),
    fishDuelLogIntervalMs: Math.max(0, cleanNumber(source.fishDuelLogIntervalMs, 2500)),
    fishRaidLogIntervalMs: Math.max(0, cleanNumber(source.fishRaidLogIntervalMs, 2500)),
    fishRaidCooldownMinutes: Math.max(0, cleanNumber(source.fishRaidCooldownMinutes, 60)),
    fishRaidParticipantExpReward: Math.max(0, cleanNumber(source.fishRaidParticipantExpReward, 25)),
    fishRaidParticipantGoldReward: Math.max(0, cleanNumber(source.fishRaidParticipantGoldReward, 0)),
    fishRaidMvpExpReward: Math.max(0, cleanNumber(source.fishRaidMvpExpReward, 75)),
    fishRaidMvpGoldReward: Math.max(0, cleanNumber(source.fishRaidMvpGoldReward, 0)),
    fishRaidClearParticipantExpReward: Math.max(0, cleanNumber(source.fishRaidClearParticipantExpReward, 50)),
    fishRaidClearParticipantGoldReward: Math.max(0, cleanNumber(source.fishRaidClearParticipantGoldReward, 0)),
    fishRaidClearMvpExpReward: Math.max(0, cleanNumber(source.fishRaidClearMvpExpReward, 150)),
    fishRaidClearMvpGoldReward: Math.max(0, cleanNumber(source.fishRaidClearMvpGoldReward, 0)),
    allowActivity: source.allowActivity !== false,
    chatCooldownMs: Math.max(0, cleanNumber(source.chatCooldownMs, 20_000)),
    expMultiplier: Math.max(0, cleanNumber(source.expMultiplier, 1)),
    levelExpMultiplier: Math.max(0.01, cleanNumber(source.levelExpMultiplier, 1)),
    voiceExpAmount: Math.max(0, cleanNumber(source.voiceExpAmount, 1)),
    voiceExpIntervalMinutes: Math.max(1, cleanNumber(source.voiceExpIntervalMinutes, 15))
  };
}

function cleanFishCompEvents(events) {
  return (Array.isArray(events) ? events : []).map((event, index) => {
    const source = event && typeof event === "object" ? event : {};
    return {
      id: String(source.id || `event_${index + 1}`).trim().toLowerCase().replace(/[^a-z0-9_]/g, "_"),
      name: String(source.name || source.id || `Event ${index + 1}`).trim(),
      chance: Math.max(0, cleanNumber(source.chance, 0)),
      type: String(source.type || "empty").trim(),
      durationTurns: Math.max(1, Math.floor(cleanNumber(source.durationTurns, 1))),
      luckModifier: cleanNumber(source.luckModifier, 0),
      canFishOnStart: source.canFishOnStart !== false,
      canFishWhileActive: source.canFishWhileActive !== false,
      canFishOnEnd: source.canFishOnEnd !== false,
      affectOther: source.affectOther === true,
      affectOtherChance: Math.max(0, cleanNumber(source.affectOtherChance, 100)),
      otherType: String(source.otherType || source.type || "empty").trim(),
      otherDurationTurns: Math.max(1, Math.floor(cleanNumber(source.otherDurationTurns, source.durationTurns || 1))),
      otherLuckModifier: cleanNumber(source.otherLuckModifier, source.luckModifier || 0),
      startText: String(source.startText || "").trim(),
      activeText: String(source.activeText || "").trim(),
      endText: String(source.endText || "").trim(),
      otherStartText: String(source.otherStartText || "").trim(),
      otherActiveText: String(source.otherActiveText || "").trim(),
      otherEndText: String(source.otherEndText || "").trim()
    };
  }).filter((event) => event.id && event.chance > 0 && event.startText);
}

function cleanFishRaidBosses(bosses) {
  return (Array.isArray(bosses) && bosses.length ? bosses : [{ id: "big_order", name: "Big Fish Order", quotaKg: 100, description: "Pesanan ikan besar hari ini sudah menunggu." }]).map((boss, index) => {
    const source = boss && typeof boss === "object" ? boss : {};
    const id = String(source.id || `raid_boss_${index + 1}`).trim().toLowerCase().replace(/[^a-z0-9_]/g, "_");
    return {
      id,
      name: String(source.name || source.title || id || `Raid Boss ${index + 1}`).trim(),
      quotaKg: Math.max(1, cleanNumber(source.quotaKg ?? source.quota ?? 100, 100)),
      description: String(source.description || "").trim(),
      registrationBannerBase64: String(source.registrationBannerBase64 || ""),
      registrationBannerUrl: String(source.registrationBannerUrl || "").trim(),
      registrationBannerRef: source.registrationBannerRef && typeof source.registrationBannerRef === "object" ? source.registrationBannerRef : null,
      registrationBannerUrlNeedsRehost: imageNeedsRehost(source, "registrationBannerUrl"),
      runningBannerBase64: String(source.runningBannerBase64 || ""),
      runningBannerUrl: String(source.runningBannerUrl || "").trim(),
      runningBannerRef: source.runningBannerRef && typeof source.runningBannerRef === "object" ? source.runningBannerRef : null,
      runningBannerUrlNeedsRehost: imageNeedsRehost(source, "runningBannerUrl"),
      resultBannerBase64: String(source.resultBannerBase64 || ""),
      resultBannerUrl: String(source.resultBannerUrl || "").trim(),
      resultBannerRef: source.resultBannerRef && typeof source.resultBannerRef === "object" ? source.resultBannerRef : null,
      resultBannerUrlNeedsRehost: imageNeedsRehost(source, "resultBannerUrl"),
      fulfilledBannerBase64: String(source.fulfilledBannerBase64 || ""),
      fulfilledBannerUrl: String(source.fulfilledBannerUrl || "").trim(),
      fulfilledBannerRef: source.fulfilledBannerRef && typeof source.fulfilledBannerRef === "object" ? source.fulfilledBannerRef : null,
      fulfilledBannerUrlNeedsRehost: imageNeedsRehost(source, "fulfilledBannerUrl"),
      failedBannerBase64: String(source.failedBannerBase64 || ""),
      failedBannerUrl: String(source.failedBannerUrl || "").trim(),
      failedBannerRef: source.failedBannerRef && typeof source.failedBannerRef === "object" ? source.failedBannerRef : null,
      failedBannerUrlNeedsRehost: imageNeedsRehost(source, "failedBannerUrl")
    };
  }).filter((boss) => boss.id && boss.name);
}

function cleanEventBonus(bonus) {
  const source = bonus && typeof bonus === "object" ? bonus : {};
  return {
    type: String(source.type || "gold_multiplier").trim(),
    value: Math.max(0, cleanNumber(source.value, 1)),
    fishId: String(source.fishId || "").trim()
  };
}

function cleanEvent(event) {
  if (!event || typeof event !== "object") {
    return null;
  }

  const bannerUrl = String(event.bannerUrl || "").trim();
  const startAt = String(event.startAt || event.deployedAt || "").trim();
  const durationMinutes = Math.max(1, cleanNumber(event.durationMinutes, 60));
  const endsAt = String(event.endsAt || (startAt ? new Date(Date.parse(startAt) + durationMinutes * 60_000).toISOString() : "")).trim();
  const bonuses = (Array.isArray(event.bonuses) && event.bonuses.length
    ? event.bonuses
    : [{ type: event.type, value: event.value, fishId: event.fishId }]).map(cleanEventBonus);
  return {
    id: String(event.id || Date.now()),
    title: String(event.title || "").trim(),
    description: String(event.description || "").trim(),
    bannerBase64: String(event.bannerBase64 || ""),
    bannerUrl,
    bannerContentKey: String(event.bannerContentKey || "").trim(),
    bannerRef: event.bannerRef && typeof event.bannerRef === "object" ? event.bannerRef : null,
    bannerUrlNeedsRehost: imageNeedsRehost(event, "bannerUrl"),
    startAt,
    durationMinutes,
    endsAt,
    bonuses,
    type: bonuses[0]?.type || "gold_multiplier",
    value: bonuses[0]?.value ?? 1,
    fishId: bonuses[0]?.fishId || "",
    announcementChannelId: String(event.announcementChannelId || "").trim(),
    guildId: String(event.guildId || "").trim(),
    isAnnounced: event.isAnnounced === true,
    stoppedAt: String(event.stoppedAt || "").trim(),
    deployedAt: String(event.deployedAt || "").trim()
  };
}

function cleanEvents(events, activeEvent) {
  const sourceEvents = Array.isArray(events) ? events : [];
  const mergedEvents = [...sourceEvents];
  if (activeEvent && !mergedEvents.some((event) => String(event?.id || "") === String(activeEvent.id || ""))) {
    mergedEvents.push(activeEvent);
  }
  return mergedEvents.map(cleanEvent).filter(Boolean);
}

function cleanRoutineButton(button) {
  const source = button && typeof button === "object" ? button : {};
  const action = String(source.action || "fishcomp").trim();
  return {
    id: String(source.id || `${action}_${Date.now()}`).trim().toLowerCase().replace(/[^a-z0-9_:-]/g, "_").slice(0, 80),
    label: String(source.label || action).trim().slice(0, 80),
    action,
    style: String(source.style || "Primary").trim(),
    regtimeMinutes: Math.max(1, Math.floor(cleanNumber(source.regtimeMinutes, 5))),
    durationTurns: Math.max(1, Math.floor(cleanNumber(source.durationTurns, 15)))
  };
}

function cleanRoutineMessageVariants(routine) {
  const variants = Array.isArray(routine.messageVariants) ? routine.messageVariants : [];
  return variants.map((variant) => {
    if (typeof variant === "string") {
      return { title: "", description: variant.trim() };
    }
    const source = variant && typeof variant === "object" ? variant : {};
    return {
      title: String(source.title || "").trim(),
      description: String(source.description || source.message || "").trim()
    };
  }).filter((variant) => variant.title || variant.description).slice(0, 100);
}

function cleanRoutineMessage(routine) {
  if (!routine || typeof routine !== "object") {
    return null;
  }
  const condition = routine.condition && typeof routine.condition === "object" ? routine.condition : {};
  const type = String(condition.type || routine.conditionType || "daily_time").trim();
  return {
    id: String(routine.id || Date.now()).trim(),
    name: String(routine.name || routine.title || "Routine Message").trim(),
    title: String(routine.title || routine.name || "Routine Message").trim(),
    description: String(routine.description || "").trim(),
    messageVariants: cleanRoutineMessageVariants(routine),
    color: String(routine.color || "#36c28a").trim(),
    bannerBase64: String(routine.bannerBase64 || ""),
    bannerUrl: String(routine.bannerUrl || "").trim(),
    bannerRef: routine.bannerRef && typeof routine.bannerRef === "object" ? routine.bannerRef : null,
    bannerContentKey: String(routine.bannerContentKey || "").trim(),
    bannerUrlNeedsRehost: imageNeedsRehost(routine, "bannerUrl"),
    enabled: routine.enabled !== false,
    deleteAfterButtonClick: routine.deleteAfterButtonClick === true,
    guildId: String(routine.guildId || "").trim(),
    channelId: String(routine.channelId || "").trim(),
    lastSentAt: String(routine.lastSentAt || "").trim(),
    lastTriggerKey: String(routine.lastTriggerKey || "").trim(),
    lastSentByGuild: routine.lastSentByGuild && typeof routine.lastSentByGuild === "object" && !Array.isArray(routine.lastSentByGuild) ? routine.lastSentByGuild : {},
    condition: {
      type,
      time: String(condition.time || "00:00").trim(),
      intervalMinutes: Math.max(1, Math.floor(cleanNumber(condition.intervalMinutes, 60))),
      idleMinutes: Math.max(1, Math.floor(cleanNumber(condition.idleMinutes, 120))),
      dateTime: String(condition.dateTime || "").trim()
    },
    buttons: (Array.isArray(routine.buttons) ? routine.buttons : []).map(cleanRoutineButton).filter((button) => button.id && button.label && button.action).slice(0, 25)
  };
}

function cleanRoutineMessages(routineMessages) {
  return (Array.isArray(routineMessages) ? routineMessages : []).map(cleanRoutineMessage).filter(Boolean);
}

function cleanData(data) {
  const events = cleanEvents(data.events, data.activeEvent);
  const fish = (Array.isArray(data.fish) ? data.fish : []).map((item) => cleanItem(item, "fish"));
  const rods = (Array.isArray(data.rods) ? data.rods : []).map((item) => cleanItem(item, "rod"));
  const fishBags = (Array.isArray(data.fishBags) ? data.fishBags : []).map((item) => cleanItem(item, "fishBag"));
  assertUniqueItemIds(fish, "fish");
  assertUniqueItemIds(rods, "rod");
  assertUniqueItemIds(fishBags, "fish bag");
  return {
    fish,
    rods,
    fishBags,
    adminDiscordIds: [...new Set((Array.isArray(data.adminDiscordIds) ? data.adminDiscordIds : [])
      .map((id) => String(id || "").trim())
      .filter(Boolean))],
    settings: cleanSettings(data.settings),
    activeEvent: cleanEvent(data.activeEvent),
    events,
    routineMessages: cleanRoutineMessages(data.routineMessages)
  };
}

function cleanTabData(tab, data) {
  if (tab === "fish") {
    const fish = (Array.isArray(data.fish) ? data.fish : []).map((item) => cleanItem(item, "fish"));
    assertUniqueItemIds(fish, "fish");
    return { fish };
  }
  if (tab === "rods") {
    const rods = (Array.isArray(data.rods) ? data.rods : []).map((item) => cleanItem(item, "rod"));
    assertUniqueItemIds(rods, "rod");
    return { rods };
  }
  if (tab === "fishBags") {
    const fishBags = (Array.isArray(data.fishBags) ? data.fishBags : []).map((item) => cleanItem(item, "fishBag"));
    assertUniqueItemIds(fishBags, "fish bag");
    return { fishBags };
  }
  if (tab === "admin") {
    return { adminDiscordIds: [...new Set((Array.isArray(data.adminDiscordIds) ? data.adminDiscordIds : []).map((id) => String(id || "").trim()).filter(Boolean))] };
  }
  if (tab === "settings") return { settings: cleanSettings(data.settings) };
  if (tab === "event") {
    const activeEvent = cleanEvent(data.activeEvent);
    return { activeEvent, events: cleanEvents(data.events, activeEvent) };
  }
  if (tab === "routine") return { routineMessages: cleanRoutineMessages(data.routineMessages) };
  throw new Error(`The ${tab} tab does not have editable data.`);
}

function assertUniqueItemIds(items, type) {
  const seen = new Set();
  for (const item of items) {
    if (seen.has(item.id)) {
      throw new Error(`Duplicate ${type} ID "${item.id}". Each ${type} needs a unique ID before saving images.`);
    }
    seen.add(item.id);
  }
}

function signalBotConfigRefresh() {
  fs.mkdirSync(runtimeDirectory, { recursive: true });
  fs.writeFileSync(configSignalPath, JSON.stringify({ updatedAt: new Date().toISOString() }));
}

function signalEnforcedFishing(payload) {
  fs.mkdirSync(runtimeDirectory, { recursive: true });
  fs.writeFileSync(enforcedFishingSignalPath, JSON.stringify({
    id: `${Date.now()}:${Math.random().toString(36).slice(2)}`,
    createdAt: new Date().toISOString(),
    ...payload
  }));
}

function signalGiveMoney(payload) {
  fs.mkdirSync(runtimeDirectory, { recursive: true });
  fs.writeFileSync(giveMoneySignalPath, JSON.stringify({
    id: `${Date.now()}:${Math.random().toString(36).slice(2)}`,
    createdAt: new Date().toISOString(),
    ...payload
  }));
}

function signalFishEntotRefresh(payload) {
  fs.mkdirSync(runtimeDirectory, { recursive: true });
  fs.writeFileSync(fishEntotRefreshSignalPath, JSON.stringify({
    id: `${Date.now()}:${Math.random().toString(36).slice(2)}`,
    createdAt: new Date().toISOString(),
    ...payload
  }));
}

function mergeSavedPlayerRecord(record, saved) {
  return {
    ...record,
    ...saved,
    username: saved.username || record.username || "",
    displayName: saved.displayName || record.displayName || "",
    created: saved.created || record.created || "",
    lastLogin: saved.lastLogin || record.lastLogin || "",
    player: saved.player
  };
}

function signalFishRaid(payload) {
  fs.mkdirSync(runtimeDirectory, { recursive: true });
  fs.writeFileSync(fishRaidSignalPath, JSON.stringify({
    id: `${Date.now()}:${Math.random().toString(36).slice(2)}`,
    createdAt: new Date().toISOString(),
    ...payload
  }));
}

function formatLogDetail(value, fallback = "-") {
  const text = String(value || "").trim();
  return text || fallback;
}

function logManagerAction(action, details = {}) {
  const fields = [
    `time=${new Date().toISOString()}`,
    details.user ? `user=${formatLogDetail(details.user)}` : "",
    details.guildId ? `server=${formatLogDetail(details.guildId)}` : "",
    details.channelId ? `channel=${formatLogDetail(details.channelId)}` : "",
    details.playFabId ? `playFabId=${formatLogDetail(details.playFabId)}` : "",
    details.extra ? String(details.extra) : ""
  ].filter(Boolean);
  console.log(`[Manager] ${action}${fields.length ? ` | ${fields.join(" | ")}` : ""}`);
}

function readFishRaidState() {
  if (!fs.existsSync(fishRaidStatePath)) {
    return {};
  }

  try {
    const state = JSON.parse(fs.readFileSync(fishRaidStatePath, "utf8"));
    return state && typeof state === "object" && !Array.isArray(state) ? state.guilds || state : {};
  } catch (error) {
    console.error("Could not read fish raid state:", error);
    return {};
  }
}

function readDefaultFishingChannels() {
  if (!fs.existsSync(defaultFishingChannelsPath)) {
    return {};
  }

  try {
    const savedChannels = JSON.parse(fs.readFileSync(defaultFishingChannelsPath, "utf8"));
    return savedChannels && typeof savedChannels === "object" && !Array.isArray(savedChannels) ? savedChannels : {};
  } catch (error) {
    console.error("Could not read default fishing channels:", error);
    return {};
  }
}

function resolveFishingMessageChannel(player, savedPlayer) {
  const lastChannelId = String(savedPlayer?.lastFishingChannelId || player.lastFishingChannelId || "").trim();
  const lastGuildId = String(savedPlayer?.lastFishingGuildId || player.lastFishingGuildId || "").trim();
  if (lastChannelId) {
    return { channelId: lastChannelId, guildId: lastGuildId };
  }

  const defaultChannels = readDefaultFishingChannels();
  if (lastGuildId && defaultChannels[lastGuildId]) {
    return { channelId: String(defaultChannels[lastGuildId]).trim(), guildId: lastGuildId };
  }

  const entries = Object.entries(defaultChannels).filter(([guildId, channelId]) => guildId && channelId);
  if (entries.length === 1) {
    const [guildId, channelId] = entries[0];
    return { channelId: String(channelId).trim(), guildId: String(guildId).trim() };
  }

  return { channelId: "", guildId: lastGuildId };
}

function normalizeEnforceFishRequests(body) {
  const entries = Array.isArray(body.fishSelections) && body.fishSelections.length
    ? body.fishSelections
    : [{ fishId: body.fishId || "", quantity: 1 }];
  return entries.map((entry) => ({
    fishId: String(entry?.fishId || "").trim(),
    quantity: Math.max(1, Math.min(99, Math.floor(cleanNumber(entry?.quantity, 1))))
  })).filter((entry) => entry.quantity > 0);
}

async function handleApi(request, response) {
  try {
    const requestUrl = new URL(request.url, `http://${request.headers.host || "localhost"}`);
    if (request.method === "GET" && requestUrl.pathname === "/api/image-cache") {
      await serveCachedImage(requestUrl, response);
      return;
    }

    if (request.method === "GET" && requestUrl.pathname === "/api/data") {
      const tab = String(requestUrl.searchParams.get("tab") || "").trim();
      if (!tab) {
        sendJson(response, 200, await adminGetGameData({ caller: "legacy manager /api/data load" }));
        return;
      }
      sendJson(response, 200, await adminGetManagerTabData(tab, { caller: `manager ${tab} tab load` }));
      return;
    }

    if (request.method === "GET" && requestUrl.pathname === "/api/fishraid/state") {
      sendJson(response, 200, { guilds: readFishRaidState() });
      return;
    }

    if (request.method === "GET" && requestUrl.pathname === "/api/players") {
      sendJson(response, 200, { players: await adminListPlayers(requestUrl.searchParams.get("search") || "") });
      return;
    }

    if (request.method === "POST" && request.url === "/api/player/save") {
      const body = JSON.parse(await readBody(request));
      const playFabId = String(body.playFabId || "").trim();
      if (!playFabId) throw new Error("Missing PlayFab ID.");
      sendJson(response, 200, { ok: true, player: await adminSavePlayerData(playFabId, cleanPlayer(body.player)) });
      return;
    }

    if (request.method === "POST" && request.url === "/api/player/reset") {
      const body = JSON.parse(await readBody(request));
      const playFabId = String(body.playFabId || "").trim();
      if (!playFabId) throw new Error("Missing PlayFab ID.");
      sendJson(response, 200, { ok: true, player: await adminResetPlayerData(playFabId) });
      return;
    }

    if (request.method === "POST" && request.url === "/api/player/refresh-entot") {
      const body = JSON.parse(await readBody(request));
      const playFabId = String(body.playFabId || "").trim();
      if (!playFabId) throw new Error("Missing PlayFab ID.");
      const current = await adminGetPlayerRecord(playFabId);
      const player = cleanPlayer(current.player);
      player.fishEntotLastUsedAt = 0;
      const saved = mergeSavedPlayerRecord(current, await adminSavePlayerData(playFabId, player, { refetch: false }));
      const discordUserId = String(saved.player?.discordUserId || saved.discordUserId || "").trim();
      const user = String(saved.displayName || saved.username || saved.player?.discordDisplayName || saved.player?.discordUsername || discordUserId || playFabId).trim();
      signalFishEntotRefresh({ playFabId, discordUserId, user });
      logManagerAction("Fishentot cooldown refreshed", { user, playFabId });
      sendJson(response, 200, { ok: true, player: saved });
      return;
    }

    if (request.method === "POST" && request.url === "/api/player/delete") {
      const body = JSON.parse(await readBody(request));
      const playFabId = String(body.playFabId || "").trim();
      if (!playFabId) throw new Error("Missing PlayFab ID.");
      sendJson(response, 200, await adminDeletePlayer(playFabId));
      return;
    }

    if (request.method === "POST" && request.url === "/api/player/enforce-fishing") {
      const body = JSON.parse(await readBody(request));
      const playFabId = String(body.playFabId || "").trim();
      if (!playFabId) throw new Error("Missing PlayFab ID.");
      const data = await adminGetGameData({ caller: "manager enforce fishing" });
      const player = cleanPlayer(body.player);
      const fishRequests = normalizeEnforceFishRequests(body);
      const catches = [];
      for (const fishRequest of fishRequests.length ? fishRequests : [{ fishId: "", quantity: 1 }]) {
        for (let index = 0; index < fishRequest.quantity; index += 1) {
          const catchResult = rollFishForManager(data, player, fishRequest.fishId);
          const gain = addManagerCatch(data, player, catchResult.fish, catchResult.catchWeight);
          catches.push({
            fish: catchResult.fish,
            catchWeight: catchResult.catchWeight,
            expGain: gain.expGain,
            expBase: gain.expBase,
            expEventInfo: gain.expEventInfo,
            luckScore: gain.luckScore
          });
        }
      }
      const messageChannel = resolveFishingMessageChannel(player, player);
      logManagerAction("Enforce Fishing save started", {
        user: player.discordDisplayName || player.discordGlobalName || player.discordUsername || player.discordUserId,
        guildId: messageChannel.guildId,
        channelId: messageChannel.channelId,
        playFabId,
        extra: `catches=${catches.length}`
      });
      const saved = await adminSavePlayerData(playFabId, player, { refetch: false });
      const discordUserId = String(saved.player?.discordUserId || player.discordUserId || "").trim();
      logManagerAction("Enforce Fishing data saved", {
        user: saved.displayName || saved.username || discordUserId,
        guildId: messageChannel.guildId,
        channelId: messageChannel.channelId,
        playFabId,
        extra: `catches=${catches.length}`
      });
      if (discordUserId && messageChannel.channelId) {
        logManagerAction("Enforce Fishing queued for Discord", {
          user: saved.displayName || saved.username || discordUserId,
          guildId: messageChannel.guildId,
          channelId: messageChannel.channelId,
          playFabId,
          extra: `catches=${catches.length}`
        });
        signalEnforcedFishing({
          discordUserId,
          guildId: messageChannel.guildId,
          channelId: messageChannel.channelId,
          catches: catches.map((entry) => ({
            discordUserId,
            guildId: messageChannel.guildId,
            channelId: messageChannel.channelId,
            fish: entry.fish,
            catchWeight: entry.catchWeight,
            expGain: entry.expGain,
            expBase: entry.expBase,
            expEventInfo: entry.expEventInfo
          }))
        });
      }
      sendJson(response, 200, {
        ok: true,
        messageQueued: Boolean(discordUserId && messageChannel.channelId),
        player: saved,
        catch: catches[0] || null,
        catches
      });
      return;
    }

    if (request.method === "POST" && request.url === "/api/players/enforce-fishing") {
      const body = JSON.parse(await readBody(request) || "{}");
      const targetGuildId = String(body.guildId || "").trim();
      const fishRequests = normalizeEnforceFishRequests(body);
      startProgressResponse(response);
      sendProgress(response, { type: "progress", phase: "loading", message: "Loading players from PlayFab…" });
      try {
        const data = await adminGetGameData({ caller: "manager enforce fishing for all players" });
        const allPlayers = await adminListPlayers("", {
          onProgress: ({ current, total }) => sendProgress(response, {
            type: "progress",
            phase: "loading",
            current,
            total,
            message: `Loaded ${current} of ${total} players from PlayFab…`
          })
        });
        const players = targetGuildId
          ? allPlayers.filter((record) => String(record.player?.lastFishingGuildId || "").trim() === targetGuildId)
          : allPlayers;
        const updatedPlayers = [];
        const catches = [];
        let queuedCount = 0;
        let noChannelCount = 0;
        let failedCount = 0;
        let processed = 0;
        sendProgress(response, { type: "progress", phase: "processing", current: 0, total: players.length, message: `Preparing ${players.length} targeted player${players.length === 1 ? "" : "s"}…` });

        for (const record of players) {
          const player = cleanPlayer(record.player);
          const playerCatches = [];
          try {
            for (const fishRequest of fishRequests.length ? fishRequests : [{ fishId: "", quantity: 1 }]) {
              for (let index = 0; index < fishRequest.quantity; index += 1) {
                const catchResult = rollFishForManager(data, player, fishRequest.fishId);
                const gain = addManagerCatch(data, player, catchResult.fish, catchResult.catchWeight);
                playerCatches.push({ catchResult, gain });
              }
            }
            const saved = mergeSavedPlayerRecord(record, await adminSavePlayerData(record.playFabId, player, { refetch: false, remember: false }));
            updatedPlayers.push(saved);
            const discordUserId = String(saved.player?.discordUserId || player.discordUserId || record.discordUserId || "").trim();
            const messageChannel = resolveFishingMessageChannel(player, saved.player);
            if (discordUserId && messageChannel.channelId) {
              for (const { catchResult, gain } of playerCatches) {
                catches.push({
                  discordUserId,
                  guildId: messageChannel.guildId,
                  channelId: messageChannel.channelId,
                  fish: catchResult.fish,
                  catchWeight: catchResult.catchWeight,
                  expGain: gain.expGain,
                  expBase: gain.expBase,
                  expEventInfo: gain.expEventInfo
                });
              }
              queuedCount += playerCatches.length;
            } else {
              noChannelCount += 1;
            }
          } catch (error) {
            failedCount += 1;
            console.error(`Could not enforce fishing for ${record.playFabId}:`, error);
          } finally {
            processed += 1;
            sendProgress(response, {
              type: "progress",
              phase: "processing",
              current: processed,
              total: players.length,
              message: `Processed ${processed} of ${players.length} targeted players…`
            });
          }
        }

        if (catches.length) signalEnforcedFishing({ catches });
        sendProgress(response, {
          type: "complete",
          ok: true,
          count: updatedPlayers.length,
          targetCount: players.length,
          excludedCount: allPlayers.length - players.length,
          queuedCount,
          noChannelCount,
          failedCount,
          players: updatedPlayers
        });
        response.end();
      } catch (error) {
        sendProgress(response, { type: "error", error: error.message });
        response.end();
      }
      return;
    }

    if (request.method === "POST" && request.url === "/api/players/refresh-entot") {
      startProgressResponse(response);
      sendProgress(response, { type: "progress", phase: "loading", message: "Loading players from PlayFab…" });
      try {
        const players = await adminListPlayers("", {
          onProgress: ({ current, total }) => sendProgress(response, {
            type: "progress",
            phase: "loading",
            current,
            total,
            message: `Loaded ${current} of ${total} players from PlayFab…`
          })
        });
        const updatedPlayers = [];
        let failedCount = 0;
        let processed = 0;
        sendProgress(response, { type: "progress", phase: "processing", current: 0, total: players.length, message: `Preparing ${players.length} player${players.length === 1 ? "" : "s"}…` });
        for (const record of players) {
          try {
            const player = cleanPlayer(record.player);
            player.fishEntotLastUsedAt = 0;
            const saved = mergeSavedPlayerRecord(record, await adminSavePlayerData(record.playFabId, player, { refetch: false, remember: false }));
            updatedPlayers.push(saved);
            const user = String(saved.displayName || saved.username || saved.player?.discordDisplayName || saved.player?.discordUsername || saved.player?.discordUserId || record.playFabId).trim();
            logManagerAction("Fishentot cooldown refreshed", { user, playFabId: record.playFabId });
          } catch (error) {
            failedCount += 1;
            console.error(`Could not refresh Fishentot cooldown for ${record.playFabId}:`, error);
          } finally {
            processed += 1;
            sendProgress(response, {
              type: "progress",
              phase: "processing",
              current: processed,
              total: players.length,
              message: `Processed ${processed} of ${players.length} players…`
            });
          }
        }
        signalFishEntotRefresh({ user: `${updatedPlayers.length} players`, count: updatedPlayers.length });
        sendProgress(response, { type: "complete", ok: true, count: updatedPlayers.length, failedCount, players: updatedPlayers });
        response.end();
      } catch (error) {
        sendProgress(response, { type: "error", error: error.message });
        response.end();
      }
      return;
    }

    if (request.method === "POST" && request.url === "/api/fishraid/reset") {
      const body = JSON.parse(await readBody(request));
      const guildId = String(body.guildId || "").trim();
      if (!guildId) throw new Error("Missing Discord server ID.");
      signalFishRaid({
        action: "reset",
        guildId,
        channelId: String(body.channelId || "").trim()
      });
      sendJson(response, 200, { ok: true });
      return;
    }

    if (request.method === "POST" && request.url === "/api/fishraid/force-clear") {
      const body = JSON.parse(await readBody(request));
      const guildId = String(body.guildId || "").trim();
      if (!guildId) throw new Error("Missing Discord server ID.");
      signalFishRaid({
        action: "force_clear",
        guildId,
        channelId: String(body.channelId || "").trim()
      });
      sendJson(response, 200, { ok: true });
      return;
    }

    if (request.method === "POST" && request.url === "/api/fishraid/reset-cooldown") {
      const body = JSON.parse(await readBody(request));
      const guildId = String(body.guildId || "").trim();
      if (!guildId) throw new Error("Missing Discord server ID.");
      signalFishRaid({
        action: "reset_cooldown",
        guildId,
        channelId: String(body.channelId || "").trim()
      });
      sendJson(response, 200, { ok: true });
      return;
    }

    if (request.method === "POST" && request.url === "/api/player/give-money") {
      const body = JSON.parse(await readBody(request));
      const playFabId = String(body.playFabId || "").trim();
      if (!playFabId) throw new Error("Missing PlayFab ID.");
      const amount = Math.max(0, Math.floor(cleanNumber(body.amount, 0)));
      if (amount <= 0) throw new Error("Money amount must be greater than 0.");
      const player = cleanPlayer(body.player);
      const goldBefore = Math.max(0, Math.floor(Number(player.gold || 0)));
      player.gold = goldBefore + amount;
      const saved = await adminSavePlayerData(playFabId, player);
      const discordUserId = String(saved.player?.discordUserId || player.discordUserId || "").trim();
      const messageChannel = resolveFishingMessageChannel(player, saved.player);
      const channelId = messageChannel.channelId;
      if (discordUserId && channelId) {
        signalGiveMoney({
          discordUserId,
          guildId: messageChannel.guildId,
          channelId,
          amount
        });
      }
      sendJson(response, 200, {
        ok: true,
        messageQueued: Boolean(discordUserId && channelId),
        player: saved,
        goldBefore,
        goldAfter: player.gold,
        amount
      });
      return;
    }

    if (request.method === "POST" && request.url === "/api/players/reset-all") {
      const players = await adminListPlayers();
      const resetPlayers = [];
      for (const player of players) {
        resetPlayers.push(await adminResetPlayerData(player.playFabId));
      }
      sendJson(response, 200, { ok: true, count: resetPlayers.length, players: resetPlayers });
      return;
    }

    if (request.method === "POST" && request.url === "/api/players/delete-all") {
      const players = await adminListPlayers();
      for (const player of players) {
        await adminDeletePlayer(player.playFabId);
      }
      sendJson(response, 200, { ok: true, count: players.length });
      return;
    }

    if (request.method === "POST" && requestUrl.pathname === "/api/data") {
      const tab = String(requestUrl.searchParams.get("tab") || "").trim();
      const body = JSON.parse(await readBody(request));
      if (!tab) {
        sendJson(response, 409, { error: "This manager page is outdated. Reload it before saving; whole-manager saves are disabled to protect unrelated tabs." });
        return;
      }
      const savedData = await adminSaveManagerTabData(tab, cleanTabData(tab, body));
      signalBotConfigRefresh();
      sendJson(response, 200, { ok: true, ...savedData });
      return;
    }

    if (request.method === "POST" && request.url === "/api/event/deploy") {
      const data = cleanTabData("event", JSON.parse(await readBody(request)));
      const deployedEvent = {
        ...(data.activeEvent || cleanEvent({})),
        id: data.activeEvent?.id || String(Date.now()),
        startAt: data.activeEvent?.startAt || new Date().toISOString(),
        isAnnounced: false,
        deployedAt: new Date().toISOString()
      };
      deployedEvent.endsAt = new Date(Date.parse(deployedEvent.startAt) + Math.max(1, Number(deployedEvent.durationMinutes || 60)) * 60_000).toISOString();
      data.events = [
        deployedEvent,
        ...(data.events || []).filter((event) => event.id !== deployedEvent.id)
      ];
      data.activeEvent = deployedEvent;
      const saved = await adminSaveManagerTabData("event", data);
      signalBotConfigRefresh();
      sendJson(response, 200, { ok: true, activeEvent: saved.activeEvent, events: saved.events });
      return;
    }

    if (request.method === "POST" && request.url === "/api/event/stop") {
      const body = JSON.parse(await readBody(request));
      const current = await adminGetManagerTabData("event", { caller: "manager event stop" });
      const now = new Date().toISOString();
      const events = cleanEvents(current.events, current.activeEvent).map((event) => (
        event.id === String(body.id || "") ? { ...event, endsAt: now, stoppedAt: now } : event
      ));
      const activeEvent = events.find((event) => event.id === current.activeEvent?.id) || current.activeEvent || null;
      const saved = await adminSaveManagerTabData("event", { events, activeEvent });
      signalBotConfigRefresh();
      sendJson(response, 200, { ok: true, activeEvent: saved.activeEvent, events: saved.events });
      return;
    }

    if (request.method === "POST" && request.url === "/api/event/remove") {
      const body = JSON.parse(await readBody(request));
      const current = await adminGetManagerTabData("event", { caller: "manager event remove" });
      const eventId = String(body.id || "");
      const events = cleanEvents(current.events, current.activeEvent).filter((event) => event.id !== eventId);
      const activeEvent = current.activeEvent?.id === eventId ? null : current.activeEvent || null;
      const saved = await adminSaveManagerTabData("event", { events, activeEvent });
      signalBotConfigRefresh();
      sendJson(response, 200, { ok: true, activeEvent: saved.activeEvent, events: saved.events });
      return;
    }

    if (request.method === "POST" && request.url === "/api/routine/deploy") {
      const body = JSON.parse(await readBody(request));
      const data = cleanTabData("routine", body);
      const routine = cleanRoutineMessage(body.routineDraft);
      if (!routine) {
        sendJson(response, 400, { error: "Routine message is not valid." });
        return;
      }
      const routineMessages = [
        { ...routine, id: routine.id || String(Date.now()) },
        ...(data.routineMessages || []).filter((entry) => entry.id !== routine.id)
      ];
      const savedData = await adminSaveManagerTabData("routine", { routineMessages });
      signalBotConfigRefresh();
      sendJson(response, 200, { ok: true, routineMessages: savedData.routineMessages || routineMessages });
      return;
    }

    if (request.method === "POST" && request.url === "/api/routine/remove") {
      const body = JSON.parse(await readBody(request));
      const current = await adminGetManagerTabData("routine", { caller: "manager routine remove" });
      const routineId = String(body.id || "");
      const routineMessages = cleanRoutineMessages(current.routineMessages).filter((routine) => routine.id !== routineId);
      await adminSaveManagerTabData("routine", { routineMessages });
      signalBotConfigRefresh();
      sendJson(response, 200, { ok: true, routineMessages });
      return;
    }

    if (request.method === "POST" && requestUrl.pathname === "/api/seed") {
      const tab = String(requestUrl.searchParams.get("tab") || "").trim();
      const defaults = tab === "fish" ? { fish: defaultFish }
        : tab === "rods" ? { rods: defaultRods }
          : tab === "fishBags" ? { fishBags: defaultFishBags }
            : null;
      if (!defaults) throw new Error("Defaults are available only for Fish, Rods, and Fish Bags.");
      const saved = await adminSaveManagerTabData(tab, defaults);
      signalBotConfigRefresh();
      sendJson(response, 200, { ok: true, ...saved });
      return;
    }

    sendJson(response, 404, { error: "Not found" });
  } catch (error) {
    if (response.headersSent) {
      if (!response.writableEnded) response.end();
    } else {
      sendJson(response, 500, { error: error.message });
    }
  }
}

const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>TR Fishing Manager</title>
  <style>
    :root {
      color-scheme: dark;
      --bg: #101419;
      --panel: #171d23;
      --panel-2: #1e2630;
      --text: #edf3f7;
      --muted: #9ba9b5;
      --line: #303b45;
      --accent: #36c28a;
      --danger: #ff6b6b;
      --warn: #f2bd55;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: Arial, sans-serif;
      background: var(--bg);
      color: var(--text);
    }
    header {
      position: sticky;
      top: 0;
      z-index: 2;
      background: #111820;
      border-bottom: 1px solid var(--line);
      padding: 16px 24px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
    }
    h1 {
      margin: 0;
      font-size: 20px;
      font-weight: 700;
    }
    main {
      max-width: 1440px;
      margin: 0 auto;
      padding: 20px;
    }
    .toolbar, .tabs {
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
      align-items: center;
    }
    .tab-toolbar {
      margin-top: 10px;
      padding: 10px;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: var(--panel);
    }
    .loading-screen {
      position: fixed;
      inset: 0;
      z-index: 100;
      display: none;
      place-items: center;
      background: rgba(5, 8, 12, 0.86);
      backdrop-filter: blur(3px);
    }
    .loading-screen.active { display: grid; }
    .loading-card {
      min-width: min(360px, calc(100vw - 40px));
      padding: 24px;
      border: 1px solid var(--line);
      border-radius: 10px;
      background: var(--panel);
      text-align: center;
      box-shadow: 0 24px 80px rgba(0, 0, 0, 0.5);
    }
    .loading-progress {
      display: none;
      gap: 8px;
      margin-top: 16px;
    }
    .loading-progress.active { display: grid; }
    .loading-progress-track {
      height: 10px;
      overflow: hidden;
      border: 1px solid var(--line);
      border-radius: 999px;
      background: #0b0f13;
    }
    .loading-progress-bar {
      width: 0;
      height: 100%;
      background: var(--accent);
      transition: width 0.18s ease;
    }
    .spinner {
      width: 34px;
      height: 34px;
      margin: 0 auto 14px;
      border: 4px solid var(--line);
      border-top-color: var(--accent);
      border-radius: 50%;
      animation: spin 0.8s linear infinite;
    }
    @keyframes spin { to { transform: rotate(360deg); } }
    button {
      border: 1px solid var(--line);
      background: var(--panel-2);
      color: var(--text);
      border-radius: 6px;
      padding: 9px 12px;
      cursor: pointer;
      font-weight: 700;
    }
    button.primary { background: var(--accent); color: #07130e; border-color: var(--accent); }
    button.danger { color: var(--danger); }
    button.active { border-color: var(--accent); }
    .notice {
      color: var(--muted);
      font-size: 13px;
      margin: 0 0 16px;
    }
    .status {
      color: var(--muted);
      font-size: 13px;
      min-height: 20px;
    }
    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
      gap: 14px;
      margin-top: 16px;
    }
    .item {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 14px;
      display: grid;
      gap: 10px;
    }
    .topline {
      display: flex;
      justify-content: space-between;
      gap: 10px;
      align-items: center;
    }
    .preview {
      width: 56px;
      height: 56px;
      border-radius: 8px;
      border: 1px solid var(--line);
      background: #0b0f13;
      object-fit: contain;
      flex: 0 0 auto;
    }
    .image-grid {
      grid-column: 1 / -1;
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
      gap: 12px;
      padding-top: 12px;
      border-top: 1px solid var(--line);
    }
    .image-panel {
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 12px;
      display: grid;
      gap: 10px;
      background: #10161d;
    }
    .image-panel strong {
      font-size: 13px;
    }
    .image-preview {
      width: 100%;
      aspect-ratio: 16 / 7;
      border-radius: 6px;
      border: 1px solid var(--line);
      background: #0b0f13;
      object-fit: contain;
    }
    .empty-preview {
      width: 100%;
      aspect-ratio: 16 / 7;
      border-radius: 6px;
      border: 1px dashed var(--line);
      display: grid;
      place-items: center;
      color: var(--muted);
      background: #0b0f13;
      font-size: 12px;
      font-weight: 700;
    }
    .topline .empty-preview {
      width: 56px;
      height: 56px;
      aspect-ratio: 1;
      flex: 0 0 auto;
    }
    .file-picker {
      display: inline-flex;
      width: fit-content;
      align-items: center;
      justify-content: center;
      border: 1px solid var(--line);
      background: var(--panel-2);
      color: var(--text);
      border-radius: 6px;
      padding: 9px 12px;
      cursor: pointer;
    }
    .file-picker input {
      position: absolute;
      opacity: 0;
      pointer-events: none;
      width: 1px;
      height: 1px;
    }
    .fields {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 10px;
    }
    label {
      display: grid;
      gap: 5px;
      color: var(--muted);
      font-size: 12px;
      font-weight: 700;
    }
    input, textarea, select {
      width: 100%;
      border: 1px solid var(--line);
      border-radius: 6px;
      padding: 9px;
      background: #0e1318;
      color: var(--text);
      font: inherit;
    }
    textarea {
      min-height: 68px;
      resize: vertical;
    }
    .event-description-input {
      min-height: 150px;
    }
    .event-description-preview {
      white-space: pre-wrap;
    }
    .wide { grid-column: 1 / -1; }
    .small {
      color: var(--muted);
      font-size: 12px;
      line-height: 1.35;
    }
    .event-list {
      grid-column: 1 / -1;
    }
    .event-scroll {
      display: grid;
      gap: 10px;
      max-height: 360px;
      overflow: auto;
      padding-right: 4px;
    }
    .event-row {
      border-top: 1px solid var(--line);
      padding-top: 10px;
      display: grid;
      gap: 8px;
    }
    .event-row:first-child {
      border-top: 0;
      padding-top: 0;
    }
    .badge {
      border: 1px solid var(--line);
      border-radius: 999px;
      padding: 3px 8px;
      color: var(--muted);
      font-size: 12px;
      font-weight: 700;
    }
    .bonus-row {
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 10px;
      display: grid;
      gap: 10px;
    }
    .warning { color: var(--warn); }
    .player-layout {
      grid-column: 1 / -1;
      display: grid;
      grid-template-columns: minmax(280px, 380px) 1fr;
      gap: 14px;
      align-items: start;
    }
    .player-list {
      display: grid;
      gap: 8px;
      max-height: 68vh;
      overflow: auto;
    }
    .player-row {
      width: 100%;
      text-align: left;
      display: grid;
      gap: 4px;
    }
    .player-row.active {
      border-color: var(--accent);
    }
    .button-row {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
    }
    .modal-overlay {
      position: fixed;
      inset: 0;
      z-index: 20;
      display: grid;
      place-items: center;
      padding: 20px;
      background: rgba(5, 8, 12, 0.72);
    }
    .modal-panel {
      width: min(680px, 100%);
      max-height: calc(100vh - 40px);
      overflow: auto;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: var(--panel);
      box-shadow: 0 24px 80px rgba(0, 0, 0, 0.45);
      padding: 16px;
      display: grid;
      gap: 14px;
    }
    .modal-header {
      display: flex;
      align-items: start;
      justify-content: space-between;
      gap: 12px;
    }
    .enforce-list {
      display: grid;
      gap: 10px;
    }
    .enforce-row {
      display: grid;
      grid-template-columns: minmax(0, 1fr) 110px auto;
      gap: 8px;
      align-items: end;
    }
    .icon-button {
      width: 38px;
      height: 38px;
      padding: 0;
      display: inline-grid;
      place-items: center;
      font-size: 18px;
      line-height: 1;
    }
    .modal-actions {
      display: flex;
      justify-content: flex-end;
      gap: 8px;
      flex-wrap: wrap;
    }
    .fish-layout {
      grid-column: 1 / -1;
      display: grid;
      grid-template-columns: minmax(280px, 1fr) minmax(320px, 520px);
      gap: 14px;
      align-items: start;
    }
    .settings-panel {
      grid-column: 1 / -1;
    }
    .settings-panel > .fields {
      grid-template-columns: repeat(4, minmax(160px, 1fr));
    }
    .fishraid-settings-layout {
      display: grid;
      grid-template-columns: minmax(360px, 0.9fr) minmax(560px, 1.4fr);
      gap: 14px;
      align-items: start;
    }
    .fishraid-main-panel,
    .raid-boss-panel {
      min-width: 0;
    }
    .raid-boss-layout {
      display: grid;
      grid-template-columns: minmax(180px, 240px) minmax(320px, 1fr);
      gap: 14px;
      align-items: start;
    }
    .raid-boss-panel .fish-gallery {
      max-height: 74vh;
    }
    .fish-toolbar {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      align-items: center;
      margin-bottom: 12px;
    }
    .fish-pager {
      display: flex;
      flex-wrap: wrap;
      justify-content: space-between;
      align-items: center;
      gap: 8px;
      margin: 0 0 12px;
    }
    .fish-gallery {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(118px, 1fr));
      gap: 10px;
      max-height: 74vh;
      overflow: auto;
      padding-right: 4px;
    }
    .fish-card {
      display: grid;
      gap: 8px;
      text-align: center;
      align-content: start;
      min-height: 148px;
    }
    .fish-card.active {
      border-color: var(--accent);
    }
    .fish-card img {
      width: 100%;
      aspect-ratio: 1;
      border-radius: 8px;
      border: 1px solid var(--line);
      background: #0b0f13;
      object-fit: contain;
    }
    .fish-card img:not([src]),
    .preview:not([src]),
    .image-preview:not([src]) {
      visibility: hidden;
    }
    .fish-card .empty-preview {
      aspect-ratio: 1;
    }
    .fish-card span {
      color: var(--text);
      font-size: 13px;
      font-weight: 800;
      line-height: 1.2;
      overflow-wrap: anywhere;
    }
    .fish-detail {
      position: sticky;
      top: 12px;
    }
    .info-panel {
      grid-column: 1 / -1;
    }
    .toggle-row {
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .toggle-row input {
      width: auto;
    }
    .calc-table {
      width: 100%;
      border-collapse: collapse;
      font-size: 13px;
    }
    .calc-table th,
    .calc-table td {
      border-top: 1px solid var(--line);
      padding: 8px;
      text-align: left;
      vertical-align: top;
    }
    .calc-table th {
      color: var(--muted);
      font-size: 12px;
    }
    .hidden-input {
      position: absolute;
      opacity: 0;
      pointer-events: none;
      width: 1px;
      height: 1px;
    }
    @media (max-width: 620px) {
      header { align-items: flex-start; flex-direction: column; }
      .fields { grid-template-columns: 1fr; }
      .player-layout { grid-template-columns: 1fr; }
      .fish-layout { grid-template-columns: 1fr; }
      .settings-panel > .fields { grid-template-columns: 1fr; }
      .fishraid-settings-layout { grid-template-columns: 1fr; }
      .raid-boss-layout { grid-template-columns: 1fr; }
      .fish-detail { position: static; }
      .image-grid { grid-template-columns: 1fr; }
      .calc-table { display: block; overflow-x: auto; }
    }
  </style>
</head>
<body>
  <header>
    <h1>TR Fishing Manager</h1>
  </header>
  <main>
    <p class="notice">Manage fish, rods, and fish bags here. Images are uploaded to the Discord storage channel on save. PlayFab stores game data and the saved image URLs.</p>
    <div class="tabs">
      <button class="active" data-tab="fish">Fish</button>
      <button data-tab="rods">Rods</button>
      <button data-tab="fishBags">Fish Bags</button>
      <button data-tab="calc">Calc Table</button>
      <button data-tab="admin">Admin Control</button>
      <button data-tab="settings">Settings</button>
      <button data-tab="event">Event</button>
      <button data-tab="routine">Routine Message</button>
      <button data-tab="players">Player Management</button>
    </div>
    <div class="toolbar tab-toolbar">
      <button id="load">Reload This Tab</button>
      <button id="seed">Seed This Tab’s Defaults</button>
      <button class="primary" id="save">Save This Tab</button>
      <span class="small" id="tab-save-note">Only this tab’s data will be changed.</span>
    </div>
    <p class="status" id="status"></p>
    <section class="grid" id="grid"></section>
  </main>
  <div class="loading-screen" id="loading-screen" role="status" aria-live="polite" aria-busy="true">
    <div class="loading-card">
      <div class="spinner"></div>
      <strong id="loading-message">Loading data…</strong>
      <div class="loading-progress" id="loading-progress">
        <div class="loading-progress-track"><div class="loading-progress-bar" id="loading-progress-bar"></div></div>
        <div class="small" id="loading-progress-text"></div>
      </div>
    </div>
  </div>
  <script>
    const state = {
      tab: "fish",
      settingsTab: "general",
      fish: [],
      rods: [],
      fishBags: [],
      adminDiscordIds: [],
      settings: { rodStoreImageBase64: "", rodStoreImageUrl: "", fishCompBannerBase64: "", fishCompBannerUrl: "", fishCompRegistrationBannerBase64: "", fishCompRegistrationBannerUrl: "", fishCompRunningBannerBase64: "", fishCompRunningBannerUrl: "", fishCompResultBannerBase64: "", fishCompResultBannerUrl: "", fishRaidBannerBase64: "", fishRaidBannerUrl: "", fishRaidRegistrationBannerBase64: "", fishRaidRegistrationBannerUrl: "", fishRaidRunningBannerBase64: "", fishRaidRunningBannerUrl: "", fishRaidResultBannerBase64: "", fishRaidResultBannerUrl: "", fishDuelRegistrationBannerBase64: "", fishDuelRegistrationBannerUrl: "", fishDuelRunningBannerBase64: "", fishDuelRunningBannerUrl: "", fishDuelResultBannerBase64: "", fishDuelResultBannerUrl: "", fishGuideBannerBase64: "", fishGuideBannerUrl: "", fishHelpBannerBase64: "", fishHelpBannerUrl: "", sellFishBannerBase64: "", sellFishBannerUrl: "", fishCompEvents: [], fishRaidEvents: [], fishDuelEvents: [], fishRaidBosses: [{ id: "big_order", name: "Big Fish Order", quotaKg: 100, description: "Pesanan ikan besar hari ini sudah menunggu.", registrationBannerBase64: "", registrationBannerUrl: "", runningBannerBase64: "", runningBannerUrl: "", resultBannerBase64: "", resultBannerUrl: "", fulfilledBannerBase64: "", fulfilledBannerUrl: "", failedBannerBase64: "", failedBannerUrl: "" }], fishCompLogIntervalMs: 2500, fishCompHistoryLogHours: 24, fishCompExpReward: 50, fishCompGoldReward: 0, fishDuelExpReward: 40, fishDuelLogIntervalMs: 2500, fishRaidLogIntervalMs: 2500, fishRaidParticipantExpReward: 25, fishRaidParticipantGoldReward: 0, fishRaidMvpExpReward: 75, fishRaidMvpGoldReward: 0, fishRaidClearParticipantExpReward: 50, fishRaidClearParticipantGoldReward: 0, fishRaidClearMvpExpReward: 150, fishRaidClearMvpGoldReward: 0, allowActivity: true, chatCooldownMs: 20000, expMultiplier: 1, levelExpMultiplier: 1, voiceExpAmount: 1, voiceExpIntervalMinutes: 15 },
      activeEvent: null,
      events: [],
      routineMessages: [],
      loadedTabs: {},
      processing: false,
      eventDraft: null,
      routineDraft: null,
      selectedFishId: "",
      selectedRodId: "",
      selectedFishBagId: "",
      fishPage: 1,
      fishPageSize: 24,
      fishSort: "name",
      rodSort: "name",
      fishBagSort: "name",
      fishSearch: "",
      rodSearch: "",
      fishBagSearch: "",
      calcRodId: "",
      calcServerId: "",
      calcSort: "chance",
      selectedRaidBossId: "big_order",
      createModal: null,
      createItemDraft: null,
      createItemType: "",
      raidBossDraft: null,
      fishRaidControlGuildId: localStorage.getItem("trfishing:fishRaidControlGuildId") || "",
      fishRaidControlChannelId: localStorage.getItem("trfishing:fishRaidControlChannelId") || "",
      fishRaidState: {},
      infoCollapsed: { fish: false, rods: false, fishBags: false },
      lastAnnouncementChannelId: localStorage.getItem("trfishing:lastAnnouncementChannelId") || "",
      players: [],
      playerSearch: "",
      selectedPlayerId: "",
      enforceModalOpen: false,
      enforceFishSelections: [{ fishId: "", quantity: 1 }],
      enforceAllModalOpen: false,
      enforceAllGuildId: "",
      enforceAllFishSelections: [{ fishId: "", quantity: 1 }],
      catchNotice: "",
      giveMoneyAmount: 0,
      uploadNames: {}
    };
    const grid = document.querySelector("#grid");
    const statusEl = document.querySelector("#status");
    const fishRarities = ["Common", "Uncommon", "Rare", "Epic", "Legendary", "Secret", "Mythic", "Divine", "Celestial", "Abyssal", "Transcendent"];
    let imageLoadToken = 0;

    function setStatus(message, isError = false) {
      statusEl.textContent = message;
      statusEl.style.color = isError ? "var(--danger)" : "var(--muted)";
    }

    const editableTabs = new Set(["fish", "rods", "fishBags", "admin", "settings", "event", "routine"]);
    const seedableTabs = new Set(["fish", "rods", "fishBags"]);

    function setProcessing(processing, message = "Processing data…") {
      state.processing = processing;
      document.querySelector("#loading-message").textContent = message;
      document.querySelector("#loading-screen").classList.toggle("active", processing);
      if (!processing) setLoadingProgress();
      document.querySelectorAll("button, input, textarea, select").forEach((element) => {
        if (processing) element.setAttribute("data-processing-disabled", element.disabled ? "already" : "temporary");
        if (processing) element.disabled = true;
        else if (element.dataset.processingDisabled === "temporary") element.disabled = false;
        if (!processing) delete element.dataset.processingDisabled;
      });
    }

    function setLoadingProgress(current, total, message = "") {
      const progress = document.querySelector("#loading-progress");
      const bar = document.querySelector("#loading-progress-bar");
      const text = document.querySelector("#loading-progress-text");
      const hasProgress = Number.isFinite(Number(total)) && Number(total) >= 0;
      progress.classList.toggle("active", hasProgress);
      if (!hasProgress) {
        bar.style.width = "0%";
        text.textContent = "";
        return;
      }
      const safeTotal = Math.max(0, Number(total));
      const safeCurrent = Math.max(0, Math.min(Number(current || 0), safeTotal));
      bar.style.width = (safeTotal ? safeCurrent / safeTotal * 100 : 100) + "%";
      text.textContent = message || (safeCurrent + " of " + safeTotal);
    }

    async function runWithLoading(message, work) {
      if (state.processing) return;
      setProcessing(true, message);
      try {
        return await work();
      } finally {
        setProcessing(false);
        updateTabToolbar();
      }
    }

    function updateTabToolbar() {
      const editable = editableTabs.has(state.tab);
      const loaded = Boolean(state.loadedTabs[state.tab]);
      const saveButton = document.querySelector("#save");
      const seedButton = document.querySelector("#seed");
      if (!saveButton || !seedButton) return;
      saveButton.hidden = !editable;
      saveButton.disabled = state.processing || !loaded;
      seedButton.hidden = !seedableTabs.has(state.tab);
      seedButton.disabled = state.processing || !loaded;
      document.querySelector("#tab-save-note").textContent = editable
        ? loaded ? "Only this tab’s data will be changed." : "Load must finish before this tab can be saved."
        : "This tab is read-only and loads its required data independently.";
    }

    function iconSize(item) {
      return item.iconBase64 ? Math.round(item.iconBase64.length / 1024) : 0;
    }

    function makeEmptyItem() {
      const type = state.createItemType || state.tab;
      if (type === "fish") {
        return { id: "new_fish_" + Date.now(), name: "New Fish", rarity: "Common", baseWeight: 10, minWeight: 1, maxWeight: 5, luckScale: 0, exp: 5, gold: 10, serverId: "", description: "", descriptions: [], iconBase64: "" };
      }
      if (type === "admin") {
        return "";
      }
      if (type === "fishBags") {
        return { id: "new_fish_bag_" + Date.now(), name: "New Fish Bag", rarity: "Common", price: 100, spaceKg: 50, description: "", bonuses: [], iconBase64: "" };
      }
      return { id: "new_rod_" + Date.now(), name: "New Rod", rarity: "Common", price: 100, speed: 5, luck: 1, maxWeight: 10, description: "", iconBase64: "" };
    }

    function updateItem(index, key, value) {
      state[state.tab][index][key] = value;
    }

    function findCurrentItem(collection, selectedId, fallbackItem) {
      return collection.find((item) => item === fallbackItem)
        || collection.find((item) => String(item.id || "") === selectedId)
        || null;
    }

    function captureScrollState() {
      return {
        fishGallery: document.querySelector(".fish-gallery")?.scrollTop || 0,
        playerList: document.querySelector(".player-list")?.scrollTop || 0
      };
    }

    function restoreScrollState(scrollState) {
      requestAnimationFrame(() => {
        const fishGallery = document.querySelector(".fish-gallery");
        const playerList = document.querySelector(".player-list");
        if (fishGallery) fishGallery.scrollTop = scrollState.fishGallery || 0;
        if (playerList) playerList.scrollTop = scrollState.playerList || 0;
        hydrateVisibleImages();
      });
    }

    function captureFocusState() {
      const active = document.activeElement;
      if (!active || !grid.contains(active)) {
        return null;
      }
      const searchSelector = ["fishSearch", "rodSearch", "fishBagSearch"]
        .map((key) => active.dataset[key] !== undefined ? "[data-" + key.replace(/[A-Z]/g, (letter) => "-" + letter.toLowerCase()) + "]" : "")
        .find(Boolean);
      if (!searchSelector) {
        return null;
      }
      return {
        selector: searchSelector,
        start: typeof active.selectionStart === "number" ? active.selectionStart : null,
        end: typeof active.selectionEnd === "number" ? active.selectionEnd : null
      };
    }

    function restoreFocusState(focusState) {
      if (!focusState) {
        return;
      }
      requestAnimationFrame(() => {
        const input = document.querySelector(focusState.selector);
        if (!input) {
          return;
        }
        input.focus({ preventScroll: true });
        if (focusState.start !== null && typeof input.setSelectionRange === "function") {
          input.setSelectionRange(focusState.start, focusState.end ?? focusState.start);
        }
      });
    }

    function cachedImageSource(source, messageUrl = "", imageName = "image.png") {
      const value = String(source || "").trim();
      const reference = String(messageUrl || "").trim();
      if ((!value && !reference) || value.startsWith("data:") || value.startsWith("blob:")) {
        return value;
      }
      const lowerValue = value.toLowerCase();
      if (value && !lowerValue.startsWith("http://") && !lowerValue.startsWith("https://")) {
        return value;
      }
      return "/api/image-cache?url=" + encodeURIComponent(value)
        + "&messageUrl=" + encodeURIComponent(reference)
        + "&name=" + encodeURIComponent(String(imageName || "image.png"));
    }

    function imageMessageUrl(owner, baseKey) {
      if (owner?.[baseKey + "Base64"] || owner?.[baseKey + "UrlNeedsRehost"] === true || owner?.iconNeedsRehost === true) {
        return "";
      }
      return String(owner?.[baseKey + "MessageUrl"] || owner?.[baseKey + "Ref"]?.messageUrl || "").trim();
    }

    function lazyImageTemplate(source, className = "", alt = "", messageUrl = "", imageName = "image.png") {
      const cachedSource = cachedImageSource(source, messageUrl, imageName);
      if (!cachedSource) {
        return "";
      }
      const classAttribute = className ? ' class="' + escapeHtml(className) + '"' : "";
      return '<img' + classAttribute + ' alt="' + escapeHtml(alt) + '" loading="lazy" decoding="async" data-lazy-src="' + escapeHtml(cachedSource) + '">';
    }

    function imageOrEmptyTemplate(source, className = "", alt = "", emptyText = "No image", messageUrl = "", imageName = "image.png") {
      return lazyImageTemplate(source, className, alt, messageUrl, imageName) || '<div class="empty-preview">' + escapeHtml(emptyText) + '</div>';
    }

    function hydrateVisibleImages() {
      const token = ++imageLoadToken;
      const images = Array.from(grid.querySelectorAll("img[data-lazy-src]"));
      let index = 0;
      let active = 0;
      const loadNext = () => {
        if (token !== imageLoadToken) return;
        while (active < 3 && index < images.length) {
          const image = images[index++];
          const source = image.dataset.lazySrc;
          if (!source || image.src) continue;
          active += 1;
          image.addEventListener("load", () => {
            active -= 1;
            loadNext();
          }, { once: true });
          image.addEventListener("error", () => {
            active -= 1;
            image.replaceWith(Object.assign(document.createElement("div"), {
              className: "empty-preview",
              textContent: "Image unavailable"
            }));
            loadNext();
          }, { once: true });
          image.src = source;
        }
      };
      loadNext();
    }

    function render(options = {}) {
      const scrollState = captureScrollState();
      const focusState = options.preserveFocus ? captureFocusState() : null;
      const finishRender = () => {
        restoreScrollState(scrollState);
        restoreFocusState(focusState);
      };
      document.querySelectorAll("[data-tab]").forEach((button) => {
        button.classList.toggle("active", button.dataset.tab === state.tab);
      });
      updateTabToolbar();
      grid.innerHTML = "";

      if (state.tab === "players") {
        grid.innerHTML = playerManagementTemplate();
        finishRender();
        return;
      }

      if (state.tab === "admin") {
        grid.innerHTML = adminTabTemplate();
        finishRender();
        return;
      }

      if (state.tab === "settings") {
        const card = document.createElement("article");
        card.className = "item settings-panel";
        card.innerHTML = settingsTemplate();
        grid.appendChild(card);
        grid.insertAdjacentHTML("beforeend", createOverlayTemplate());
        finishRender();
        return;
      }

      if (state.tab === "event") {
        const listCard = document.createElement("article");
        listCard.className = "item";
        listCard.innerHTML = eventListTemplate();
        grid.appendChild(listCard);
        grid.insertAdjacentHTML("beforeend", createOverlayTemplate());
        finishRender();
        return;
      }

      if (state.tab === "routine") {
        const listCard = document.createElement("article");
        listCard.className = "item";
        listCard.innerHTML = routineListTemplate();
        grid.appendChild(listCard);
        grid.insertAdjacentHTML("beforeend", createOverlayTemplate());
        finishRender();
        return;
      }

      if (state.tab === "fish") {
        grid.innerHTML = fishTabTemplate() + createOverlayTemplate();
        finishRender();
        return;
      }

      if (state.tab === "rods") {
        grid.innerHTML = rodTabTemplate() + createOverlayTemplate();
        finishRender();
        return;
      }

      if (state.tab === "fishBags") {
        grid.innerHTML = fishBagTabTemplate() + createOverlayTemplate();
        finishRender();
        return;
      }

      if (state.tab === "calc") {
        grid.innerHTML = calcTableTemplate();
        finishRender();
        return;
      }
      finishRender();
    }

    function adminTemplate(adminDiscordId, index) {
      return \`
        <div class="topline"><div class="small">Admin</div><button class="danger" data-remove="\${index}">Remove</button></div>
        <div class="fields">
          \${field("Discord ID or Username", "adminDiscordId", adminDiscordId, index)}
          <div class="wide small">Use a numeric Discord user ID, or a username like azaralea. Only these admins can use \${escapeHtml("${prefix}")}fish for instant test fishing.</div>
        </div>\`;
    }

    function adminTabTemplate() {
      const rows = state.adminDiscordIds.length
        ? state.adminDiscordIds.map((adminDiscordId, index) => \`<article class="item">\${adminTemplate(adminDiscordId, index)}</article>\`).join("")
        : '<article class="item"><div class="small">No admins yet.</div></article>';
      return \`
        <article class="item wide">
          <div class="topline">
            <strong>Admin Control</strong>
            <button data-add-admin>Add Admin</button>
          </div>
        </article>
        \${rows}\`;
    }

    function selectedPlayerRecord() {
      return state.players.find((player) => player.playFabId === state.selectedPlayerId) || state.players[0] || null;
    }

    function playerManagementTemplate() {
      const selected = selectedPlayerRecord();
      const rows = state.players.length ? state.players.map((record) => playerRowTemplate(record, selected?.playFabId === record.playFabId)).join("") : '<div class="small">No players loaded.</div>';
      return \`
        <div class="player-layout">
          <article class="item">
            <div class="topline">
              <strong>Players</strong>
              <button data-load-players>Refresh</button>
            </div>
            <input data-player-search placeholder="Search Discord ID or username" value="\${escapeHtml(state.playerSearch)}">
            <div class="button-row">
              <button data-search-players>Search</button>
              <button data-open-enforce-all-fishing>Enforce Fishing To All Player</button>
              <button data-refresh-all-entot>Refresh Entot For All Players</button>
              <button class="danger" data-reset-all-players>Reset All Player Data</button>
              <button class="danger" data-delete-all-players>Delete All Players</button>
            </div>
            <div class="small">Delete is queued by PlayFab. Reset is immediate and keeps the account but clears fishing progress.</div>
            <div class="player-list">\${rows}</div>
          </article>
          <article class="item">
            \${selected ? playerPanelTemplate(selected) : '<div class="small">Select a player to manage their data.</div>'}
          </article>
          \${state.enforceModalOpen ? enforceFishingModalTemplate(selected) : ""}
          \${state.enforceAllModalOpen ? enforceFishingForAllModalTemplate() : ""}
        </div>\`;
    }

    function playerRowTemplate(record, active) {
      const player = record.player || {};
      return \`
        <button class="player-row \${active ? "active" : ""}" data-select-player="\${escapeHtml(record.playFabId)}">
          <strong>\${escapeHtml(record.displayName || record.username || record.discordUserId || record.playFabId)}</strong>
          <span class="small">Discord: \${escapeHtml(record.discordUserId || player.discordUserId || "-")} · Fish: \${Number(player.totalFishCaught || 0)} · EXP: \${Number(player.exp || 0)}</span>
        </button>\`;
    }

    function playerPanelTemplate(record) {
      const player = record.player || {};
      return \`
        <div class="topline">
          <strong>\${escapeHtml(record.displayName || record.username || record.playFabId)}</strong>
          <span class="badge">\${escapeHtml(record.playFabId)}</span>
        </div>
        \${state.catchNotice ? \`<div class="small warning">\${escapeHtml(state.catchNotice)}</div>\` : ""}
        <div class="fields">
          \${playerField("Discord ID", "discordUserId", player.discordUserId || record.discordUserId || "")}
          \${playerField("Username", "discordUsername", player.discordUsername || record.username || "")}
          \${playerField("Display Name", "discordDisplayName", player.discordDisplayName || record.displayName || "")}
          \${playerField("Global Name", "discordGlobalName", player.discordGlobalName || "")}
          \${playerField("Gold", "gold", player.gold || 0, "number", "1")}
          \${playerField("EXP", "exp", player.exp || 0, "number", "1")}
          \${playerField("Rod ID", "rodId", player.rodId || "")}
          \${playerField("Fish Bag ID", "fishBagId", player.fishBagId || "")}
          \${playerField("Showcased Fish ID", "showcasedFishId", player.showcasedFishId || "")}
          \${playerField("Progress", "progress", player.progress || 0, "number", "1")}
          \${playerField("Total Fish Caught", "totalFishCaught", player.totalFishCaught || 0, "number", "1")}
          \${playerField("FishComp Wins", "fishCompWins", player.fishCompWins || 0, "number", "1")}
          \${playerField("Last Fishing Channel ID", "lastFishingChannelId", player.lastFishingChannelId || "")}
          \${playerField("Last Fishing Server ID", "lastFishingGuildId", player.lastFishingGuildId || "")}
          \${playerField("Voice Total, ms", "voiceTotalMs", player.voiceTotalMs || 0, "number", "1000")}
          \${playerField("Daily Last Claimed At", "dailyLastClaimedAt", player.dailyLastClaimedAt || 0, "number", "1000")}
          \${playerField("Daily Streak", "dailyStreak", player.dailyStreak || 0, "number", "1")}
          <label class="wide">Owned Rod IDs JSON<textarea data-player-json="ownedRods">\${escapeHtml(JSON.stringify(player.ownedRods || [], null, 2))}</textarea></label>
          <label class="wide">Owned Fish Bag IDs JSON<textarea data-player-json="ownedFishBags">\${escapeHtml(JSON.stringify(player.ownedFishBags || [], null, 2))}</textarea></label>
          <label class="wide">Inventory JSON<textarea data-player-json="inventory">\${escapeHtml(JSON.stringify(player.inventory || {}, null, 2))}</textarea></label>
          <label class="wide">FishDex JSON<textarea data-player-json="fishDex">\${escapeHtml(JSON.stringify(player.fishDex || {}, null, 2))}</textarea></label>
          <label class="wide">Heaviest Fish JSON<textarea data-player-json="heaviestFish">\${escapeHtml(JSON.stringify(player.heaviestFish || null, null, 2))}</textarea></label>
          <label class="wide">Luckiest Fish JSON<textarea data-player-json="luckiestFish">\${escapeHtml(JSON.stringify(player.luckiestFish || null, null, 2))}</textarea></label>
          <div class="wide button-row">
            <label>Give Money Amount<input type="number" step="1" min="1" data-give-money-amount value="\${escapeHtml(String(state.giveMoneyAmount || ""))}"></label>
            <button data-give-money>Give Money</button>
          </div>
          <div class="wide button-row">
            <button class="primary" data-save-player>Save Player</button>
            <button data-open-enforce-fishing>Enforce Fishing</button>
            <button data-refresh-entot>Refresh Entot</button>
            <button data-make-admin>Make Admin</button>
            <button class="danger" data-reset-player>Reset Player Data</button>
            <button class="danger" data-delete-player>Delete Player</button>
          </div>
        </div>\`;
    }

    function enforceFishingModalTemplate(record) {
      const player = record?.player || {};
      const name = record ? (record.displayName || record.username || player.discordUsername || record.playFabId) : "Selected Player";
      const rows = getEnforceFishSelections().map((selection, index) => enforceFishRowTemplate(selection, index, "single")).join("");
      return \`
        <div class="modal-overlay" data-enforce-modal-overlay>
          <section class="modal-panel" role="dialog" aria-modal="true" aria-label="Enforce fishing">
            <div class="modal-header">
              <div>
                <strong>Enforce Fishing</strong>
                <div class="small">\${escapeHtml(name)}</div>
              </div>
              <button class="icon-button" data-close-enforce-modal type="button" aria-label="Close">x</button>
            </div>
            <div class="enforce-list">\${rows}</div>
            <div class="button-row">
              <button class="icon-button" data-add-enforce-fish type="button" aria-label="Add fish">+</button>
            </div>
            <div class="modal-actions">
              <button data-close-enforce-modal type="button">Cancel</button>
              <button class="primary" data-enforce-fishing type="button">Enforce Fishing</button>
            </div>
          </section>
        </div>\`;
    }

    function enforceFishingForAllModalTemplate() {
      const rows = getEnforceFishSelections("all").map((selection, index) => enforceFishRowTemplate(selection, index, "all")).join("");
      return \`
        <div class="modal-overlay" data-enforce-modal-overlay>
          <section class="modal-panel" role="dialog" aria-modal="true" aria-label="Enforce fishing for all players">
            <div class="modal-header">
              <div>
                <strong>Enforce Fishing To All Players</strong>
                <div class="small">Only players whose last fishing server matches the target are included. Leave it empty to include every player.</div>
              </div>
              <button class="icon-button" data-close-enforce-modal type="button" aria-label="Close">x</button>
            </div>
            <label>Target Discord Server ID, optional
              <input data-enforce-all-guild placeholder="Empty means all servers" value="\${escapeHtml(state.enforceAllGuildId)}">
            </label>
            <div class="enforce-list">\${rows}</div>
            <div class="button-row">
              <button class="icon-button" data-add-enforce-fish data-enforce-scope="all" type="button" aria-label="Add fish">+</button>
            </div>
            <div class="small">Each targeted player receives the complete fish list and quantities configured above.</div>
            <div class="modal-actions">
              <button data-close-enforce-modal type="button">Cancel</button>
              <button class="primary" data-enforce-all-fishing type="button">Enforce Fishing</button>
            </div>
          </section>
        </div>\`;
    }

    function getEnforceFishSelections(scope = "single") {
      const key = scope === "all" ? "enforceAllFishSelections" : "enforceFishSelections";
      if (!Array.isArray(state[key]) || !state[key].length) {
        state[key] = [{ fishId: "", quantity: 1 }];
      }
      return state[key];
    }

    function enforceFishRowTemplate(selection, index, scope = "single") {
      return \`
        <div class="enforce-row">
          <label>Fish<select data-enforce-fish-index="\${index}" data-enforce-scope="\${scope}">
            <option value="">Random</option>
            \${state.fish.map((fish) => {
              const fishId = String(fish.id || "");
              return \`<option value="\${escapeHtml(fishId)}" \${String(selection.fishId || "") === fishId ? "selected" : ""}>\${escapeHtml(fish.name || fish.id || "Unnamed Fish")}</option>\`;
            }).join("")}
          </select></label>
          <label>Qty<input type="number" min="1" max="99" step="1" data-enforce-quantity-index="\${index}" data-enforce-scope="\${scope}" value="\${escapeHtml(String(selection.quantity || 1))}"></label>
          <button class="icon-button danger" data-remove-enforce-fish="\${index}" data-enforce-scope="\${scope}" type="button" aria-label="Remove fish" \${getEnforceFishSelections(scope).length <= 1 ? "disabled" : ""}>x</button>
        </div>\`;
    }

    function modalTemplate(title, body, footer = "") {
      return \`
        <div class="modal-overlay" data-close-create-modal-overlay>
          <section class="modal-panel" role="dialog" aria-modal="true" aria-label="\${escapeHtml(title)}">
            <div class="modal-header">
              <strong>\${escapeHtml(title)}</strong>
              <button class="icon-button" data-close-create-modal type="button" aria-label="Close">x</button>
            </div>
            \${body}
            \${footer ? \`<div class="modal-actions">\${footer}</div>\` : ""}
          </section>
        </div>\`;
    }

    function createOverlayTemplate() {
      if (state.createModal === "event" && state.eventDraft) {
        return modalTemplate("Create Event", eventTemplate());
      }
      if (state.createModal === "routine" && state.routineDraft) {
        return modalTemplate(state.routineMessages.some((entry) => entry.id === state.routineDraft.id) ? "Edit Routine Message" : "Create Routine Message", routineTemplate());
      }
      if (state.createModal === "raidBoss" && state.raidBossDraft) {
        return modalTemplate("Create Raid Boss", raidBossCreateTemplate());
      }
      if (state.createModal === "item" && state.createItemDraft) {
        return modalTemplate(createItemTitle(), createItemTemplate(), '<button data-close-create-modal type="button">Cancel</button><button class="primary" data-save-created-item type="button">Save New</button>');
      }
      return "";
    }

    function createItemTitle() {
      return {
        fish: "Create Fish",
        rods: "Create Rod",
        fishBags: "Create Fish Bag"
      }[state.createItemType] || "Create Item";
    }

    function createItemTemplate() {
      const item = state.createItemDraft;
      if (state.createItemType === "fish") {
        return \`
          <div class="fields">
            \${createField("ID", "id", item.id)}
            \${createField("Name", "name", item.name)}
            <label>Rarity<select data-create-item-key="rarity">\${fishRarities.map((rarity) => \`<option \${item.rarity === rarity ? "selected" : ""}>\${rarity}</option>\`).join("")}</select></label>
            \${createField("Chance Weight", "baseWeight", item.baseWeight, "number", "0.01")}
            \${createField("Min Kg", "minWeight", item.minWeight, "number", "0.01")}
            \${createField("Max Kg", "maxWeight", item.maxWeight, "number", "0.01")}
            \${createField("Luck Scale", "luckScale", item.luckScale, "number", "0.01")}
            \${createField("EXP", "exp", item.exp, "number", "1")}
            \${createField("Sell Gold", "gold", item.gold, "number", "1")}
            \${createField("Server ID", "serverId", item.serverId || "")}
            <label class="wide">Descriptions, one per line<textarea data-create-item-key="description">\${escapeHtml(fishDescriptionsText(item))}</textarea></label>
            \${createField("Icon URL Import", "iconUrl", item.iconUrl || "", "url")}
            \${createIconField()}
          </div>\`;
      }
      if (state.createItemType === "fishBags") {
        return \`
          <div class="fields">
            \${createField("ID", "id", item.id)}
            \${createField("Name", "name", item.name)}
            <label>Rarity<select data-create-item-key="rarity">\${fishRarities.map((rarity) => \`<option \${item.rarity === rarity ? "selected" : ""}>\${rarity}</option>\`).join("")}</select></label>
            \${createField("Price", "price", item.price, "number", "1")}
            \${createField("Capacity Kg", "spaceKg", item.spaceKg, "number", "0.01")}
            <label class="wide">Description<textarea data-create-item-key="description">\${escapeHtml(item.description || "")}</textarea></label>
            <label class="wide">Bonuses JSON<textarea data-create-item-key="bonuses">\${escapeHtml(JSON.stringify(item.bonuses || [], null, 2))}</textarea></label>
            \${createField("Icon URL Import", "iconUrl", item.iconUrl || "", "url")}
            \${createIconField()}
          </div>\`;
      }
      return \`
        <div class="fields">
          \${createField("ID", "id", item.id)}
          \${createField("Name", "name", item.name)}
          <label>Rarity<select data-create-item-key="rarity">\${fishRarities.map((rarity) => \`<option \${item.rarity === rarity ? "selected" : ""}>\${rarity}</option>\`).join("")}</select></label>
          \${createField("Price", "price", item.price, "number", "1")}
          \${createField("Speed, Chats Needed", "speed", item.speed, "number", "1")}
          \${createField("Luck", "luck", item.luck, "number", "1")}
          \${createField("Max Kg", "maxWeight", item.maxWeight, "number", "0.01")}
          \${createField("Accuracy", "accuracy", item.accuracy, "number", "1")}
          <label class="wide">Description<textarea data-create-item-key="description">\${escapeHtml(item.description || "")}</textarea></label>
          <label class="wide">Bonuses JSON<textarea data-create-item-key="bonuses">\${escapeHtml(JSON.stringify(item.bonuses || [], null, 2))}</textarea></label>
          \${createField("Icon URL Import", "iconUrl", item.iconUrl || "", "url")}
          \${createIconField()}
        </div>\`;
    }

    function createField(label, key, value, type = "text", step = "") {
      return \`<label>\${label}<input type="\${type}" step="\${step}" data-create-item-key="\${key}" value="\${escapeHtml(String(value ?? ""))}"></label>\`;
    }

    function createIconField() {
      const item = state.createItemDraft || {};
      const source = item.iconBase64 || item.iconUrl || "";
      const size = item.iconBase64 ? Math.round(item.iconBase64.length / 1024) : 0;
      return \`
        <div class="wide image-panel">
          <strong>Icon</strong>
          \${imageOrEmptyTemplate(source, "image-preview", "Icon preview", "No preview", imageMessageUrl(item, "icon"), item.name || item.id || "icon")}
          <label class="file-picker"><span>Choose Image</span><input type="file" accept="image/png,image/jpeg,image/gif,image/webp" data-create-item-icon></label>
          <div class="small">\${source ? \`Preview ready\${size ? \` · \${size} KB\` : ""}.\` : "No image selected."}</div>
        </div>\`;
    }

    function openCreateItemModal(type) {
      state.createItemType = type;
      state.createItemDraft = makeEmptyItem();
      state.createModal = "item";
    }

    function closeCreateModal() {
      state.createModal = null;
      state.createItemDraft = null;
      state.createItemType = "";
      state.raidBossDraft = null;
      if (state.eventDraft && state.createModal !== "event") state.eventDraft = null;
      if (state.routineDraft && state.createModal !== "routine") state.routineDraft = null;
      delete state.uploadNames.createItemIcon;
    }

    function saveCreatedItem() {
      const type = state.createItemType;
      const item = state.createItemDraft;
      if (!type || !item) return;
      state[type].push(item);
      if (type === "fish") {
        state.selectedFishId = item.id;
        setFishPageForId(item.id);
      }
      if (type === "rods") {
        state.selectedRodId = item.id;
      }
      if (type === "fishBags") {
        state.selectedFishBagId = item.id;
      }
      state.createModal = null;
      state.createItemDraft = null;
      state.createItemType = "";
      delete state.uploadNames.createItemIcon;
      setStatus("New item added locally. Press Save to store changes.");
    }

    function playerField(label, key, value, type = "text", step = "") {
      return \`<label>\${label}<input type="\${type}" step="\${step}" data-player-key="\${key}" value="\${escapeHtml(String(value ?? ""))}"></label>\`;
    }

    function settingsTemplate() {
      const tabs = \`
        <div class="tabs wide">
          <button class="\${state.settingsTab === "general" ? "active" : ""}" data-settings-tab="general" type="button">General</button>
          <button class="\${state.settingsTab === "fishcomp" ? "active" : ""}" data-settings-tab="fishcomp" type="button">FishComp</button>
          <button class="\${state.settingsTab === "fishduel" ? "active" : ""}" data-settings-tab="fishduel" type="button">FishDuel</button>
          <button class="\${state.settingsTab === "fishraid" ? "active" : ""}" data-settings-tab="fishraid" type="button">FishRaid</button>
        </div>\`;
      const body = {
        general: settingsGeneralTemplate,
        fishcomp: settingsFishCompTemplate,
        fishduel: settingsFishDuelTemplate,
        fishraid: settingsFishRaidTemplate
      }[state.settingsTab]?.() || settingsGeneralTemplate();
      return \`
        <div class="topline">
          <strong>Game Settings</strong>
          <span>
            <button data-export-settings type="button">Export Settings</button>
            <label class="file-picker"><span>Import Settings</span><input type="file" accept="application/json,.json" data-import-settings></label>
          </span>
        </div>
        \${tabs}
        \${body}\`;
    }

    function settingsGeneralTemplate() {
      return \`
        <div class="fields">
          \${field("Chat Cooldown, ms", "chatCooldownMs", state.settings.chatCooldownMs, 0, "number", "100")}
          \${field("EXP Multiplier", "expMultiplier", state.settings.expMultiplier, 0, "number", "0.01")}
          \${field("Level EXP Multiplier", "levelExpMultiplier", state.settings.levelExpMultiplier ?? 1, 0, "number", "0.01")}
          \${field("Voice Progress Amount", "voiceExpAmount", state.settings.voiceExpAmount ?? 1, 0, "number", "1")}
          \${field("Voice Progress Interval, minutes", "voiceExpIntervalMinutes", state.settings.voiceExpIntervalMinutes ?? 15, 0, "number", "1")}
          <label class="wide toggle-row"><input type="checkbox" data-key="allowActivity" \${state.settings.allowActivity !== false ? "checked" : ""}> Allow Activity</label>
          <div class="wide small">EXP Multiplier changes EXP gained from fish. Voice Progress Amount and Interval control passive fishing progress from voice.</div>
          <div class="image-grid">
            \${settingsImageFields("Rod Store Image", "rodStoreImage")}
            \${settingsImageFields("Fish Guide Banner", "fishGuideBanner")}
            \${settingsImageFields("Fish Help Banner", "fishHelpBanner")}
            \${settingsImageFields("Sell Fish Banner", "sellFishBanner")}
          </div>
        </div>\`;
    }

    function settingsFishCompTemplate() {
      return \`
        <div class="fields">
          \${field("Competition EXP Reward", "fishCompExpReward", state.settings.fishCompExpReward ?? 50, 0, "number", "1")}
          \${field("Competition Gold Reward", "fishCompGoldReward", state.settings.fishCompGoldReward ?? 0, 0, "number", "1")}
          \${field("Fish Comp Log Interval, ms", "fishCompLogIntervalMs", state.settings.fishCompLogIntervalMs ?? 2500, 0, "number", "100")}
          \${field("History Log Lifetime, hours", "fishCompHistoryLogHours", state.settings.fishCompHistoryLogHours ?? 24, 0, "number", "1")}
          <label class="wide">Fish Comp Events JSON<textarea data-settings-json="fishCompEvents">\${escapeHtml(JSON.stringify(state.settings.fishCompEvents || [], null, 2))}</textarea></label>
          <div class="wide small">Use {user} and {target} in event text. Chance is percent per player turn. Types: stun, buff, debuff, empty. luckModifier changes competition luck while active. Winner rewards are multiplied by participant count.</div>
          <div class="image-grid">
            \${settingsImageFields("Fish Comp Registration Banner", "fishCompRegistrationBanner")}
            \${settingsImageFields("Fish Comp Competition Banner", "fishCompRunningBanner")}
            \${settingsImageFields("Fish Comp Result Banner", "fishCompResultBanner")}
            \${settingsImageFields("Legacy Fish Comp Banner", "fishCompBanner")}
          </div>
        </div>\`;
    }

    function settingsFishDuelTemplate() {
      return \`
        <div class="fields">
          \${field("Duel Winner EXP Reward", "fishDuelExpReward", state.settings.fishDuelExpReward ?? 40, 0, "number", "1")}
          \${field("Fish Duel Log Interval, ms", "fishDuelLogIntervalMs", state.settings.fishDuelLogIntervalMs ?? 2500, 0, "number", "100")}
          <label class="wide">Fish Duel Events JSON<textarea data-settings-json="fishDuelEvents">\${escapeHtml(JSON.stringify(state.settings.fishDuelEvents || [], null, 2))}</textarea></label>
          <div class="wide small">FishDuel events use the FishComp event format. Optional bet gold is paid separately from this EXP reward.</div>
          <div class="image-grid">
            \${settingsImageFields("Fish Duel Registration Banner", "fishDuelRegistrationBanner")}
            \${settingsImageFields("Fish Duel Running Banner", "fishDuelRunningBanner")}
            \${settingsImageFields("Fish Duel Result Banner", "fishDuelResultBanner")}
          </div>
        </div>\`;
    }

    function settingsFishRaidTemplate() {
      return \`
        <div class="fishraid-settings-layout wide">
          <div class="fishraid-main-panel fields">
            \${field("Raid Participant EXP Reward", "fishRaidParticipantExpReward", state.settings.fishRaidParticipantExpReward ?? 25, 0, "number", "1")}
            \${field("Raid Participant Gold Reward", "fishRaidParticipantGoldReward", state.settings.fishRaidParticipantGoldReward ?? 0, 0, "number", "1")}
            \${field("Raid MVP EXP Reward", "fishRaidMvpExpReward", state.settings.fishRaidMvpExpReward ?? 75, 0, "number", "1")}
            \${field("Raid MVP Gold Reward", "fishRaidMvpGoldReward", state.settings.fishRaidMvpGoldReward ?? 0, 0, "number", "1")}
            \${field("Clear Participant Bonus EXP", "fishRaidClearParticipantExpReward", state.settings.fishRaidClearParticipantExpReward ?? 50, 0, "number", "1")}
            \${field("Clear Participant Bonus Gold", "fishRaidClearParticipantGoldReward", state.settings.fishRaidClearParticipantGoldReward ?? 0, 0, "number", "1")}
            \${field("Clear MVP Bonus EXP", "fishRaidClearMvpExpReward", state.settings.fishRaidClearMvpExpReward ?? 150, 0, "number", "1")}
            \${field("Clear MVP Bonus Gold", "fishRaidClearMvpGoldReward", state.settings.fishRaidClearMvpGoldReward ?? 0, 0, "number", "1")}
            \${field("Fish Raid Log Interval, ms", "fishRaidLogIntervalMs", state.settings.fishRaidLogIntervalMs ?? 2500, 0, "number", "100")}
            \${field("Fish Raid Cooldown, minutes", "fishRaidCooldownMinutes", state.settings.fishRaidCooldownMinutes ?? 60, 0, "number", "1")}
            \${fishRaidControlsTemplate()}
            <label class="wide">Raid Events JSON<textarea data-settings-json="fishRaidEvents">\${escapeHtml(JSON.stringify(state.settings.fishRaidEvents || [], null, 2))}</textarea></label>
            <div class="wide small">Raid events use the same format as Fish Comp Events, but only affect FishRaid turns.</div>
          </div>
          \${fishRaidBossGridTemplate()}
        </div>\`;
    }

    function makeEmptyRaidBoss() {
      const id = "raid_boss_" + Date.now();
      return { id, name: "New Raid Boss", quotaKg: 100, description: "", registrationBannerBase64: "", registrationBannerUrl: "", runningBannerBase64: "", runningBannerUrl: "", resultBannerBase64: "", resultBannerUrl: "", fulfilledBannerBase64: "", fulfilledBannerUrl: "", failedBannerBase64: "", failedBannerUrl: "" };
    }

    function selectedRaidBossEntry() {
      const bosses = Array.isArray(state.settings.fishRaidBosses) ? state.settings.fishRaidBosses : [];
      return bosses
        .map((boss, index) => ({ boss, index }))
        .find((entry) => String(entry.boss.id || "") === state.selectedRaidBossId)
        || (bosses[0] ? { boss: bosses[0], index: 0 } : null);
    }

    function fishRaidControlsTemplate() {
      const guildState = state.fishRaidControlGuildId ? state.fishRaidState[state.fishRaidControlGuildId] : null;
      const statusText = guildState
        ? \`\${guildState.boss?.name || "Raid Boss"} · \${Number(guildState.filledKg || 0).toFixed(2)} / \${Number(guildState.quotaKg || 0).toFixed(2)} kg · \${guildState.fulfilledAt ? "Fulfilled" : "Active"}\`
        : "No local state loaded for this server yet.";
      return \`
        <section class="wide item">
          <div class="topline">
            <strong>Today's Raid Control</strong>
            <button data-load-fishraid-state type="button">Refresh State</button>
          </div>
          <div class="fields">
            <label>Discord Server ID<input data-fishraid-control="guildId" value="\${escapeHtml(state.fishRaidControlGuildId)}"></label>
            <label>Message Channel ID<input data-fishraid-control="channelId" value="\${escapeHtml(state.fishRaidControlChannelId)}"></label>
            <div class="wide small">\${escapeHtml(statusText)}</div>
            <div class="wide button-row">
              <button data-reset-fishraid-today type="button">Reset Today's Raid</button>
              <button data-reset-fishraid-cooldown type="button">Reset Cooldown</button>
              <button data-force-clear-fishraid type="button">Force Clear Raid</button>
            </div>
          </div>
        </section>\`;
    }

    function fishRaidBossGridTemplate() {
      const bosses = Array.isArray(state.settings.fishRaidBosses) ? state.settings.fishRaidBosses : [];
      if (!state.selectedRaidBossId && bosses[0]) {
        state.selectedRaidBossId = String(bosses[0].id || "");
      }
      const selected = selectedRaidBossEntry();
      const cards = bosses.length
        ? bosses.map((boss, index) => fishRaidBossCardTemplate(boss, index)).join("")
        : '<div class="small">No raid bosses yet.</div>';
      return \`
        <div class="raid-boss-panel item fish-detail">
          <div class="raid-boss-layout">
          <article class="item">
            <div class="fish-toolbar">
              <strong>Raid Bosses</strong>
              <button data-add-raid-boss type="button">Add Boss</button>
            </div>
            <div class="fish-gallery">\${cards}</div>
          </article>
          <article class="item">
            \${selected ? fishRaidBossDetailTemplate(selected.boss, selected.index) : '<div class="small">Click a raid boss to edit it.</div>'}
          </article>
          </div>
        </div>\`;
    }

    function fishRaidBossCardTemplate(boss, index) {
      const source = boss.registrationBannerBase64 || boss.registrationBannerUrl || boss.runningBannerBase64 || boss.runningBannerUrl || "";
      const active = String(boss.id || "") === state.selectedRaidBossId;
      return \`
        <button class="fish-card \${active ? "active" : ""}" data-select-raid-boss="\${escapeHtml(String(boss.id || ""))}" data-index="\${index}">
          \${imageOrEmptyTemplate(source, "", "", "No image", imageMessageUrl(boss, "registrationBanner"), boss.name || boss.id || "raid-boss")}
          <span>\${escapeHtml(boss.name || boss.id || "Raid Boss")}</span>
        </button>\`;
    }

    function fishRaidBossDetailTemplate(boss, index) {
      return \`
        <div class="topline">
          <strong>\${escapeHtml(boss.name || "Raid Boss")}</strong>
          <button class="danger" data-remove-raid-boss="\${index}" type="button">Remove</button>
        </div>
        <div class="fields">
          \${raidBossField("ID", "id", boss.id, index)}
          \${raidBossField("Name", "name", boss.name, index)}
          \${raidBossField("Quota Kg", "quotaKg", boss.quotaKg, index, "number", "0.01")}
          <label class="wide">Description<textarea data-raid-boss-index="\${index}" data-raid-boss-key="description">\${escapeHtml(boss.description || "")}</textarea></label>
          <div class="image-grid">
            \${raidBossImageFields("Registration Banner", "registrationBanner", boss, index)}
            \${raidBossImageFields("Running Banner", "runningBanner", boss, index)}
            \${raidBossImageFields("Finish Banner", "resultBanner", boss, index)}
            \${raidBossImageFields("Quota Fulfilled Banner", "fulfilledBanner", boss, index)}
            \${raidBossImageFields("Failed at Midnight Banner", "failedBanner", boss, index)}
          </div>
        </div>\`;
    }

    function raidBossCreateTemplate() {
      const boss = state.raidBossDraft || makeEmptyRaidBoss();
      return \`
        <div class="fields">
          \${raidBossField("ID", "id", boss.id, "draft")}
          \${raidBossField("Name", "name", boss.name, "draft")}
          \${raidBossField("Quota Kg", "quotaKg", boss.quotaKg, "draft", "number", "0.01")}
          <label class="wide">Description<textarea data-raid-boss-index="draft" data-raid-boss-key="description">\${escapeHtml(boss.description || "")}</textarea></label>
          <div class="image-grid">
            \${raidBossImageFields("Registration Banner", "registrationBanner", boss, "draft")}
            \${raidBossImageFields("Running Banner", "runningBanner", boss, "draft")}
            \${raidBossImageFields("Finish Banner", "resultBanner", boss, "draft")}
            \${raidBossImageFields("Quota Fulfilled Banner", "fulfilledBanner", boss, "draft")}
            \${raidBossImageFields("Failed at Midnight Banner", "failedBanner", boss, "draft")}
          </div>
        </div>
        <div class="modal-actions">
          <button data-close-create-modal type="button">Cancel</button>
          <button class="primary" data-save-created-raid-boss type="button">Save New Boss</button>
        </div>\`;
    }

    function raidBossField(label, key, value, index, type = "text", step = "") {
      return \`<label>\${label}<input type="\${type}" step="\${step}" data-raid-boss-index="\${index}" data-raid-boss-key="\${key}" value="\${escapeHtml(String(value ?? ""))}"></label>\`;
    }

    function raidBossImageFields(label, baseKey, boss, index) {
      const base64Key = \`\${baseKey}Base64\`;
      const urlKey = \`\${baseKey}Url\`;
      const uploadKey = \`raidBoss:\${index}:\${base64Key}\`;
      const size = boss[base64Key] ? Math.round(boss[base64Key].length / 1024) : 0;
      const source = boss[base64Key] || boss[urlKey] || "";
      const uploadName = state.uploadNames[uploadKey] || "";
      const status = uploadName ? \`Selected file: \${uploadName} · \${size} KB\` : source ? "Preview loaded from saved image or URL." : "No image selected.";
      return \`
          <section class="image-panel">
            <strong>\${label}</strong>
            \${imageOrEmptyTemplate(source, "image-preview", \`\${label} preview\`, "No preview", imageMessageUrl(boss, baseKey), boss.name || boss.id || baseKey)}
            \${raidBossField(\`\${label} URL Import\`, urlKey, boss[urlKey] || "", index, "url")}
            <label class="file-picker"><span>Choose Image</span><input type="file" accept="image/png,image/jpeg,image/gif,image/webp" data-raid-boss-image="\${base64Key}" data-raid-boss-index="\${index}"></label>
            <div class="small">\${escapeHtml(status)} File uploads are moved to the Discord storage channel when saved.</div>
            <button class="danger" data-clear-raid-boss-image="\${index}:\${base64Key}" type="button">Clear \${label}</button>
          </section>\`;
    }

    function settingsImageFields(label, baseKey) {
      const base64Key = \`\${baseKey}Base64\`;
      const urlKey = \`\${baseKey}Url\`;
      const size = state.settings[base64Key] ? Math.round(state.settings[base64Key].length / 1024) : 0;
      const source = state.settings[base64Key] || state.settings[urlKey] || "";
      const uploadName = state.uploadNames[base64Key] || "";
      const status = uploadName ? \`Selected file: \${uploadName} · \${size} KB\` : source ? "Preview loaded from saved image or URL." : "No image selected.";
      return \`
          <section class="image-panel">
            <strong>\${label}</strong>
            \${imageOrEmptyTemplate(source, "image-preview", \`\${label} preview\`, "No preview", imageMessageUrl(state.settings, baseKey), baseKey)}
            \${field(\`\${label} URL Import\`, urlKey, state.settings[urlKey] || "", 0, "url")}
            <label class="file-picker"><span>Choose Image</span><input type="file" accept="image/png,image/jpeg,image/gif,image/webp" data-settings-image="\${base64Key}"></label>
            <div class="small">\${escapeHtml(status)} File uploads are moved to the Discord storage channel when saved.</div>
            <button class="danger" data-clear-settings-image="\${base64Key}">Clear \${label}</button>
          </section>\`;
    }

    function makeEmptyEvent() {
      const startAt = formatDateTimeLocal(new Date());
      return { id: String(Date.now()), title: "", description: "", bannerBase64: "", bannerUrl: "", startAt, durationMinutes: 60, bonuses: [{ type: "gold_multiplier", value: 2, fishId: "" }], announcementChannelId: state.lastAnnouncementChannelId, guildId: "", stoppedAt: "", deployedAt: "" };
    }

    function formatDateTimeLocal(date) {
      const pad = (value) => String(value).padStart(2, "0");
      return [
        date.getFullYear(),
        pad(date.getMonth() + 1),
        pad(date.getDate())
      ].join("-") + "T" + [
        pad(date.getHours()),
        pad(date.getMinutes())
      ].join(":");
    }

    function getEvent() {
      if (!state.eventDraft) {
        state.eventDraft = makeEmptyEvent();
      }
      return state.eventDraft;
    }

    function normalizeEvent(event) {
      const bonuses = Array.isArray(event?.bonuses) && event.bonuses.length
        ? event.bonuses
        : [{ type: event?.type || "gold_multiplier", value: event?.value ?? 1, fishId: event?.fishId || "" }];
      return { ...(event || {}), bonuses };
    }

    function isEventRunning(event) {
      const now = Date.now();
      return Date.parse(event.startAt || event.deployedAt || 0) <= now && Date.parse(event.endsAt || 0) > now && !event.stoppedAt;
    }

    function eventStatusText(event) {
      const now = Date.now();
      if (event.stoppedAt || Date.parse(event.endsAt || 0) <= now) return "Ended";
      if (Date.parse(event.startAt || event.deployedAt || 0) > now) return "Scheduled";
      return "Running";
    }

    function eventBonusText(event) {
      return (normalizeEvent(event).bonuses || []).map((bonus) => {
        if (bonus.type === "gold_multiplier") return \`Gold x\${bonus.value}\`;
        if (bonus.type === "exp_multiplier") return \`EXP x\${bonus.value}\`;
        if (bonus.type === "fish_chance") return \`\${bonus.fishId || "Fish"} chance x\${bonus.value}\`;
        if (bonus.type === "fishing_speed") return \`Fishing speed x\${bonus.value}\`;
        return \`Bonus x\${bonus.value}\`;
      }).join(", ") || "No bonus";
    }

    function eventListTemplate() {
      const events = [...(state.events || [])].map(normalizeEvent).sort((a, b) => Date.parse(b.startAt || b.deployedAt || 0) - Date.parse(a.startAt || a.deployedAt || 0));
      const rows = events.length ? events.map((event) => {
        const running = isEventRunning(event);
        const status = eventStatusText(event);
        const canStop = status === "Running" || status === "Scheduled";
        const start = event.startAt ? new Date(event.startAt).toLocaleString() : "-";
        const end = event.endsAt ? new Date(event.endsAt).toLocaleString() : "-";
        return \`
          <div class="event-row">
            <div class="topline">
              <strong>\${escapeHtml(event.title || "Untitled Event")}</strong>
              <span class="badge">\${status}</span>
            </div>
            <div class="small">Bonus: \${escapeHtml(eventBonusText(event))}</div>
            \${event.description ? \`<div class="small event-description-preview">\${escapeHtml(event.description)}</div>\` : ""}
            <div class="small">Start: \${escapeHtml(start)} · End: \${escapeHtml(end)}</div>
            <div class="small">Announcement Channel: \${escapeHtml(event.announcementChannelId || "-")} · Server: \${escapeHtml(event.guildId || "resolved by bot after announce")}</div>
            \${canStop ? \`<button class="danger" data-stop-event="\${escapeHtml(event.id)}">\${running ? "Stop Event" : "Cancel Event"}</button>\` : \`<button class="danger" data-remove-event="\${escapeHtml(event.id)}">Remove</button>\`}
          </div>\`;
      }).join("") : \`<div class="small">No events yet.</div>\`;
      return \`
        <div class="topline">
          <strong>Events</strong>
          <div class="button-row">
            <button data-create-event type="button">Create New Event</button>
            <button data-export-events type="button">Export JSON</button>
            <label class="file-picker"><span>Import JSON</span><input type="file" accept="application/json,.json" data-import-events></label>
          </div>
        </div>
        <div class="event-scroll">\${rows}</div>\`;
    }

    function eventTemplate() {
      const event = getEvent();
      const bannerSize = event.bannerBase64 ? Math.round(event.bannerBase64.length / 1024) : 0;
      const bannerSource = event.bannerBase64 || event.bannerUrl || "";
      const bannerName = state.uploadNames.eventBanner || "";
      const bannerStatus = bannerName ? \`Selected file: \${bannerName} · \${bannerSize} KB\` : bannerSource ? "Preview loaded from saved image or URL." : "No image selected.";
      const bonuses = normalizeEvent(event).bonuses;
      return \`
        <div class="topline">
          <strong>Create Event</strong>
          <button class="danger" data-clear-event>Cancel</button>
        </div>
        <div class="fields">
          \${field("Title", "title", event.title, 0)}
          \${field("Start At", "startAt", event.startAt, 0, "datetime-local")}
          \${field("Duration, minutes", "durationMinutes", event.durationMinutes, 0, "number", "1")}
          \${field("Announcement Channel ID", "announcementChannelId", event.announcementChannelId, 0)}
          <div class="wide small">The bot applies this event across the whole server that contains the announcement channel.</div>
          <div class="wide fields">
            <div class="wide topline">
              <strong>Bonuses</strong>
              <button data-add-bonus type="button">Add Bonus</button>
            </div>
            \${bonuses.map((bonus, bonusIndex) => bonusTemplate(bonus, bonusIndex)).join("")}
          </div>
          <label class="wide">Description<textarea class="event-description-input" data-event-key="description">\${escapeHtml(event.description || "")}</textarea></label>
          <div class="image-grid">
            <section class="image-panel">
              <strong>Event Banner</strong>
              \${imageOrEmptyTemplate(bannerSource, "image-preview", "Event banner preview", "No preview", imageMessageUrl(event, "banner"), event.title || event.id || "event-banner")}
              \${field("Banner Image URL Import", "bannerUrl", event.bannerUrl || "", 0, "url")}
              <label class="file-picker"><span>Choose Image</span><input type="file" accept="image/png,image/jpeg,image/gif,image/webp" data-event-banner></label>
              <div class="small">\${escapeHtml(bannerStatus)} File uploads are moved to the Discord storage channel when saved.</div>
              <button class="danger" data-clear-event-banner>Clear Event Banner</button>
            </section>
          </div>
          <button class="primary" data-deploy-event>Deploy Event</button>
        </div>\`;
    }

    function makeEmptyRoutine() {
      return {
        id: String(Date.now()),
        name: "New Routine Message",
        title: "Ayo Memancing!",
        description: "FishComp sedang menunggu peserta. Tekan tombol di bawah untuk mulai lebih cepat.",
        messageVariants: [],
        color: "#36c28a",
        bannerBase64: "",
        bannerUrl: "",
        enabled: true,
        deleteAfterButtonClick: false,
        guildId: "",
        channelId: "",
        lastSentAt: "",
        lastTriggerKey: "",
        condition: { type: "daily_time", time: "00:00", intervalMinutes: 720, idleMinutes: 120, dateTime: formatDateTimeLocal(new Date(Date.now() + 60 * 60_000)) },
        buttons: [{ id: "fishcomp", label: "Start FishComp", action: "fishcomp", style: "Success", regtimeMinutes: 5, durationTurns: 15 }]
      };
    }

    function getRoutine() {
      if (!state.routineDraft) {
        state.routineDraft = makeEmptyRoutine();
      }
      if (!state.routineDraft.condition) {
        state.routineDraft.condition = { type: "daily_time", time: "00:00", intervalMinutes: 720, idleMinutes: 120, dateTime: formatDateTimeLocal(new Date()) };
      }
      if (!Array.isArray(state.routineDraft.buttons)) {
        state.routineDraft.buttons = [];
      }
      if (!Array.isArray(state.routineDraft.messageVariants)) {
        state.routineDraft.messageVariants = [];
      }
      return state.routineDraft;
    }

    function routineVariantsText(routine) {
      return (Array.isArray(routine.messageVariants) ? routine.messageVariants : [])
        .map((variant) => String(typeof variant === "string" ? variant : variant.description || ""))
        .filter(Boolean)
        .join("\\n---\\n");
    }

    function parseRoutineVariantsText(text) {
      return String(text || "")
        .split(/\\n\\s*---\\s*\\n/g)
        .map((description) => ({ title: "", description: description.trim() }))
        .filter((variant) => variant.description);
    }

    function cloneRoutineForEdit(routine) {
      return JSON.parse(JSON.stringify(routine || makeEmptyRoutine()));
    }

    function routineConditionText(routine) {
      const condition = routine.condition || {};
      if (condition.type === "daily_time") return \`Every day at \${condition.time || "00:00"}\`;
      if (condition.type === "interval") return \`Every \${condition.intervalMinutes || 60} minutes\`;
      if (condition.type === "idle_since_activity") return \`When no FishComp/FishRaid activity for \${condition.idleMinutes || 120} minutes\`;
      if (condition.type === "fishraid_cooldown_ready") return "When FishRaid cooldown is ready";
      if (condition.type === "specific_datetime") return condition.dateTime ? \`At \${new Date(condition.dateTime).toLocaleString()}\` : "At a specific date/time";
      return "Custom condition";
    }

    function routineListTemplate() {
      const routines = [...(state.routineMessages || [])].sort((a, b) => String(a.name || "").localeCompare(String(b.name || "")));
      const rows = routines.length ? routines.map((routine) => \`
        <div class="event-row">
          <div class="topline">
            <strong>\${escapeHtml(routine.name || routine.title || "Routine Message")}</strong>
            <span class="badge">\${routine.enabled === false ? "Paused" : "Active"}</span>
          </div>
          <div class="small">Condition: \${escapeHtml(routineConditionText(routine))}</div>
          <div class="small">Random messages: \${escapeHtml(String((routine.messageVariants || []).length || 0))}</div>
          <div class="small">Buttons: \${escapeHtml((routine.buttons || []).map((button) => button.label || button.action).join(", ") || "None")}</div>
          <div class="small">Server: \${escapeHtml(routine.guildId || "all configured popup servers")} · Channel override: \${escapeHtml(routine.channelId || "popup parent channel")}</div>
          \${routine.lastSentAt ? \`<div class="small">Last sent: \${escapeHtml(new Date(routine.lastSentAt).toLocaleString())}</div>\` : ""}
          <div class="button-row">
            <button data-edit-routine="\${escapeHtml(routine.id)}" type="button">Edit</button>
            <button class="danger" data-remove-routine="\${escapeHtml(routine.id)}" type="button">Remove</button>
          </div>
        </div>\`).join("") : \`<div class="small">No routine messages yet.</div>\`;
      return \`
        <div class="topline">
          <strong>Active Routine Messages</strong>
          <div class="button-row">
            <button data-create-routine type="button">Create New Message</button>
            <button data-export-routines type="button">Export JSON</button>
            <label class="file-picker"><span>Import JSON</span><input type="file" accept="application/json,.json" data-import-routines></label>
          </div>
        </div>
        <div class="event-scroll">\${rows}</div>\`;
    }

    function routineTemplate() {
      const routine = getRoutine();
      const condition = routine.condition || {};
      const bannerSize = routine.bannerBase64 ? Math.round(routine.bannerBase64.length / 1024) : 0;
      const bannerSource = routine.bannerBase64 || routine.bannerUrl || "";
      const bannerName = state.uploadNames.routineBanner || "";
      const bannerStatus = bannerName ? \`Selected file: \${bannerName} · \${bannerSize} KB\` : bannerSource ? "Preview loaded from saved image or URL." : "No image selected.";
      return \`
        <div class="topline">
          <strong>\${state.routineMessages.some((entry) => entry.id === routine.id) ? "Edit Routine Message" : "Create Routine Message"}</strong>
          <button class="danger" data-clear-routine type="button">Cancel</button>
        </div>
        <div class="fields">
          \${routineField("Name", "name", routine.name)}
          \${routineField("Embed Title", "title", routine.title)}
          \${routineField("Embed Color", "color", routine.color || "#36c28a", "color")}
          <label>Condition<select data-routine-condition-key="type">
            \${[
              ["daily_time", "Every day at a time"],
              ["interval", "Every N minutes"],
              ["idle_since_activity", "Idle since FishComp/FishRaid"],
              ["fishraid_cooldown_ready", "FishRaid cooldown ready"],
              ["specific_datetime", "Specific date/time"]
            ].map(([value, label]) => \`<option value="\${value}" \${condition.type === value ? "selected" : ""}>\${label}</option>\`).join("")}
          </select></label>
          \${condition.type === "daily_time" ? \`<label>Daily Time<input type="time" data-routine-condition-key="time" value="\${escapeHtml(condition.time || "00:00")}"></label>\` : ""}
          \${condition.type === "interval" ? \`<label>Interval Minutes<input type="number" min="1" step="1" data-routine-condition-key="intervalMinutes" value="\${escapeHtml(String(condition.intervalMinutes || 60))}"></label>\` : ""}
          \${condition.type === "idle_since_activity" ? \`<label>Idle Minutes<input type="number" min="1" step="1" data-routine-condition-key="idleMinutes" value="\${escapeHtml(String(condition.idleMinutes || 120))}"></label>\` : ""}
          \${condition.type === "specific_datetime" ? \`<label>Date Time<input type="datetime-local" data-routine-condition-key="dateTime" value="\${escapeHtml(condition.dateTime || "")}"></label>\` : ""}
          \${routineField("Discord Server ID, optional", "guildId", routine.guildId || "")}
          \${routineField("Channel ID Override, optional", "channelId", routine.channelId || "")}
          <label class="wide toggle-row"><input type="checkbox" data-routine-bool-key="enabled" \${routine.enabled !== false ? "checked" : ""}> Enabled</label>
          <label class="wide toggle-row"><input type="checkbox" data-routine-bool-key="deleteAfterButtonClick" \${routine.deleteAfterButtonClick ? "checked" : ""}> Delete message from Discord after a routine button is clicked</label>
          <label class="wide">Default Embed Description<textarea class="event-description-input" data-routine-key="description">\${escapeHtml(routine.description || "")}</textarea></label>
          <label class="wide">Random Messages, split with ---<textarea class="event-description-input" data-routine-variants>\${escapeHtml(routineVariantsText(routine))}</textarea></label>
          <div class="wide fields">
            <div class="wide topline">
              <strong>Buttons</strong>
              <button data-add-routine-button type="button">Add Button</button>
            </div>
            \${(routine.buttons || []).map((button, buttonIndex) => routineButtonTemplate(button, buttonIndex)).join("") || '<div class="small">No buttons. The routine can still send a message without buttons.</div>'}
          </div>
          <div class="image-grid">
            <section class="image-panel">
              <strong>Routine Banner</strong>
              \${imageOrEmptyTemplate(bannerSource, "image-preview", "Routine banner preview", "No preview", imageMessageUrl(routine, "banner"), routine.name || routine.id || "routine-banner")}
              \${routineField("Banner Image URL Import", "bannerUrl", routine.bannerUrl || "", "url")}
              <label class="file-picker"><span>Choose Image</span><input type="file" accept="image/png,image/jpeg,image/gif,image/webp" data-routine-banner></label>
              <div class="small">\${escapeHtml(bannerStatus)} File uploads are moved to the Discord storage channel when saved.</div>
              <button class="danger" data-clear-routine-banner type="button">Clear Routine Banner</button>
            </section>
          </div>
          <button class="primary" data-deploy-routine type="button">\${state.routineMessages.some((entry) => entry.id === routine.id) ? "Save Routine Message" : "Deploy Routine Message"}</button>
        </div>\`;
    }

    function routineButtonTemplate(button, buttonIndex) {
      return \`
        <div class="bonus-row wide">
          <div class="fields">
            <label>Label<input data-routine-button-index="\${buttonIndex}" data-routine-button-key="label" value="\${escapeHtml(button.label || "")}"></label>
            <label>Action<select data-routine-button-index="\${buttonIndex}" data-routine-button-key="action">
              \${[
                ["fishcomp", "Start FishComp"],
                ["fishraid", "Start FishRaid"],
                ["fishstore", "Open Fish Store"],
                ["fishdex", "Open FishDex"],
                ["fishdaily", "Use Fish Daily"],
                ["fishguide", "Open Fish Guide"],
                ["fishprofile", "Open Fish Profile"],
                ["fishleaderboard", "Open Leaderboard"]
              ].map(([value, label]) => \`<option value="\${value}" \${button.action === value ? "selected" : ""}>\${label}</option>\`).join("")}
            </select></label>
            <label>Style<select data-routine-button-index="\${buttonIndex}" data-routine-button-key="style">
              \${["Primary", "Secondary", "Success", "Danger"].map((style) => \`<option value="\${style}" \${(button.style || "Primary") === style ? "selected" : ""}>\${style}</option>\`).join("")}
            </select></label>
            <label>Reg Time Minutes<input type="number" min="1" step="1" data-routine-button-index="\${buttonIndex}" data-routine-button-key="regtimeMinutes" value="\${escapeHtml(String(button.regtimeMinutes || 5))}"></label>
            <label>Duration Turns<input type="number" min="1" step="1" data-routine-button-index="\${buttonIndex}" data-routine-button-key="durationTurns" value="\${escapeHtml(String(button.durationTurns || 15))}"></label>
            <button class="danger" data-remove-routine-button="\${buttonIndex}" type="button">Remove Button</button>
          </div>
        </div>\`;
    }

    function routineField(label, key, value, type = "text") {
      return \`<label>\${label}<input type="\${type}" data-routine-key="\${key}" value="\${escapeHtml(String(value ?? ""))}"></label>\`;
    }

    function bonusTemplate(bonus, bonusIndex) {
      const fishDatalistId = \`fish-id-options-\${bonusIndex}\`;
      const fishOptions = state.fish
        .map((fish) => {
          const fishId = String(fish.id || "");
          return \`<option value="\${escapeHtml(fishId)}" \${bonus.fishId === fishId ? "selected" : ""}>\${escapeHtml(fish.name || fish.id || "")} (\${escapeHtml(fishId)})</option>\`;
        })
        .join("");
      return \`
        <div class="bonus-row wide">
          <div class="fields">
            <label>Event Type<select data-bonus-index="\${bonusIndex}" data-bonus-key="type">
              \${["gold_multiplier", "exp_multiplier", "fish_chance", "fishing_speed"].map((type) => \`<option value="\${type}" \${bonus.type === type ? "selected" : ""}>\${type}</option>\`).join("")}
            </select></label>
            \${bonusField("Multiplier / Chance Boost", "value", bonus.value, bonusIndex, "number", "0.01")}
            \${bonus.type === "fish_chance" ? \`<label>Fish<select data-bonus-index="\${bonusIndex}" data-bonus-key="fishId"><option value="">All fish</option>\${fishOptions}</select><input placeholder="Search fish by typing here" list="\${fishDatalistId}" value="\${escapeHtml(bonus.fishId || "")}" data-bonus-index="\${bonusIndex}" data-bonus-key="fishId"></label><datalist id="\${fishDatalistId}">\${fishOptions}</datalist>\` : ""}
            <button class="danger" data-remove-bonus="\${bonusIndex}" type="button">Remove Bonus</button>
          </div>
        </div>\`;
    }

    function rarityRank(rarity) {
      const index = fishRarities.indexOf(String(rarity || ""));
      return index === -1 ? fishRarities.length : index;
    }

    function sortedFishEntries() {
      const query = normalizeSearch(state.fishSearch);
      return state.fish
        .map((item, index) => ({ item, index }))
        .filter(({ item }) => matchesSearch(item, query))
        .sort((a, b) => {
          if (state.fishSort === "rarity") {
            return rarityRank(a.item.rarity) - rarityRank(b.item.rarity)
              || String(a.item.name || "").localeCompare(String(b.item.name || ""));
          }
          return String(a.item.name || "").localeCompare(String(b.item.name || ""))
            || rarityRank(a.item.rarity) - rarityRank(b.item.rarity);
        });
    }

    function currentFishPage(entries) {
      const pageCount = Math.max(1, Math.ceil(entries.length / state.fishPageSize));
      state.fishPage = Math.min(Math.max(1, Number(state.fishPage || 1)), pageCount);
      const start = (state.fishPage - 1) * state.fishPageSize;
      return {
        entries: entries.slice(start, start + state.fishPageSize),
        pageCount,
        start,
        end: Math.min(entries.length, start + state.fishPageSize)
      };
    }

    function fishPagerTemplate(total, pageCount, start, end) {
      if (total <= state.fishPageSize) {
        return \`<div class="fish-pager small">Showing \${total} fish.</div>\`;
      }
      return \`
        <div class="fish-pager">
          <div class="small">Showing \${start + 1}-\${end} of \${total} fish.</div>
          <div class="button-row">
            <button data-fish-page="prev" type="button" \${state.fishPage <= 1 ? "disabled" : ""}>Previous</button>
            <span class="badge">Page \${state.fishPage} / \${pageCount}</span>
            <button data-fish-page="next" type="button" \${state.fishPage >= pageCount ? "disabled" : ""}>Next</button>
          </div>
        </div>\`;
    }

    function setFishPageForId(fishId) {
      const entries = sortedFishEntries();
      const index = entries.findIndex(({ item }) => String(item.id || "") === String(fishId || ""));
      if (index >= 0) {
        state.fishPage = Math.floor(index / state.fishPageSize) + 1;
      }
    }

    function selectedFishEntry() {
      return state.fish
        .map((item, index) => ({ item, index }))
        .find((entry) => String(entry.item.id || "") === state.selectedFishId)
        || null;
    }

    function fishTabTemplate() {
      const entries = sortedFishEntries();
      const page = currentFishPage(entries);
      if ((!state.selectedFishId || !page.entries.some(({ item }) => String(item.id || "") === state.selectedFishId)) && page.entries[0]) {
        state.selectedFishId = String(page.entries[0].item.id || "");
      }
      if (!entries.length) {
        state.selectedFishId = "";
      }
      const selected = selectedFishEntry();
      const cards = page.entries.length
        ? page.entries.map(({ item, index }) => fishGridCardTemplate(item, index)).join("")
        : '<div class="small">No fish yet.</div>';
      return \`
        \${infoPanelTemplate("fish", "Fish Data", "A fish is available when its Server ID is empty or matches the Discord server, and its Min Kg is not above the rod Max Kg. Catch chance uses Chance Weight plus Rod Luck times Luck Scale, then active fish_chance event multipliers. EXP is gained on catch. Sell Gold is used when selling fish.")}
        <div class="fish-layout">
          <article class="item">
            <div class="fish-toolbar">
              <input data-fish-search placeholder="Search fish name, ID, rarity, server" value="\${escapeHtml(state.fishSearch)}">
              <button data-add-item="fish">Add Fish</button>
              <button data-fish-sort="name" class="\${state.fishSort === "name" ? "primary" : ""}">Sort Name</button>
              <button data-fish-sort="rarity" class="\${state.fishSort === "rarity" ? "primary" : ""}">Sort Rarity</button>
              <button data-export-fish>Export JSON</button>
              <label class="file-picker"><span>Import JSON</span><input type="file" accept="application/json,.json" data-import-fish></label>
            </div>
            \${fishPagerTemplate(entries.length, page.pageCount, page.start, page.end)}
            <div class="fish-gallery">\${cards}</div>
          </article>
          <article class="item fish-detail">
            \${selected ? fishTemplate(selected.item, selected.index, iconSize(selected.item)) : '<div class="small">Click a fish to edit its full panel.</div>'}
          </article>
        </div>\`;
    }

    function fishGridCardTemplate(item, index) {
      const source = item.iconBase64 || item.iconUrl || "";
      const active = String(item.id || "") === state.selectedFishId;
      return \`
        <button class="fish-card \${active ? "active" : ""}" data-select-fish="\${escapeHtml(String(item.id || ""))}" data-index="\${index}">
          \${imageOrEmptyTemplate(source, "", "", "No image", imageMessageUrl(item, "icon"), item.name || item.id || "fish")}
          <span>\${escapeHtml(item.name || item.id || "Unnamed Fish")}</span>
        </button>\`;
    }

    function fishTemplate(item, index, size) {
      return \`
        <div class="topline">
          \${imageOrEmptyTemplate(item.iconBase64 || item.iconUrl || "", "preview", "", "No image", imageMessageUrl(item, "icon"), item.name || item.id || "fish")}
          <button class="danger" data-remove="\${index}">Remove</button>
        </div>
        <div class="fields">
          \${field("ID", "id", item.id, index)}
          \${field("Name", "name", item.name, index)}
          <label>Rarity<select data-index="\${index}" data-key="rarity">
            \${fishRarities.map((rarity) => \`<option \${item.rarity === rarity ? "selected" : ""}>\${rarity}</option>\`).join("")}
          </select></label>
          \${field("Chance Weight", "baseWeight", item.baseWeight, index, "number", "0.01")}
          \${field("Min Kg", "minWeight", item.minWeight, index, "number", "0.01")}
          \${field("Max Kg", "maxWeight", item.maxWeight, index, "number", "0.01")}
          \${field("Luck Scale", "luckScale", item.luckScale, index, "number", "0.01")}
          \${field("EXP", "exp", item.exp, index, "number", "1")}
          \${field("Sell Gold", "gold", item.gold, index, "number", "1")}
          \${field("Server ID", "serverId", item.serverId || "", index)}
          <label class="wide">Descriptions, one per line<textarea data-index="\${index}" data-key="description">\${escapeHtml(fishDescriptionsText(item))}</textarea></label>
          \${field("Icon URL Import", "iconUrl", item.iconUrl || "", index, "url")}
          \${iconField(index, size)}
        </div>\`;
    }

    function rodTemplate(item, index, size) {
      return \`
        <div class="topline">
          \${imageOrEmptyTemplate(item.iconBase64 || item.iconUrl || "", "preview", "", "No image", imageMessageUrl(item, "icon"), item.name || item.id || "rod")}
          <button class="danger" data-remove="\${index}">Remove</button>
        </div>
        <div class="fields">
          \${field("ID", "id", item.id, index)}
          \${field("Name", "name", item.name, index)}
          <label>Rarity<select data-index="\${index}" data-key="rarity">
            \${fishRarities.map((rarity) => \`<option \${item.rarity === rarity ? "selected" : ""}>\${rarity}</option>\`).join("")}
          </select></label>
          \${field("Price", "price", item.price, index, "number", "1")}
          \${field("Speed, Chats Needed", "speed", item.speed, index, "number", "1")}
          \${field("Luck", "luck", item.luck, index, "number", "1")}
          \${field("Max Kg", "maxWeight", item.maxWeight, index, "number", "0.01")}
          \${field("Accuracy", "accuracy", item.accuracy, index, "number", "1")}
          <label class="wide">Description<textarea data-index="\${index}" data-key="description">\${escapeHtml(item.description || "")}</textarea></label>
          <label class="wide">Bonuses JSON<textarea data-index="\${index}" data-key="bonuses">\${escapeHtml(JSON.stringify(item.bonuses || [], null, 2))}</textarea></label>
          \${field("Icon URL Import", "iconUrl", item.iconUrl || "", index, "url")}
          \${iconField(index, size)}
        </div>\`;
    }

    function fishDescriptionsText(item) {
      const descriptions = Array.isArray(item.descriptions) ? item.descriptions : [];
      return descriptions.length ? descriptions.join("\\n") : String(item.description || "");
    }

    function sortedRodEntries() {
      const query = normalizeSearch(state.rodSearch);
      return state.rods
        .map((item, index) => ({ item, index }))
        .filter(({ item }) => matchesSearch(item, query))
        .sort((a, b) => {
          if (state.rodSort === "rarity") {
            return rarityRank(a.item.rarity) - rarityRank(b.item.rarity)
              || String(a.item.name || "").localeCompare(String(b.item.name || ""));
          }
          if (["price", "speed", "luck", "maxWeight", "accuracy"].includes(state.rodSort)) {
            return Number(a.item[state.rodSort] || 0) - Number(b.item[state.rodSort] || 0)
              || String(a.item.name || "").localeCompare(String(b.item.name || ""));
          }
          return String(a.item.name || "").localeCompare(String(b.item.name || ""));
        });
    }

    function selectedRodEntry() {
      return state.rods
        .map((item, index) => ({ item, index }))
        .find((entry) => String(entry.item.id || "") === state.selectedRodId)
        || null;
    }

    function rodTabTemplate() {
      const entries = sortedRodEntries();
      if (!state.selectedRodId && entries[0]) {
        state.selectedRodId = String(entries[0].item.id || "");
      }
      const selected = selectedRodEntry();
      const cards = entries.length
        ? entries.map(({ item, index }) => rodGridCardTemplate(item, index)).join("")
        : '<div class="small">No rods yet.</div>';
      return \`
        \${infoPanelTemplate("rods", "Rod Data", "Speed is how many valid chat progress points are needed before a catch roll. Luck changes fish odds through each fish Luck Scale. Max Kg limits which fish can be caught and caps rolled catch weight. Accuracy is stored for rod balance/display. Price is used by the rod store.")}
        <div class="fish-layout">
          <article class="item">
            <div class="fish-toolbar">
              <input data-rod-search placeholder="Search rods name, ID, stats" value="\${escapeHtml(state.rodSearch)}">
              <button data-add-item="rods">Add Rod</button>
              <button data-rod-sort="name" class="\${state.rodSort === "name" ? "primary" : ""}">Sort Name</button>
              <button data-rod-sort="rarity" class="\${state.rodSort === "rarity" ? "primary" : ""}">Sort Rarity</button>
              <button data-rod-sort="price" class="\${state.rodSort === "price" ? "primary" : ""}">Sort Price</button>
              <button data-rod-sort="speed" class="\${state.rodSort === "speed" ? "primary" : ""}">Sort Speed</button>
              <button data-rod-sort="luck" class="\${state.rodSort === "luck" ? "primary" : ""}">Sort Luck</button>
              <button data-export-rods>Export JSON</button>
              <label class="file-picker"><span>Import JSON</span><input type="file" accept="application/json,.json" data-import-rods></label>
            </div>
            <div class="fish-gallery">\${cards}</div>
          </article>
          <article class="item fish-detail">
            \${selected ? rodTemplate(selected.item, selected.index, iconSize(selected.item)) : '<div class="small">Click a rod to edit its full panel.</div>'}
          </article>
        </div>\`;
    }

    function rodGridCardTemplate(item, index) {
      const source = item.iconBase64 || item.iconUrl || "";
      const active = String(item.id || "") === state.selectedRodId;
      return \`
        <button class="fish-card \${active ? "active" : ""}" data-select-rod="\${escapeHtml(String(item.id || ""))}" data-index="\${index}">
          \${imageOrEmptyTemplate(source, "", "", "No image", imageMessageUrl(item, "icon"), item.name || item.id || "rod")}
          <span>\${escapeHtml(item.name || item.id || "Unnamed Rod")}</span>
        </button>\`;
    }

    function sortedFishBagEntries() {
      const query = normalizeSearch(state.fishBagSearch);
      return state.fishBags
        .map((item, index) => ({ item, index }))
        .filter(({ item }) => matchesSearch(item, query))
        .sort((a, b) => {
          if (state.fishBagSort === "rarity") {
            return rarityRank(a.item.rarity) - rarityRank(b.item.rarity)
              || String(a.item.name || "").localeCompare(String(b.item.name || ""));
          }
          if (["price", "spaceKg"].includes(state.fishBagSort)) {
            return Number(a.item[state.fishBagSort] || 0) - Number(b.item[state.fishBagSort] || 0)
              || String(a.item.name || "").localeCompare(String(b.item.name || ""));
          }
          return String(a.item.name || "").localeCompare(String(b.item.name || ""));
        });
    }

    function selectedFishBagEntry() {
      return state.fishBags
        .map((item, index) => ({ item, index }))
        .find((entry) => String(entry.item.id || "") === state.selectedFishBagId)
        || null;
    }

    function fishBagTabTemplate() {
      const entries = sortedFishBagEntries();
      if (!state.selectedFishBagId && entries[0]) {
        state.selectedFishBagId = String(entries[0].item.id || "");
      }
      const selected = selectedFishBagEntry();
      const cards = entries.length
        ? entries.map(({ item, index }) => fishBagGridCardTemplate(item, index)).join("")
        : '<div class="small">No fish bags yet.</div>';
      return \`
        \${infoPanelTemplate("fishBags", "Fish Bag Data", "Capacity Kg is the bag capacity used in FishDuel. A player must buy and equip a fish bag before they can start or accept a duel. Bonuses are stored as JSON so rods and fish bags can gain contextual effects such as duel capacity, competition accuracy, or raid accuracy.")} 
        <div class="fish-layout">
          <article class="item">
            <div class="fish-toolbar">
              <input data-fish-bag-search placeholder="Search fish bags name, ID, stats" value="\${escapeHtml(state.fishBagSearch)}">
              <button data-add-item="fishBags">Add Fish Bag</button>
              <button data-fish-bag-sort="name" class="\${state.fishBagSort === "name" ? "primary" : ""}">Sort Name</button>
              <button data-fish-bag-sort="rarity" class="\${state.fishBagSort === "rarity" ? "primary" : ""}">Sort Rarity</button>
              <button data-fish-bag-sort="price" class="\${state.fishBagSort === "price" ? "primary" : ""}">Sort Price</button>
              <button data-fish-bag-sort="spaceKg" class="\${state.fishBagSort === "spaceKg" ? "primary" : ""}">Sort Capacity</button>
              <button data-export-fish-bags>Export JSON</button>
              <label class="file-picker"><span>Import JSON</span><input type="file" accept="application/json,.json" data-import-fish-bags></label>
            </div>
            <div class="fish-gallery">\${cards}</div>
          </article>
          <article class="item fish-detail">
            \${selected ? fishBagTemplate(selected.item, selected.index, iconSize(selected.item)) : '<div class="small">Click a fish bag to edit its full panel.</div>'}
          </article>
        </div>\`;
    }

    function fishBagGridCardTemplate(item, index) {
      const source = item.iconBase64 || item.iconUrl || "";
      const active = String(item.id || "") === state.selectedFishBagId;
      return \`
        <button class="fish-card \${active ? "active" : ""}" data-select-fish-bag="\${escapeHtml(String(item.id || ""))}" data-index="\${index}">
          \${imageOrEmptyTemplate(source, "", "", "No image", imageMessageUrl(item, "icon"), item.name || item.id || "fish-bag")}
          <span>\${escapeHtml(item.name || item.id || "Unnamed Fish Bag")}</span>
        </button>\`;
    }

    function fishBagTemplate(item, index, size) {
      return \`
        <div class="topline">
          \${imageOrEmptyTemplate(item.iconBase64 || item.iconUrl || "", "preview", "", "No image", imageMessageUrl(item, "icon"), item.name || item.id || "fish-bag")}
          <button class="danger" data-remove="\${index}">Remove</button>
        </div>
        <div class="fields">
          \${field("ID", "id", item.id, index)}
          \${field("Name", "name", item.name, index)}
          <label>Rarity<select data-index="\${index}" data-key="rarity">
            \${fishRarities.map((rarity) => \`<option \${item.rarity === rarity ? "selected" : ""}>\${rarity}</option>\`).join("")}
          </select></label>
          \${field("Price", "price", item.price, index, "number", "1")}
          \${field("Capacity Kg", "spaceKg", item.spaceKg, index, "number", "0.01")}
          <label class="wide">Description<textarea data-index="\${index}" data-key="description">\${escapeHtml(item.description || "")}</textarea></label>
          <label class="wide">Bonuses JSON<textarea data-index="\${index}" data-key="bonuses">\${escapeHtml(JSON.stringify(item.bonuses || [], null, 2))}</textarea></label>
          \${field("Icon URL Import", "iconUrl", item.iconUrl || "", index, "url")}
          \${iconField(index, size)}
        </div>\`;
    }

    function infoPanelTemplate(key, title, body) {
      const collapsed = state.infoCollapsed[key] === true;
      return \`
        <article class="item info-panel">
          <div class="topline">
            <strong>\${escapeHtml(title)}</strong>
            <button data-toggle-info="\${key}">\${collapsed ? "Show Info" : "Minimize"}</button>
          </div>
          \${collapsed ? "" : \`<div class="small">\${escapeHtml(body)}</div>\`}
        </article>\`;
    }

    function calcTableTemplate() {
      if (!state.calcRodId && state.rods[0]) state.calcRodId = state.rods[0].id;
      const rod = state.rods.find((entry) => entry.id === state.calcRodId) || state.rods[0];
      const rows = rod ? sortedCalcEntries(calculateFishChances(rod, state.calcServerId)).map((entry) => \`
        <tr>
          <td>\${escapeHtml(entry.fish.name || entry.fish.id || "")}</td>
          <td>\${escapeHtml(entry.fish.rarity || "")}</td>
          <td>\${escapeHtml(entry.available ? "Yes" : "No")}</td>
          <td>\${entry.available ? entry.chance.toFixed(2) + "%" : "-"}</td>
          <td>\${entry.weight.toFixed(2)}</td>
          <td>\${escapeHtml(entry.reason)}</td>
        </tr>\`).join("") : "";
      return \`
        <article class="item wide">
          <div class="topline"><strong>Calc Table</strong></div>
          <div class="fields">
            <label>Rod<select data-calc-rod>
              \${state.rods.map((item) => \`<option value="\${escapeHtml(item.id || "")}" \${rod?.id === item.id ? "selected" : ""}>\${escapeHtml(item.name || item.id || "")}</option>\`).join("")}
            </select></label>
            <label>Server ID<input data-calc-server placeholder="Empty means global fish only" value="\${escapeHtml(state.calcServerId)}"></label>
          </div>
          <div class="button-row">
            \${calcSortButton("fish", "Sort Fish")}
            \${calcSortButton("rarity", "Sort Rarity")}
            \${calcSortButton("available", "Sort Available")}
            \${calcSortButton("chance", "Sort Chance")}
            \${calcSortButton("weight", "Sort Weight")}
          </div>
          <table class="calc-table">
            <thead><tr><th>Fish</th><th>Rarity</th><th>Available</th><th>Chance</th><th>Weight</th><th>Reason</th></tr></thead>
            <tbody>\${rows || '<tr><td colspan="6">No rod or fish data yet.</td></tr>'}</tbody>
          </table>
        </article>\`;
    }

    function calcSortButton(sortKey, label) {
      return \`<button data-calc-sort="\${sortKey}" class="\${state.calcSort === sortKey ? "primary" : ""}">\${label}</button>\`;
    }

    function sortedCalcEntries(entries) {
      return [...entries].sort((a, b) => {
        if (state.calcSort === "fish") {
          return String(a.fish.name || a.fish.id || "").localeCompare(String(b.fish.name || b.fish.id || ""));
        }
        if (state.calcSort === "rarity") {
          return rarityRank(a.fish.rarity) - rarityRank(b.fish.rarity)
            || String(a.fish.name || "").localeCompare(String(b.fish.name || ""));
        }
        if (state.calcSort === "available") {
          return Number(b.available) - Number(a.available)
            || b.chance - a.chance
            || String(a.fish.name || "").localeCompare(String(b.fish.name || ""));
        }
        if (state.calcSort === "weight") {
          return b.weight - a.weight
            || String(a.fish.name || "").localeCompare(String(b.fish.name || ""));
        }
        return b.chance - a.chance
          || String(a.fish.name || "").localeCompare(String(b.fish.name || ""));
      });
    }

    function calculateFishChances(rod, serverId) {
      const rodMaxWeight = Number(rod.maxWeight || Infinity);
      const guildId = String(serverId || "").trim();
      const entries = state.fish.map((fish) => {
        const fishServerId = String(fish.serverId || "").trim();
        const serverOk = !fishServerId || (guildId && fishServerId === guildId);
        const weightOk = Number(fish.minWeight || 0) <= rodMaxWeight;
        const weight = Math.max(0.1, Number(fish.baseWeight || 0) + Number(rod.luck || 0) * Number(fish.luckScale || 0));
        return {
          fish,
          weight,
          available: serverOk && weightOk,
          reason: !serverOk ? \`Server: \${fishServerId}\` : !weightOk ? "Over rod Max Kg" : "Available"
        };
      });
      const total = entries.filter((entry) => entry.available).reduce((sum, entry) => sum + entry.weight, 0);
      return entries.map((entry) => ({ ...entry, chance: entry.available && total > 0 ? entry.weight / total * 100 : 0 }));
    }

    function normalizeSearch(value) {
      return String(value || "").trim().toLowerCase();
    }

    function matchesSearch(item, query) {
      if (!query) return true;
      return [item.id, item.name, item.rarity, item.serverId, item.price, item.speed, item.luck, item.maxWeight, item.accuracy]
        .some((value) => String(value ?? "").toLowerCase().includes(query));
    }

    function field(label, key, value, index, type = "text", step = "") {
      return \`<label>\${label}<input type="\${type}" step="\${step}" data-index="\${index}" data-key="\${key}" value="\${escapeHtml(String(value ?? ""))}"></label>\`;
    }

    function bonusField(label, key, value, bonusIndex, type = "text", step = "") {
      return \`<label>\${label}<input type="\${type}" step="\${step}" data-bonus-index="\${bonusIndex}" data-bonus-key="\${key}" value="\${escapeHtml(String(value ?? ""))}"></label>\`;
    }

    function iconField(index, size) {
      const warning = size > 8 ? " warning" : "";
      return \`<label class="wide">Icon<input type="file" accept="image/png,image/jpeg,image/gif,image/webp" data-icon="\${index}"></label>
      <div class="wide small\${warning}">Selected icon upload size: \${size} KB. The saved image URL will be stored with the item data.</div>\`;
    }

    function escapeHtml(value) {
      return value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
    }

    function exportFishJson() {
      exportItemsJson("fish", "trfishing-fish.json");
    }

    function exportRodsJson() {
      exportItemsJson("rods", "trfishing-rods.json");
    }

    function exportFishBagsJson() {
      exportItemsJson("fishBags", "trfishing-fish-bags.json");
    }

    function exportSettingsJson() {
      const blob = new Blob([JSON.stringify({ settings: state.settings || {} }, null, 2)], { type: "application/json" });
      const link = document.createElement("a");
      link.href = URL.createObjectURL(blob);
      link.download = "trfishing-settings.json";
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(link.href);
      setStatus("Exported settings.");
    }

    function downloadJson(payload, fileName, statusText) {
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
      const link = document.createElement("a");
      link.href = URL.createObjectURL(blob);
      link.download = fileName;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(link.href);
      setStatus(statusText);
    }

    function exportEventsJson() {
      downloadJson({ activeEvent: state.activeEvent || null, events: state.events || [] }, "trfishing-events.json", "Exported events.");
    }

    function exportRoutineMessagesJson() {
      downloadJson({ routineMessages: state.routineMessages || [] }, "trfishing-routine-messages.json", "Exported routine messages.");
    }

    function importSettingsJson(file) {
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        try {
          const parsed = JSON.parse(String(reader.result || ""));
          const importedSettings = parsed && typeof parsed === "object" && !Array.isArray(parsed)
            ? parsed.settings && typeof parsed.settings === "object" && !Array.isArray(parsed.settings) ? parsed.settings : parsed
            : null;
          if (!importedSettings) {
            throw new Error("JSON must be a settings object, or an object with a settings value.");
          }
          state.settings = { ...state.settings, ...importedSettings };
          state.selectedRaidBossId = state.settings.fishRaidBosses?.[0]?.id || "";
          setStatus("Imported settings JSON. Press Save to store changes.");
          render();
        } catch (error) {
          setStatus(error.message || "Could not import settings JSON.", true);
        }
      };
      reader.readAsText(file);
    }

    function mergeById(collection, importedItems) {
      let replaced = 0;
      let added = 0;
      for (const item of importedItems) {
        if (!item || typeof item !== "object" || !String(item.id || "").trim()) {
          continue;
        }
        const existingIndex = collection.findIndex((entry) => String(entry.id || "") === String(item.id || ""));
        if (existingIndex >= 0) {
          collection[existingIndex] = item;
          replaced += 1;
        } else {
          collection.push(item);
          added += 1;
        }
      }
      return { replaced, added };
    }

    function importEventsJson(file) {
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        try {
          const parsed = JSON.parse(String(reader.result || ""));
          const importedEvents = Array.isArray(parsed) ? parsed : Array.isArray(parsed.events) ? parsed.events : [];
          const importedActiveEvent = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed.activeEvent || null : null;
          if (!importedEvents.length && !importedActiveEvent) {
            throw new Error("JSON must be an event array, or an object with events and optional activeEvent.");
          }
          const result = mergeById(state.events, importedActiveEvent ? [importedActiveEvent, ...importedEvents] : importedEvents);
          if (importedActiveEvent?.id) {
            state.activeEvent = importedActiveEvent;
            state.lastAnnouncementChannelId = importedActiveEvent.announcementChannelId || state.lastAnnouncementChannelId;
          }
          setStatus("Imported events JSON. Replaced " + result.replaced + ", added " + result.added + ". Press Save to store changes.");
          render();
        } catch (error) {
          setStatus(error.message || "Could not import events JSON.", true);
        }
      };
      reader.readAsText(file);
    }

    function importRoutineMessagesJson(file) {
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        try {
          const parsed = JSON.parse(String(reader.result || ""));
          const importedRoutines = Array.isArray(parsed) ? parsed : Array.isArray(parsed.routineMessages) ? parsed.routineMessages : [];
          if (!importedRoutines.length) {
            throw new Error("JSON must be a routine message array, or an object with a routineMessages array.");
          }
          const result = mergeById(state.routineMessages, importedRoutines);
          setStatus("Imported routine messages JSON. Replaced " + result.replaced + ", added " + result.added + ". Press Save to store changes.");
          render();
        } catch (error) {
          setStatus(error.message || "Could not import routine messages JSON.", true);
        }
      };
      reader.readAsText(file);
    }

    function exportItemsJson(collectionName, fileName) {
      const items = state[collectionName] || [];
      downloadJson(items, fileName, "Exported " + items.length + " " + collectionName + ".");
    }

    function importFishJson(file) {
      importItemsJson(file, "fish", "fish");
    }

    function importRodsJson(file) {
      importItemsJson(file, "rods", "rods");
    }

    function importFishBagsJson(file) {
      importItemsJson(file, "fishBags", "fishBags");
    }

    function importItemsJson(file, collectionName, payloadKey) {
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        try {
          const parsed = JSON.parse(String(reader.result || ""));
          const importedItems = Array.isArray(parsed) ? parsed : Array.isArray(parsed[payloadKey]) ? parsed[payloadKey] : [];
          if (!importedItems.length) {
            throw new Error("JSON must be an array of " + payloadKey + ", or an object with a " + payloadKey + " array.");
          }
          let replaced = 0;
          let added = 0;
          for (const item of importedItems) {
            if (!item || typeof item !== "object" || !String(item.id || "").trim()) {
              continue;
            }
            const normalizedItem = { iconBase64: "", iconUrl: "", ...item, id: String(item.id || "").trim().toLowerCase().replace(/[^a-z0-9_]/g, "_") };
            const existingIndex = state[collectionName].findIndex((entry) => String(entry.id || "") === normalizedItem.id);
            if (existingIndex >= 0) {
              state[collectionName][existingIndex] = normalizedItem;
              replaced += 1;
            } else {
              state[collectionName].push(normalizedItem);
              added += 1;
            }
          }
          if (collectionName === "fish" && !state.selectedFishId && state.fish[0]) {
            state.selectedFishId = String(state.fish[0].id || "");
          }
          if (collectionName === "fish") {
            state.fishPage = 1;
          }
          if (collectionName === "rods" && !state.selectedRodId && state.rods[0]) {
            state.selectedRodId = String(state.rods[0].id || "");
          }
          if (collectionName === "fishBags" && !state.selectedFishBagId && state.fishBags[0]) {
            state.selectedFishBagId = String(state.fishBags[0].id || "");
          }
          setStatus("Imported " + payloadKey + " JSON. Replaced " + replaced + ", added " + added + ". Press Save to store changes.");
          render();
        } catch (error) {
          setStatus(error.message || "Could not import JSON.", true);
        }
      };
      reader.readAsText(file);
    }

    function applyTabPayload(tab, payload) {
      if (Array.isArray(payload.fish)) state.fish = payload.fish;
      if (Array.isArray(payload.rods)) state.rods = payload.rods;
      if (Array.isArray(payload.fishBags)) state.fishBags = payload.fishBags;
      if (Array.isArray(payload.adminDiscordIds)) state.adminDiscordIds = payload.adminDiscordIds;
      if (payload.settings) state.settings = payload.settings;
      if (tab === "event") {
        state.activeEvent = payload.activeEvent || null;
        state.events = Array.isArray(payload.events) ? payload.events : [];
        state.eventDraft = null;
      }
      if (tab === "routine") {
        state.routineMessages = Array.isArray(payload.routineMessages) ? payload.routineMessages : [];
        state.routineDraft = null;
      }
      state.selectedFishId = state.fish.some((item) => item.id === state.selectedFishId) ? state.selectedFishId : state.fish[0]?.id || "";
      state.selectedRodId = state.rods.some((item) => item.id === state.selectedRodId) ? state.selectedRodId : state.rods[0]?.id || "";
      state.selectedFishBagId = state.fishBags.some((item) => item.id === state.selectedFishBagId) ? state.selectedFishBagId : state.fishBags[0]?.id || "";
      state.selectedRaidBossId = state.settings.fishRaidBosses?.some((boss) => boss.id === state.selectedRaidBossId) ? state.selectedRaidBossId : state.settings.fishRaidBosses?.[0]?.id || "";
      state.calcRodId = state.rods.some((rod) => rod.id === state.calcRodId) ? state.calcRodId : state.rods[0]?.id || "";
      state.lastAnnouncementChannelId = state.activeEvent?.announcementChannelId || state.events[0]?.announcementChannelId || state.lastAnnouncementChannelId;
      if (state.lastAnnouncementChannelId) localStorage.setItem("trfishing:lastAnnouncementChannelId", state.lastAnnouncementChannelId);
    }

    async function loadData(tab = state.tab, force = true) {
      if (!force && state.loadedTabs[tab]) return;
      state.loadedTabs[tab] = false;
      updateTabToolbar();
      await runWithLoading("Loading " + tab + " data…", async () => {
        setStatus("Loading " + tab + " from PlayFab...");
        const response = await fetch("/api/data?tab=" + encodeURIComponent(tab));
        const payload = await response.json();
        if (!response.ok) throw new Error(payload.error || "Could not load this tab.");
        applyTabPayload(tab, payload);
        state.loadedTabs[tab] = true;
        if (tab === "players") await loadPlayers();
        setStatus("Loaded " + tab + " from PlayFab.");
        render();
      });
    }

    function currentTabPayload(tab) {
      if (tab === "fish") return { fish: state.fish };
      if (tab === "rods") return { rods: state.rods };
      if (tab === "fishBags") return { fishBags: state.fishBags };
      if (tab === "admin") return { adminDiscordIds: state.adminDiscordIds };
      if (tab === "settings") return { settings: state.settings };
      if (tab === "event") return { activeEvent: state.activeEvent, events: state.events };
      if (tab === "routine") return { routineMessages: state.routineMessages };
      throw new Error("This tab has no editable data.");
    }

    async function saveData(tab = state.tab) {
      if (!state.loadedTabs[tab]) throw new Error("This tab has not finished loading, so it cannot be saved.");
      const collection = tab === "fish" ? state.fish
        : tab === "rods" ? state.rods
          : tab === "fishBags" ? state.fishBags
            : tab === "admin" ? state.adminDiscordIds
              : tab === "event" ? state.events
                : tab === "routine" ? state.routineMessages
                  : null;
      if (Array.isArray(collection) && collection.length === 0 && !confirm("This will save an empty " + tab + " tab. Continue?")) return;
      await runWithLoading("Saving " + tab + " data…", async () => {
        setStatus("Saving only " + tab + " to PlayFab...");
        const response = await fetch("/api/data?tab=" + encodeURIComponent(tab), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(currentTabPayload(tab))
        });
        const payload = await response.json();
        if (!response.ok) throw new Error(payload.error || "Could not save this tab.");
        applyTabPayload(tab, payload);
        setStatus("Saved " + tab + ". No other tab was changed.");
        render();
      });
    }

    async function loadPlayers() {
      setStatus("Loading players from PlayFab...");
      const query = state.playerSearch ? \`?search=\${encodeURIComponent(state.playerSearch)}\` : "";
      const response = await fetch(\`/api/players\${query}\`);
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "Could not load players.");
      state.players = payload.players || [];
      if (!state.players.some((player) => player.playFabId === state.selectedPlayerId)) {
        state.selectedPlayerId = state.players[0]?.playFabId || "";
      }
      state.catchNotice = "";
      setStatus(\`Loaded \${state.players.length} players.\`);
      render();
    }

    function updateSelectedPlayer(record) {
      const index = state.players.findIndex((player) => player.playFabId === record.playFabId);
      if (index >= 0) {
        state.players[index] = record;
      } else {
        state.players.unshift(record);
      }
      state.selectedPlayerId = record.playFabId;
    }

    function mergeUpdatedPlayers(records) {
      const updates = new Map((Array.isArray(records) ? records : []).map((record) => [record.playFabId, record]));
      state.players = state.players.map((record) => updates.get(record.playFabId) || record);
      for (const record of updates.values()) {
        if (!state.players.some((existing) => existing.playFabId === record.playFabId)) state.players.push(record);
      }
    }

    async function readProgressResponse(response, onProgress) {
      const reader = response.body?.getReader?.();
      if (!reader) {
        const payload = await response.json();
        if (!response.ok || payload.type === "error") throw new Error(payload.error || "The operation failed.");
        return payload;
      }
      const decoder = new TextDecoder();
      let buffer = "";
      let completed = null;
      let lastEvent = null;
      const consumeLine = (line) => {
        if (!line.trim()) return;
        const event = JSON.parse(line);
        lastEvent = event;
        if (event.type === "error") throw new Error(event.error || "The operation failed.");
        if (event.type === "complete") completed = event;
        if (event.type === "progress") onProgress?.(event);
      };
      while (true) {
        const { value, done } = await reader.read();
        buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
        const lines = buffer.split("\\n");
        buffer = lines.pop() || "";
        for (const line of lines) consumeLine(line);
        if (done) break;
      }
      consumeLine(buffer);
      if (!response.ok) throw new Error(lastEvent?.error || "The operation failed.");
      if (!completed) throw new Error("The operation ended before completion was confirmed.");
      return completed;
    }

    function showOperationProgress(event) {
      document.querySelector("#loading-message").textContent = event.message || "Processing players…";
      if (Number.isFinite(Number(event.total))) setLoadingProgress(event.current || 0, event.total, event.message || "");
      else setLoadingProgress();
    }

    async function saveSelectedPlayer() {
      const selected = selectedPlayerRecord();
      if (!selected) return;
      setStatus("Saving player...");
      const response = await fetch("/api/player/save", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ playFabId: selected.playFabId, player: selected.player })
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "Could not save player.");
      updateSelectedPlayer(payload.player);
      setStatus("Player saved.");
      render();
    }

    async function resetSelectedPlayer() {
      const selected = selectedPlayerRecord();
      if (!selected || !confirm("Reset this player's fishing data?")) return;
      setStatus("Resetting player...");
      const response = await fetch("/api/player/reset", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ playFabId: selected.playFabId })
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "Could not reset player.");
      updateSelectedPlayer(payload.player);
      setStatus("Player data reset.");
      render();
    }

    async function refreshEntotForSelectedPlayer() {
      const selected = selectedPlayerRecord();
      if (!selected) return;
      await runWithLoading("Refreshing Fishentot cooldown…", async () => {
        setStatus("Refreshing Fishentot cooldown...");
        const response = await fetch("/api/player/refresh-entot", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ playFabId: selected.playFabId })
        });
        const payload = await response.json();
        if (!response.ok) throw new Error(payload.error || "Could not refresh Fishentot cooldown.");
        updateSelectedPlayer(payload.player);
        state.catchNotice = "Fishentot cooldown refreshed. The player can use /fishentot now.";
        setStatus("Fishentot cooldown refreshed.");
        render();
      });
    }

    async function refreshEntotForAllPlayers() {
      if (!confirm("Refresh the Fishentot cooldown for every PlayFab player?")) return;
      await runWithLoading("Refreshing Fishentot cooldowns…", async () => {
        setStatus("Refreshing Fishentot cooldowns for all players...");
        const response = await fetch("/api/players/refresh-entot", { method: "POST" });
        const payload = await readProgressResponse(response, showOperationProgress);
        mergeUpdatedPlayers(payload.players);
        state.catchNotice = \`Fishentot cooldown refreshed for \${payload.count || 0} players. Failed: \${payload.failedCount || 0}.\`;
        setStatus("Fishentot cooldown refresh finished.");
        render();
      });
    }

    async function deleteSelectedPlayer() {
      const selected = selectedPlayerRecord();
      if (!selected || !confirm("Delete this player account from the PlayFab title? This is queued by PlayFab and may take a few minutes.")) return;
      setStatus("Deleting player...");
      const response = await fetch("/api/player/delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ playFabId: selected.playFabId })
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "Could not delete player.");
      state.players = state.players.filter((player) => player.playFabId !== selected.playFabId);
      state.selectedPlayerId = state.players[0]?.playFabId || "";
      setStatus("Player delete requested.");
      render();
    }

    async function enforceFishingForSelectedPlayer() {
      const selected = selectedPlayerRecord();
      if (!selected) return;
      await runWithLoading("Enforcing fishing…", async () => {
        setStatus("Forcing a fishing catch...");
        const fishSelections = getEnforceFishSelections().map((selection) => ({
          fishId: String(selection.fishId || ""),
          quantity: Math.max(1, Math.min(99, Math.floor(Number(selection.quantity || 1))))
        }));
        const response = await fetch("/api/player/enforce-fishing", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ playFabId: selected.playFabId, player: selected.player, fishSelections })
        });
        const payload = await response.json();
        if (!response.ok) throw new Error(payload.error || "Could not enforce fishing.");
        updateSelectedPlayer(payload.player);
        const discordStatus = payload.messageQueued ? " Discord catch message queued." : " No last Discord channel is saved for this player yet.";
        const catches = Array.isArray(payload.catches) ? payload.catches : (payload.catch ? [payload.catch] : []);
        const catchSummary = catches.length === 1
          ? \`Caught \${catches[0].fish.name}, \${Number(catches[0].catchWeight || 0).toFixed(2)} kg, +\${catches[0].expGain} EXP, Luck Score \${catches[0].luckScore}\`
          : \`Caught \${catches.length} fish, +\${catches.reduce((sum, entry) => sum + Number(entry.expGain || 0), 0)} EXP total\`;
        state.catchNotice = \`\${catchSummary}. Progress reset.\${discordStatus}\`;
        state.enforceModalOpen = false;
        setStatus(payload.messageQueued ? "Fishing enforced and Discord message queued." : "Fishing enforced, but no Discord channel was saved.");
        render();
      });
    }

    async function enforceFishingForAllPlayers() {
      const fishSelections = getEnforceFishSelections("all").map((selection) => ({
        fishId: String(selection.fishId || ""),
        quantity: Math.max(1, Math.min(99, Math.floor(Number(selection.quantity || 1))))
      }));
      await runWithLoading("Enforcing fishing for targeted players…", async () => {
        setStatus("Forcing fishing catches for targeted players...");
        const response = await fetch("/api/players/enforce-fishing", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ guildId: state.enforceAllGuildId, fishSelections })
        });
        const payload = await readProgressResponse(response, showOperationProgress);
        mergeUpdatedPlayers(payload.players);
        state.enforceAllModalOpen = false;
        const excludedSummary = payload.excludedCount ? \` Excluded by server filter: \${payload.excludedCount}.\` : "";
        state.catchNotice = \`Enforced fishing for \${payload.count || 0} of \${payload.targetCount || 0} targeted players. Discord catch messages queued: \${payload.queuedCount || 0}. No saved channel: \${payload.noChannelCount || 0}. Failed: \${payload.failedCount || 0}.\${excludedSummary}\`;
        setStatus("Fishing enforcement finished.");
        render();
      });
    }

    async function giveMoneyToSelectedPlayer() {
      const selected = selectedPlayerRecord();
      if (!selected) return;
      const amount = Math.max(0, Math.floor(Number(state.giveMoneyAmount || 0)));
      if (amount <= 0) {
        setStatus("Enter a money amount greater than 0.", true);
        return;
      }
      setStatus("Giving money...");
      const response = await fetch("/api/player/give-money", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ playFabId: selected.playFabId, player: selected.player, amount })
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "Could not give money.");
      updateSelectedPlayer(payload.player);
      const discordStatus = payload.messageQueued ? " Discord message queued." : " No last Discord channel is saved for this player yet.";
      state.catchNotice = \`Gave \${payload.amount} Gold. Gold: \${payload.goldBefore} -> \${payload.goldAfter}.\${discordStatus}\`;
      setStatus(payload.messageQueued ? "Money given and Discord message queued." : "Money given, but no Discord channel was saved.");
      render();
    }

    async function loadFishRaidState() {
      setStatus("Loading fish raid state...");
      const response = await fetch("/api/fishraid/state");
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "Could not load fish raid state.");
      state.fishRaidState = payload.guilds || {};
      setStatus("Fish raid state loaded.");
      render();
    }

    async function resetFishRaidToday() {
      const guildId = String(state.fishRaidControlGuildId || "").trim();
      if (!guildId) {
        setStatus("Enter a Discord Server ID first.", true);
        return;
      }
      if (!confirm("Reset today's raid for this server? This clears today's boss progress and unlocks another raid.")) return;
      setStatus("Sending fish raid reset...");
      const response = await fetch("/api/fishraid/reset", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ guildId, channelId: state.fishRaidControlChannelId || "" })
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "Could not reset fish raid.");
      setStatus("Reset sent to bot.");
      await loadFishRaidState().catch(() => {});
    }

    async function forceClearFishRaid() {
      const guildId = String(state.fishRaidControlGuildId || "").trim();
      if (!guildId) {
        setStatus("Enter a Discord Server ID first.", true);
        return;
      }
      if (!confirm("Force clear today's raid quota and post the fulfilled message?")) return;
      setStatus("Sending fish raid force clear...");
      const response = await fetch("/api/fishraid/force-clear", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ guildId, channelId: state.fishRaidControlChannelId || "" })
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "Could not force clear fish raid.");
      setStatus("Force clear sent to bot.");
      await loadFishRaidState().catch(() => {});
    }

    async function resetFishRaidCooldown() {
      const guildId = String(state.fishRaidControlGuildId || "").trim();
      if (!guildId) {
        setStatus("Enter a Discord Server ID first.", true);
        return;
      }
      setStatus("Sending fish raid cooldown reset...");
      const response = await fetch("/api/fishraid/reset-cooldown", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ guildId, channelId: state.fishRaidControlChannelId || "" })
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "Could not reset fish raid cooldown.");
      setStatus("Cooldown reset sent to bot.");
      await loadFishRaidState().catch(() => {});
    }

    async function resetAllPlayers() {
      if (!confirm("Reset fishing data for every loaded PlayFab player?")) return;
      setStatus("Resetting all players...");
      const response = await fetch("/api/players/reset-all", { method: "POST" });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "Could not reset all players.");
      state.players = payload.players || [];
      state.selectedPlayerId = state.players[0]?.playFabId || "";
      setStatus(\`Reset \${payload.count || 0} players.\`);
      render();
    }

    async function deleteAllPlayers() {
      if (!confirm("Delete every loaded player from the PlayFab title? This is queued by PlayFab and may take a few minutes.")) return;
      setStatus("Deleting all players...");
      const response = await fetch("/api/players/delete-all", { method: "POST" });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "Could not delete all players.");
      state.players = [];
      state.selectedPlayerId = "";
      setStatus(\`Delete requested for \${payload.count || 0} players.\`);
      render();
    }

    function makeSelectedPlayerAdmin() {
      const selected = selectedPlayerRecord();
      const discordUserId = selected?.player?.discordUserId || selected?.discordUserId || "";
      if (!discordUserId) {
        setStatus("This player has no Discord ID saved yet.", true);
        return;
      }
      if (!state.adminDiscordIds.includes(discordUserId)) {
        state.adminDiscordIds.push(discordUserId);
      }
      setStatus("Admin added locally. Press Save to store Admin Control changes.");
      render();
    }

    async function deployEventData() {
      setStatus("Deploying event to PlayFab...");
      const eventState = getEvent();
      eventState.id = eventState.id || String(Date.now());
      if (eventState.announcementChannelId) {
        state.lastAnnouncementChannelId = eventState.announcementChannelId;
        localStorage.setItem("trfishing:lastAnnouncementChannelId", state.lastAnnouncementChannelId);
      }
      const response = await fetch("/api/event/deploy", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ activeEvent: eventState, events: state.events })
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "Could not deploy event.");
      state.activeEvent = payload.activeEvent || eventState;
      state.events = payload.events || [state.activeEvent, ...state.events.filter((event) => event.id !== state.activeEvent.id)];
      state.eventDraft = null;
      state.createModal = null;
      setStatus("Event deployed. The bot is being refreshed now.");
      render();
    }

    async function stopEvent(eventId) {
      setStatus("Stopping event...");
      const response = await fetch("/api/event/stop", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: eventId })
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "Could not stop event.");
      state.activeEvent = payload.activeEvent || null;
      state.events = payload.events || state.events;
      setStatus("Event stopped. The bot is being refreshed now.");
      render();
    }

    async function removeEvent(eventId) {
      setStatus("Removing event...");
      const response = await fetch("/api/event/remove", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: eventId })
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "Could not remove event.");
      state.activeEvent = payload.activeEvent || null;
      state.events = payload.events || state.events.filter((event) => event.id !== eventId);
      setStatus("Event removed.");
      render();
    }

    async function deployRoutineData() {
      setStatus("Deploying routine message to PlayFab...");
      const routine = getRoutine();
      routine.id = routine.id || String(Date.now());
      const response = await fetch("/api/routine/deploy", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ routineMessages: state.routineMessages, routineDraft: routine })
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "Could not deploy routine message.");
      state.routineMessages = payload.routineMessages || [routine, ...state.routineMessages.filter((entry) => entry.id !== routine.id)];
      state.routineDraft = null;
      state.createModal = null;
      delete state.uploadNames.routineBanner;
      setStatus("Routine message deployed. Fish bags and other tabs were not changed.");
      render();
    }

    async function removeRoutine(routineId) {
      setStatus("Removing routine message...");
      const response = await fetch("/api/routine/remove", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: routineId })
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "Could not remove routine message.");
      state.routineMessages = payload.routineMessages || state.routineMessages.filter((routine) => routine.id !== routineId);
      setStatus("Routine message removed.");
      render();
    }

    async function seedData() {
      const tab = state.tab;
      if (!seedableTabs.has(tab)) throw new Error("This tab does not have seed defaults.");
      if (!confirm("Replace only the " + tab + " data with defaults?")) return;
      await runWithLoading("Saving " + tab + " defaults…", async () => {
        setStatus("Saving " + tab + " defaults to PlayFab...");
        const response = await fetch("/api/seed?tab=" + encodeURIComponent(tab), { method: "POST" });
        const payload = await response.json();
        if (!response.ok) throw new Error(payload.error || "Could not seed this tab.");
        applyTabPayload(tab, payload);
        state.loadedTabs[tab] = true;
        state.fishPage = 1;
        setStatus("Defaults saved for " + tab + ". No other tab was changed.");
        render();
      });
    }

    document.querySelector("#load").addEventListener("click", () => loadData(state.tab, true).catch((error) => setStatus(error.message, true)));
    document.querySelector("#save").addEventListener("click", () => saveData().catch((error) => setStatus(error.message, true)));
    document.querySelector("#seed").addEventListener("click", () => seedData().catch((error) => setStatus(error.message, true)));
    document.querySelectorAll("[data-tab]").forEach((button) => {
      button.addEventListener("click", () => {
        state.tab = button.dataset.tab;
        render();
        loadData(state.tab, false).catch((error) => setStatus(error.message, true));
      });
    });
    grid.addEventListener("input", (event) => {
      const target = event.target;
      if (target.dataset.createItemKey) {
        const item = state.createItemDraft;
        if (!item) return;
        const key = target.dataset.createItemKey;
        if (key === "bonuses") {
          try {
            item.bonuses = JSON.parse(target.value);
            setStatus("");
          } catch {
            setStatus("That bonus JSON is not valid yet.", true);
          }
          return;
        }
        item[key] = target.type === "number" ? Number(target.value) : target.value;
        if (state.createItemType === "fish" && key === "description") {
          item.descriptions = String(target.value || "").split(/\\r?\\n/).map((description) => description.trim()).filter(Boolean);
        }
        if (key === "iconUrl") {
          item.iconBase64 = "";
          item.iconRef = null;
          item.iconNeedsRehost = true;
          delete state.uploadNames.createItemIcon;
        }
        return;
      }
      if (state.tab === "players") {
        if (target.dataset.playerSearch !== undefined) {
          state.playerSearch = target.value;
          return;
        }
        if (target.dataset.giveMoneyAmount !== undefined) {
          state.giveMoneyAmount = Number(target.value);
          return;
        }
        if (target.dataset.enforceAllGuild !== undefined) {
          state.enforceAllGuildId = target.value;
          return;
        }
        if (target.dataset.enforceFishIndex !== undefined) {
          const selection = getEnforceFishSelections(target.dataset.enforceScope)[Number(target.dataset.enforceFishIndex)];
          if (selection) selection.fishId = target.value;
          return;
        }
        if (target.dataset.enforceQuantityIndex !== undefined) {
          const selection = getEnforceFishSelections(target.dataset.enforceScope)[Number(target.dataset.enforceQuantityIndex)];
          if (selection) selection.quantity = Math.max(1, Math.min(99, Math.floor(Number(target.value || 1))));
          return;
        }
        const selected = selectedPlayerRecord();
        if (!selected) return;
        if (target.dataset.playerKey) {
            const numericKeys = new Set(["gold", "exp", "progress", "totalFishCaught", "fishCompWins", "voiceTotalMs", "dailyLastClaimedAt", "dailyStreak"]);
          selected.player[target.dataset.playerKey] = numericKeys.has(target.dataset.playerKey) ? Number(target.value) : target.value;
          return;
        }
        if (target.dataset.playerJson) {
          try {
            selected.player[target.dataset.playerJson] = JSON.parse(target.value);
            setStatus("");
          } catch {
            setStatus("That JSON field is not valid yet.", true);
          }
        }
        return;
      }
      if (state.tab === "admin") {
        if (!target.dataset.key) return;
        state.adminDiscordIds[Number(target.dataset.index)] = target.value;
        return;
      }
      if (state.tab === "settings") {
        if (target.dataset.fishraidControl) {
          if (target.dataset.fishraidControl === "guildId") {
            state.fishRaidControlGuildId = target.value;
            localStorage.setItem("trfishing:fishRaidControlGuildId", state.fishRaidControlGuildId);
          }
          if (target.dataset.fishraidControl === "channelId") {
            state.fishRaidControlChannelId = target.value;
            localStorage.setItem("trfishing:fishRaidControlChannelId", state.fishRaidControlChannelId);
          }
          return;
        }
        if (target.dataset.raidBossKey) {
          const boss = target.dataset.raidBossIndex === "draft"
            ? state.raidBossDraft
            : state.settings.fishRaidBosses?.[Number(target.dataset.raidBossIndex)];
          if (!boss) return;
          boss[target.dataset.raidBossKey] = target.type === "number" ? Number(target.value) : target.value;
          if (target.dataset.raidBossKey === "id") {
            if (target.dataset.raidBossIndex !== "draft") {
              state.selectedRaidBossId = boss.id;
            }
          }
          if (target.dataset.raidBossKey.endsWith("Url")) {
            boss[target.dataset.raidBossKey.replace(/Url$/, "Base64")] = "";
            boss[target.dataset.raidBossKey.replace(/Url$/, "Ref")] = null;
            boss[target.dataset.raidBossKey + "NeedsRehost"] = true;
            delete state.uploadNames[\`raidBoss:\${target.dataset.raidBossIndex}:\${target.dataset.raidBossKey.replace(/Url$/, "Base64")}\`];
          }
          return;
        }
        if (target.dataset.settingsJson) {
          try {
            state.settings[target.dataset.settingsJson] = JSON.parse(target.value);
            setStatus("");
          } catch {
            setStatus("That settings JSON field is not valid yet.", true);
          }
          return;
        }
        if (!target.dataset.key) return;
        state.settings[target.dataset.key] = target.type === "checkbox" ? target.checked : target.type === "number" ? Number(target.value) : target.value;
        if (target.dataset.key === "rodStoreImageUrl") {
          state.settings.rodStoreImageBase64 = "";
          state.settings.rodStoreImageRef = null;
          state.settings.rodStoreImageUrlNeedsRehost = true;
          delete state.uploadNames.rodStoreImageBase64;
        }
        if (target.dataset.key === "fishCompBannerUrl") {
          state.settings.fishCompBannerBase64 = "";
          state.settings.fishCompBannerRef = null;
          state.settings.fishCompBannerUrlNeedsRehost = true;
          delete state.uploadNames.fishCompBannerBase64;
        }
        if (target.dataset.key.endsWith("BannerUrl")) {
          state.settings[target.dataset.key.replace(/Url$/, "Base64")] = "";
          state.settings[target.dataset.key.replace(/Url$/, "Ref")] = null;
          state.settings[target.dataset.key + "NeedsRehost"] = true;
          delete state.uploadNames[target.dataset.key.replace(/Url$/, "Base64")];
        }
        return;
      }
      if (state.tab === "event") {
        if (target.dataset.bonusKey) {
          const bonus = getEvent().bonuses[Number(target.dataset.bonusIndex)];
          bonus[target.dataset.bonusKey] = target.type === "number" ? Number(target.value) : target.value;
          if (target.dataset.bonusKey === "type" && target.value !== "fish_chance") {
            bonus.fishId = "";
          }
          if (target.dataset.bonusKey === "type") {
            render();
          }
          return;
        }
        const key = target.dataset.eventKey || target.dataset.key;
        if (!key) return;
        const eventState = getEvent();
        eventState[key] = target.type === "number" ? Number(target.value) : target.value;
        if (key === "bannerUrl") {
          eventState.bannerBase64 = "";
          eventState.bannerRef = null;
          eventState.bannerUrlNeedsRehost = true;
          delete state.uploadNames.eventBanner;
        }
        return;
      }
      if (state.tab === "routine") {
        const routine = getRoutine();
        if (target.dataset.routineVariants !== undefined) {
          routine.messageVariants = parseRoutineVariantsText(target.value);
          return;
        }
        if (target.dataset.routineButtonKey) {
          const button = routine.buttons[Number(target.dataset.routineButtonIndex)];
          if (!button) return;
          button[target.dataset.routineButtonKey] = target.type === "number" ? Number(target.value) : target.value;
          return;
        }
        if (target.dataset.routineConditionKey) {
          routine.condition[target.dataset.routineConditionKey] = target.type === "number" ? Number(target.value) : target.value;
          if (target.dataset.routineConditionKey === "type") {
            render();
          }
          return;
        }
        if (target.dataset.routineBoolKey) {
          routine[target.dataset.routineBoolKey] = target.checked;
          return;
        }
        const key = target.dataset.routineKey || target.dataset.key;
        if (!key) return;
        routine[key] = target.type === "number" ? Number(target.value) : target.value;
        if (key === "bannerUrl") {
          routine.bannerBase64 = "";
          routine.bannerRef = null;
          routine.bannerUrlNeedsRehost = true;
          delete state.uploadNames.routineBanner;
        }
        return;
      }
      if (target.dataset.fishSearch !== undefined) {
        state.fishSearch = target.value;
        state.fishPage = 1;
        render({ preserveFocus: true });
        return;
      }
      if (target.dataset.rodSearch !== undefined) {
        state.rodSearch = target.value;
        render({ preserveFocus: true });
        return;
      }
      if (target.dataset.fishBagSearch !== undefined) {
        state.fishBagSearch = target.value;
        render({ preserveFocus: true });
        return;
      }
      if (target.dataset.calcRod !== undefined) {
        state.calcRodId = target.value;
        render();
        return;
      }
      if (target.dataset.calcServer !== undefined) {
        state.calcServerId = target.value;
        render();
        return;
      }
      if (!target.dataset.key) return;
      const itemIndex = Number(target.dataset.index);
      if (target.dataset.key === "bonuses") {
        try {
          updateItem(itemIndex, target.dataset.key, JSON.parse(target.value || "[]"));
          setStatus("Bonus JSON updated.");
        } catch (error) {
          setStatus("Bonus JSON is not valid yet: " + error.message, true);
        }
        return;
      }
      updateItem(itemIndex, target.dataset.key, target.type === "number" ? Number(target.value) : target.value);
      if (state.tab === "fish" && target.dataset.key === "description") {
        state.fish[itemIndex].descriptions = String(target.value || "").split(/\\r?\\n/).map((description) => description.trim()).filter(Boolean);
      }
      if (state.tab === "fish" && target.dataset.key === "id") {
        state.selectedFishId = state.fish[itemIndex]?.id || "";
      }
      if (state.tab === "rods" && target.dataset.key === "id") {
        state.selectedRodId = state.rods[itemIndex]?.id || "";
      }
      if (state.tab === "fishBags" && target.dataset.key === "id") {
        state.selectedFishBagId = state.fishBags[itemIndex]?.id || "";
      }
      if (target.dataset.key === "iconUrl") {
        const item = state[state.tab][Number(target.dataset.index)];
        item.iconBase64 = "";
        item.iconRef = null;
        item.iconNeedsRehost = true;
      }
    });
    grid.addEventListener("change", (event) => {
      const target = event.target;
      if (target.dataset.createItemIcon !== undefined) {
        const file = target.files[0];
        if (!file || !state.createItemDraft) return;
        const reader = new FileReader();
        reader.onload = () => {
          state.createItemDraft.iconBase64 = reader.result;
          state.createItemDraft.iconUrl = "";
          state.createItemDraft.iconRef = null;
          state.createItemDraft.iconNeedsRehost = false;
          state.uploadNames.createItemIcon = file.name;
          render();
        };
        reader.readAsDataURL(file);
        return;
      }
      if (target.dataset.importFish !== undefined) {
        importFishJson(target.files[0]);
        target.value = "";
        return;
      }
      if (target.dataset.importRods !== undefined) {
        importRodsJson(target.files[0]);
        target.value = "";
        return;
      }
      if (target.dataset.importFishBags !== undefined) {
        importFishBagsJson(target.files[0]);
        target.value = "";
        return;
      }
      if (target.dataset.importSettings !== undefined) {
        importSettingsJson(target.files[0]);
        target.value = "";
        return;
      }
      if (target.dataset.importEvents !== undefined) {
        importEventsJson(target.files[0]);
        target.value = "";
        return;
      }
      if (target.dataset.importRoutines !== undefined) {
        importRoutineMessagesJson(target.files[0]);
        target.value = "";
        return;
      }
      if (target.dataset.settingsImage) {
        const file = target.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = () => {
          state.settings[target.dataset.settingsImage] = reader.result;
          state.uploadNames[target.dataset.settingsImage] = file.name;
          if (target.dataset.settingsImage === "rodStoreImageBase64") {
            state.settings.rodStoreImageUrl = "";
            state.settings.rodStoreImageRef = null;
          }
          if (target.dataset.settingsImage === "fishCompBannerBase64") {
            state.settings.fishCompBannerUrl = "";
            state.settings.fishCompBannerRef = null;
          }
          if (target.dataset.settingsImage.endsWith("BannerBase64")) {
            state.settings[target.dataset.settingsImage.replace(/Base64$/, "Url")] = "";
            state.settings[target.dataset.settingsImage.replace(/Base64$/, "Ref")] = null;
          }
          render();
        };
        reader.readAsDataURL(file);
        return;
      }
      if (target.dataset.raidBossImage) {
        const file = target.files[0];
        if (!file) return;
        const bossIndex = target.dataset.raidBossIndex;
        const boss = bossIndex === "draft" ? state.raidBossDraft : state.settings.fishRaidBosses?.[Number(bossIndex)];
        if (!boss) return;
        const reader = new FileReader();
        reader.onload = () => {
          const key = target.dataset.raidBossImage;
          boss[key] = reader.result;
          boss[key.replace(/Base64$/, "Url")] = "";
          boss[key.replace(/Base64$/, "Ref")] = null;
          state.uploadNames[\`raidBoss:\${bossIndex}:\${key}\`] = file.name;
          render();
        };
        reader.readAsDataURL(file);
        return;
      }
      if (target.dataset.eventBanner !== undefined) {
        const file = target.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = () => {
          getEvent().bannerBase64 = reader.result;
          getEvent().bannerUrl = "";
          state.uploadNames.eventBanner = file.name;
          render();
        };
        reader.readAsDataURL(file);
        return;
      }
      if (target.dataset.routineBanner !== undefined) {
        const file = target.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = () => {
          getRoutine().bannerBase64 = reader.result;
          getRoutine().bannerUrl = "";
          getRoutine().bannerRef = null;
          state.uploadNames.routineBanner = file.name;
          render();
        };
        reader.readAsDataURL(file);
        return;
      }
      if (state.tab === "settings" && target.dataset.key && target.dataset.key.endsWith("Url")) {
        render();
        return;
      }
      if (state.tab === "event" && (target.dataset.eventKey === "bannerUrl" || target.dataset.key === "bannerUrl")) {
        render();
        return;
      }
      if (state.tab === "routine" && (target.dataset.routineKey === "bannerUrl" || target.dataset.key === "bannerUrl")) {
        render();
        return;
      }
      if (!target.dataset.icon) return;
      const file = target.files[0];
      if (!file) return;
      const collectionName = state.tab;
      const collection = state[collectionName];
      const selectedItem = collection[Number(target.dataset.icon)];
      const selectedId = String(selectedItem?.id || "");
      const reader = new FileReader();
      reader.onload = () => {
        const item = findCurrentItem(state[collectionName] || [], selectedId, selectedItem);
        if (!item) return;
        item.iconBase64 = reader.result;
        item.iconUrl = "";
        item.iconRef = null;
        item.iconNeedsRehost = false;
        render();
      };
      reader.readAsDataURL(file);
    });
    grid.addEventListener("click", (event) => {
      const settingsTabButton = event.target.closest("[data-settings-tab]");
      if (settingsTabButton) {
        state.settingsTab = settingsTabButton.dataset.settingsTab;
        render();
        return;
      }
      const selectRaidBossButton = event.target.closest("[data-select-raid-boss]");
      if (selectRaidBossButton) {
        state.selectedRaidBossId = selectRaidBossButton.dataset.selectRaidBoss;
        render();
        return;
      }
      const selectFishButton = event.target.closest("[data-select-fish]");
      if (selectFishButton) {
        state.selectedFishId = selectFishButton.dataset.selectFish;
        render();
        return;
      }
      const selectRodButton = event.target.closest("[data-select-rod]");
      if (selectRodButton) {
        state.selectedRodId = selectRodButton.dataset.selectRod;
        render();
        return;
      }
      const selectFishBagButton = event.target.closest("[data-select-fish-bag]");
      if (selectFishBagButton) {
        state.selectedFishBagId = selectFishBagButton.dataset.selectFishBag;
        render();
        return;
      }
      const toggleInfoButton = event.target.closest("[data-toggle-info]");
      if (toggleInfoButton) {
        const key = toggleInfoButton.dataset.toggleInfo;
        state.infoCollapsed[key] = !state.infoCollapsed[key];
        render();
        return;
      }
      const fishSortButton = event.target.closest("[data-fish-sort]");
      if (fishSortButton) {
        state.fishSort = fishSortButton.dataset.fishSort;
        state.fishPage = 1;
        render();
        return;
      }
      const fishPageButton = event.target.closest("[data-fish-page]");
      if (fishPageButton) {
        const entries = sortedFishEntries();
        const pageCount = Math.max(1, Math.ceil(entries.length / state.fishPageSize));
        state.fishPage += fishPageButton.dataset.fishPage === "next" ? 1 : -1;
        state.fishPage = Math.min(Math.max(1, state.fishPage), pageCount);
        render();
        return;
      }
      const rodSortButton = event.target.closest("[data-rod-sort]");
      if (rodSortButton) {
        state.rodSort = rodSortButton.dataset.rodSort;
        render();
        return;
      }
      const fishBagSortButton = event.target.closest("[data-fish-bag-sort]");
      if (fishBagSortButton) {
        state.fishBagSort = fishBagSortButton.dataset.fishBagSort;
        render();
        return;
      }
      const openEnforceFishingButton = event.target.closest("[data-open-enforce-fishing]");
      if (openEnforceFishingButton) {
        state.enforceModalOpen = true;
        getEnforceFishSelections();
        render();
        return;
      }
      const openEnforceAllFishingButton = event.target.closest("[data-open-enforce-all-fishing]");
      if (openEnforceAllFishingButton) {
        state.enforceAllModalOpen = true;
        getEnforceFishSelections("all");
        render();
        return;
      }
      const closeEnforceModalButton = event.target.closest("[data-close-enforce-modal]");
      if (closeEnforceModalButton) {
        state.enforceModalOpen = false;
        state.enforceAllModalOpen = false;
        render();
        return;
      }
      const addEnforceFishButton = event.target.closest("[data-add-enforce-fish]");
      if (addEnforceFishButton) {
        getEnforceFishSelections(addEnforceFishButton.dataset.enforceScope).push({ fishId: "", quantity: 1 });
        render();
        return;
      }
      const removeEnforceFishButton = event.target.closest("[data-remove-enforce-fish]");
      if (removeEnforceFishButton) {
        const selections = getEnforceFishSelections(removeEnforceFishButton.dataset.enforceScope);
        if (selections.length > 1) {
          selections.splice(Number(removeEnforceFishButton.dataset.removeEnforceFish), 1);
          render();
        }
        return;
      }
      const calcSortButton = event.target.closest("[data-calc-sort]");
      if (calcSortButton) {
        state.calcSort = calcSortButton.dataset.calcSort;
        render();
        return;
      }
      const addItemButton = event.target.closest("[data-add-item]");
      if (addItemButton) {
        openCreateItemModal(addItemButton.dataset.addItem);
        render();
        return;
      }
      if (event.target.closest("[data-save-created-item]")) {
        saveCreatedItem();
        render();
        return;
      }
      const closeCreateModalButton = event.target.closest("[data-close-create-modal]");
      if (closeCreateModalButton) {
        closeCreateModal();
        render();
        return;
      }
      if (event.target.closest("[data-add-admin]")) {
        state.adminDiscordIds.push("");
        render();
        return;
      }
      if (event.target.closest("[data-add-raid-boss]")) {
        state.raidBossDraft = makeEmptyRaidBoss();
        state.createModal = "raidBoss";
        render();
        return;
      }
      if (event.target.closest("[data-load-fishraid-state]")) {
        loadFishRaidState().catch((error) => setStatus(error.message, true));
        return;
      }
      if (event.target.closest("[data-reset-fishraid-today]")) {
        resetFishRaidToday().catch((error) => setStatus(error.message, true));
        return;
      }
      if (event.target.closest("[data-reset-fishraid-cooldown]")) {
        resetFishRaidCooldown().catch((error) => setStatus(error.message, true));
        return;
      }
      if (event.target.closest("[data-force-clear-fishraid]")) {
        forceClearFishRaid().catch((error) => setStatus(error.message, true));
        return;
      }
      if (event.target.closest("[data-create-event]")) {
        state.eventDraft = makeEmptyEvent();
        state.createModal = "event";
        render();
        return;
      }
      if (event.target.closest("[data-create-routine]")) {
        state.routineDraft = makeEmptyRoutine();
        state.createModal = "routine";
        render();
        return;
      }
      const editRoutineButton = event.target.closest("[data-edit-routine]");
      if (editRoutineButton) {
        const routine = state.routineMessages.find((entry) => entry.id === editRoutineButton.dataset.editRoutine);
        if (!routine) {
          setStatus("Routine message was not found.", true);
          return;
        }
        state.routineDraft = cloneRoutineForEdit(routine);
        state.createModal = "routine";
        delete state.uploadNames.routineBanner;
        setStatus("Editing routine message. Press Save Routine Message when done.");
        render();
        return;
      }
      if (event.target.closest("[data-export-fish]")) {
        exportFishJson();
        return;
      }
      if (event.target.closest("[data-export-rods]")) {
        exportRodsJson();
        return;
      }
      if (event.target.closest("[data-export-fish-bags]")) {
        exportFishBagsJson();
        return;
      }
      if (event.target.closest("[data-export-settings]")) {
        exportSettingsJson();
        return;
      }
      if (event.target.closest("[data-export-events]")) {
        exportEventsJson();
        return;
      }
      if (event.target.closest("[data-export-routines]")) {
        exportRoutineMessagesJson();
        return;
      }
      const selectPlayerButton = event.target.closest("[data-select-player]");
      if (selectPlayerButton) {
        state.selectedPlayerId = selectPlayerButton.dataset.selectPlayer;
        state.catchNotice = "";
        render();
        return;
      }
      if (event.target.closest("[data-load-players]") || event.target.closest("[data-search-players]")) {
        loadPlayers().catch((error) => setStatus(error.message, true));
        return;
      }
      if (event.target.closest("[data-save-player]")) {
        saveSelectedPlayer().catch((error) => setStatus(error.message, true));
        return;
      }
      if (event.target.closest("[data-reset-player]")) {
        resetSelectedPlayer().catch((error) => setStatus(error.message, true));
        return;
      }
      if (event.target.closest("[data-refresh-entot]")) {
        refreshEntotForSelectedPlayer().catch((error) => setStatus(error.message, true));
        return;
      }
      if (event.target.closest("[data-refresh-all-entot]")) {
        refreshEntotForAllPlayers().catch((error) => setStatus(error.message, true));
        return;
      }
      if (event.target.closest("[data-delete-player]")) {
        deleteSelectedPlayer().catch((error) => setStatus(error.message, true));
        return;
      }
      if (event.target.closest("[data-enforce-fishing]")) {
        enforceFishingForSelectedPlayer().catch((error) => setStatus(error.message, true));
        return;
      }
      if (event.target.closest("[data-enforce-all-fishing]")) {
        enforceFishingForAllPlayers().catch((error) => setStatus(error.message, true));
        return;
      }
      if (event.target.closest("[data-give-money]")) {
        giveMoneyToSelectedPlayer().catch((error) => setStatus(error.message, true));
        return;
      }
      if (event.target.closest("[data-make-admin]")) {
        makeSelectedPlayerAdmin();
        return;
      }
      if (event.target.closest("[data-reset-all-players]")) {
        resetAllPlayers().catch((error) => setStatus(error.message, true));
        return;
      }
      if (event.target.closest("[data-delete-all-players]")) {
        deleteAllPlayers().catch((error) => setStatus(error.message, true));
        return;
      }
      const settingsImageButton = event.target.closest("[data-clear-settings-image]");
      if (settingsImageButton) {
        state.settings[settingsImageButton.dataset.clearSettingsImage] = "";
        delete state.uploadNames[settingsImageButton.dataset.clearSettingsImage];
        if (settingsImageButton.dataset.clearSettingsImage === "rodStoreImageBase64") {
          state.settings.rodStoreImageUrl = "";
          state.settings.rodStoreImageRef = null;
        }
        if (settingsImageButton.dataset.clearSettingsImage === "fishCompBannerBase64") {
          state.settings.fishCompBannerUrl = "";
          state.settings.fishCompBannerRef = null;
        }
        if (settingsImageButton.dataset.clearSettingsImage.endsWith("BannerBase64")) {
          state.settings[settingsImageButton.dataset.clearSettingsImage.replace(/Base64$/, "Url")] = "";
          state.settings[settingsImageButton.dataset.clearSettingsImage.replace(/Base64$/, "Ref")] = null;
        }
        render();
        return;
      }
      const raidBossImageButton = event.target.closest("[data-clear-raid-boss-image]");
      if (raidBossImageButton) {
        const [indexText, base64Key] = raidBossImageButton.dataset.clearRaidBossImage.split(":");
        const boss = indexText === "draft" ? state.raidBossDraft : state.settings.fishRaidBosses?.[Number(indexText)];
        if (!boss || !base64Key) return;
        boss[base64Key] = "";
        boss[base64Key.replace(/Base64$/, "Url")] = "";
        boss[base64Key.replace(/Base64$/, "Ref")] = null;
        delete state.uploadNames[\`raidBoss:\${indexText}:\${base64Key}\`];
        render();
        return;
      }
      if (event.target.closest("[data-save-created-raid-boss]")) {
        if (!Array.isArray(state.settings.fishRaidBosses)) {
          state.settings.fishRaidBosses = [];
        }
        const boss = state.raidBossDraft;
        if (!boss) return;
        state.settings.fishRaidBosses.push(boss);
        state.selectedRaidBossId = boss.id;
        state.raidBossDraft = null;
        state.createModal = null;
        setStatus("New raid boss added locally. Press Save to store changes.");
        render();
        return;
      }
      const removeRaidBossButton = event.target.closest("[data-remove-raid-boss]");
      if (removeRaidBossButton) {
        if (!confirm("Remove this raid boss?")) return;
        state.settings.fishRaidBosses.splice(Number(removeRaidBossButton.dataset.removeRaidBoss), 1);
        state.selectedRaidBossId = state.settings.fishRaidBosses[0]?.id || "";
        render();
        return;
      }
      if (event.target.closest("[data-clear-event]")) {
        state.eventDraft = null;
        state.createModal = null;
        delete state.uploadNames.eventBanner;
        render();
        return;
      }
      if (event.target.closest("[data-clear-event-banner]")) {
        getEvent().bannerBase64 = "";
        getEvent().bannerUrl = "";
        delete state.uploadNames.eventBanner;
        render();
        return;
      }
      if (event.target.closest("[data-clear-routine]")) {
        state.routineDraft = null;
        state.createModal = null;
        delete state.uploadNames.routineBanner;
        render();
        return;
      }
      if (event.target.closest("[data-clear-routine-banner]")) {
        getRoutine().bannerBase64 = "";
        getRoutine().bannerUrl = "";
        getRoutine().bannerRef = null;
        delete state.uploadNames.routineBanner;
        render();
        return;
      }
      const stopEventButton = event.target.closest("[data-stop-event]");
      if (stopEventButton) {
        runWithLoading("Stopping event…", () => stopEvent(stopEventButton.dataset.stopEvent)).catch((error) => setStatus(error.message, true));
        return;
      }
      const removeEventButton = event.target.closest("[data-remove-event]");
      if (removeEventButton) {
        if (!confirm("Remove this event from the manager?")) return;
        runWithLoading("Removing event…", () => removeEvent(removeEventButton.dataset.removeEvent)).catch((error) => setStatus(error.message, true));
        return;
      }
      if (event.target.closest("[data-add-bonus]")) {
        getEvent().bonuses.push({ type: "gold_multiplier", value: 2, fishId: "" });
        render();
        return;
      }
      const removeBonusButton = event.target.closest("[data-remove-bonus]");
      if (removeBonusButton) {
        const bonuses = getEvent().bonuses;
        bonuses.splice(Number(removeBonusButton.dataset.removeBonus), 1);
        if (!bonuses.length) bonuses.push({ type: "gold_multiplier", value: 2, fishId: "" });
        render();
        return;
      }
      if (event.target.closest("[data-deploy-event]")) {
        runWithLoading("Deploying event…", deployEventData).catch((error) => setStatus(error.message, true));
        return;
      }
      if (event.target.closest("[data-add-routine-button]")) {
        getRoutine().buttons.push({ id: "button_" + Date.now(), label: "Start FishComp", action: "fishcomp", style: "Primary", regtimeMinutes: 5, durationTurns: 15 });
        render();
        return;
      }
      const removeRoutineButtonButton = event.target.closest("[data-remove-routine-button]");
      if (removeRoutineButtonButton) {
        getRoutine().buttons.splice(Number(removeRoutineButtonButton.dataset.removeRoutineButton), 1);
        render();
        return;
      }
      if (event.target.closest("[data-deploy-routine]")) {
        runWithLoading("Saving routine message…", deployRoutineData).catch((error) => setStatus(error.message, true));
        return;
      }
      const removeRoutineButton = event.target.closest("[data-remove-routine]");
      if (removeRoutineButton) {
        if (!confirm("Remove this routine message from the manager?")) return;
        runWithLoading("Removing routine message…", () => removeRoutine(removeRoutineButton.dataset.removeRoutine)).catch((error) => setStatus(error.message, true));
        return;
      }
      const button = event.target.closest("[data-remove]");
      if (!button) return;
      if (!confirm("Remove this item?")) return;
      if (state.tab === "admin") {
        state.adminDiscordIds.splice(Number(button.dataset.remove), 1);
      } else {
        const removed = state[state.tab].splice(Number(button.dataset.remove), 1)[0];
        if (state.tab === "fish" && String(removed?.id || "") === state.selectedFishId) {
          state.selectedFishId = state.fish[0]?.id || "";
        }
        if (state.tab === "rods" && String(removed?.id || "") === state.selectedRodId) {
          state.selectedRodId = state.rods[0]?.id || "";
        }
        if (state.tab === "fishBags" && String(removed?.id || "") === state.selectedFishBagId) {
          state.selectedFishBagId = state.fishBags[0]?.id || "";
        }
      }
      render();
    });

    render();
    loadData("fish", false).catch((error) => setStatus(error.message, true));
  </script>
</body>
</html>`;

const server = http.createServer((request, response) => {
  if (request.url?.startsWith("/api/")) {
    handleApi(request, response);
    return;
  }

  response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  response.end(html);
});

server.listen(port, () => {
  console.log(`TR Fishing Manager is running at http://localhost:${port}`);
});
