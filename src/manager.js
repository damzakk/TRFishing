require("dotenv").config();

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const {
  adminDeletePlayer,
  adminGetGameData,
  adminListPlayers,
  adminResetPlayerData,
  adminSaveGameData,
  adminSavePlayerData,
  makeDefaultPlayer
} = require("./playfab");
const { defaultFish, defaultRods } = require("./defaultData");

const port = Number(process.env.MANAGER_PORT || 3000);
const prefix = process.env.PREFIX || "!";
const runtimeDirectory = path.join(__dirname, "..", ".runtime");
const configSignalPath = path.join(runtimeDirectory, "config-refresh.json");
const enforcedFishingSignalPath = path.join(runtimeDirectory, "enforced-fishing.json");
const giveMoneySignalPath = path.join(runtimeDirectory, "give-money.json");
const defaultFishingChannelsPath = path.join(runtimeDirectory, "default-fishing-channels.json");
const fishRaidStatePath = path.join(runtimeDirectory, "fish-raid-state.json");
const fishRaidSignalPath = path.join(runtimeDirectory, "fish-raid-signal.json");

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, { "Content-Type": "application/json" });
  response.end(JSON.stringify(payload));
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

function cleanNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function formatFishLuckScore(luckScale) {
  return Math.max(0, Math.round((1 - Number(luckScale || 0)) * 5000));
}

function cleanPlayer(player) {
  const source = player && typeof player === "object" ? player : {};
  const starterRodId = defaultRods[0]?.id || "twig";
  const inventory = source.inventory && typeof source.inventory === "object" && !Array.isArray(source.inventory)
    ? Object.fromEntries(Object.entries(source.inventory).map(([fishId, quantity]) => [String(fishId), Math.max(0, Math.floor(cleanNumber(quantity, 0)))]))
    : {};
  const ownedRods = Array.isArray(source.ownedRods) && source.ownedRods.length
    ? source.ownedRods.map((rodId) => String(rodId || "").trim()).filter(Boolean)
    : [starterRodId];
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
    inventory,
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
    voiceExpRemainderMs: Math.max(0, cleanNumber(source.voiceExpRemainderMs, 0))
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
  const luckScore = formatFishLuckScore(caughtFish.luckScale);
  player.inventory[caughtFish.id] = (player.inventory[caughtFish.id] || 0) + 1;
  player.totalFishCaught = Math.max(0, Number(player.totalFishCaught || 0)) + 1;
  if (!player.heaviestFish || Number(catchWeight || 0) > Number(player.heaviestFish.weight || 0)) {
    player.heaviestFish = { fishId: caughtFish.id, name: caughtFish.name, weight: Number(catchWeight || 0) };
  }
  if (!player.luckiestFish || luckScore > Number(player.luckiestFish.score || 0)) {
    player.luckiestFish = { fishId: caughtFish.id, name: caughtFish.name, luckScale: Number(caughtFish.luckScale || 0), score: luckScore };
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
    iconRef: item.iconRef && typeof item.iconRef === "object" ? item.iconRef : null
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
  const fishGuideBannerUrl = String(source.fishGuideBannerUrl || "").trim();
  const fishHelpBannerUrl = String(source.fishHelpBannerUrl || "").trim();
  const sellFishBannerUrl = String(source.sellFishBannerUrl || "").trim();
  return {
    rodStoreImageBase64: String(source.rodStoreImageBase64 || ""),
    rodStoreImageUrl,
    rodStoreImageRef: source.rodStoreImageRef && typeof source.rodStoreImageRef === "object" ? source.rodStoreImageRef : null,
    fishCompBannerBase64: String(source.fishCompBannerBase64 || ""),
    fishCompBannerUrl,
    fishCompBannerRef: source.fishCompBannerRef && typeof source.fishCompBannerRef === "object" ? source.fishCompBannerRef : null,
    fishCompRegistrationBannerBase64: String(source.fishCompRegistrationBannerBase64 || ""),
    fishCompRegistrationBannerUrl,
    fishCompRegistrationBannerRef: source.fishCompRegistrationBannerRef && typeof source.fishCompRegistrationBannerRef === "object" ? source.fishCompRegistrationBannerRef : null,
    fishCompRunningBannerBase64: String(source.fishCompRunningBannerBase64 || ""),
    fishCompRunningBannerUrl,
    fishCompRunningBannerRef: source.fishCompRunningBannerRef && typeof source.fishCompRunningBannerRef === "object" ? source.fishCompRunningBannerRef : null,
    fishCompResultBannerBase64: String(source.fishCompResultBannerBase64 || ""),
    fishCompResultBannerUrl,
    fishCompResultBannerRef: source.fishCompResultBannerRef && typeof source.fishCompResultBannerRef === "object" ? source.fishCompResultBannerRef : null,
    fishRaidBannerBase64: String(source.fishRaidBannerBase64 || ""),
    fishRaidBannerUrl,
    fishRaidBannerRef: source.fishRaidBannerRef && typeof source.fishRaidBannerRef === "object" ? source.fishRaidBannerRef : null,
    fishRaidRegistrationBannerBase64: String(source.fishRaidRegistrationBannerBase64 || ""),
    fishRaidRegistrationBannerUrl,
    fishRaidRegistrationBannerRef: source.fishRaidRegistrationBannerRef && typeof source.fishRaidRegistrationBannerRef === "object" ? source.fishRaidRegistrationBannerRef : null,
    fishRaidRunningBannerBase64: String(source.fishRaidRunningBannerBase64 || ""),
    fishRaidRunningBannerUrl,
    fishRaidRunningBannerRef: source.fishRaidRunningBannerRef && typeof source.fishRaidRunningBannerRef === "object" ? source.fishRaidRunningBannerRef : null,
    fishRaidResultBannerBase64: String(source.fishRaidResultBannerBase64 || ""),
    fishRaidResultBannerUrl,
    fishRaidResultBannerRef: source.fishRaidResultBannerRef && typeof source.fishRaidResultBannerRef === "object" ? source.fishRaidResultBannerRef : null,
    fishGuideBannerBase64: String(source.fishGuideBannerBase64 || ""),
    fishGuideBannerUrl,
    fishGuideBannerRef: source.fishGuideBannerRef && typeof source.fishGuideBannerRef === "object" ? source.fishGuideBannerRef : null,
    fishHelpBannerBase64: String(source.fishHelpBannerBase64 || ""),
    fishHelpBannerUrl,
    fishHelpBannerRef: source.fishHelpBannerRef && typeof source.fishHelpBannerRef === "object" ? source.fishHelpBannerRef : null,
    sellFishBannerBase64: String(source.sellFishBannerBase64 || ""),
    sellFishBannerUrl,
    sellFishBannerRef: source.sellFishBannerRef && typeof source.sellFishBannerRef === "object" ? source.sellFishBannerRef : null,
    fishCompEvents: cleanFishCompEvents(source.fishCompEvents),
    fishRaidEvents: cleanFishCompEvents(source.fishRaidEvents),
    fishRaidBosses: cleanFishRaidBosses(source.fishRaidBosses),
    fishCompLogIntervalMs: Math.max(0, cleanNumber(source.fishCompLogIntervalMs, 2500)),
    fishCompExpReward: Math.max(0, cleanNumber(source.fishCompExpReward, 50)),
    fishCompGoldReward: Math.max(0, cleanNumber(source.fishCompGoldReward, 0)),
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
      runningBannerBase64: String(source.runningBannerBase64 || ""),
      runningBannerUrl: String(source.runningBannerUrl || "").trim(),
      resultBannerBase64: String(source.resultBannerBase64 || ""),
      resultBannerUrl: String(source.resultBannerUrl || "").trim(),
      fulfilledBannerBase64: String(source.fulfilledBannerBase64 || ""),
      fulfilledBannerUrl: String(source.fulfilledBannerUrl || "").trim(),
      failedBannerBase64: String(source.failedBannerBase64 || ""),
      failedBannerUrl: String(source.failedBannerUrl || "").trim()
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

function cleanData(data) {
  const events = cleanEvents(data.events, data.activeEvent);
  const fish = (Array.isArray(data.fish) ? data.fish : []).map((item) => cleanItem(item, "fish"));
  const rods = (Array.isArray(data.rods) ? data.rods : []).map((item) => cleanItem(item, "rod"));
  assertUniqueItemIds(fish, "fish");
  assertUniqueItemIds(rods, "rod");
  return {
    fish,
    rods,
    adminDiscordIds: [...new Set((Array.isArray(data.adminDiscordIds) ? data.adminDiscordIds : [])
      .map((id) => String(id || "").trim())
      .filter(Boolean))],
    settings: cleanSettings(data.settings),
    activeEvent: cleanEvent(data.activeEvent),
    events
  };
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

function signalFishRaid(payload) {
  fs.mkdirSync(runtimeDirectory, { recursive: true });
  fs.writeFileSync(fishRaidSignalPath, JSON.stringify({
    id: `${Date.now()}:${Math.random().toString(36).slice(2)}`,
    createdAt: new Date().toISOString(),
    ...payload
  }));
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

async function handleApi(request, response) {
  try {
    const requestUrl = new URL(request.url, `http://${request.headers.host || "localhost"}`);
    if (request.method === "GET" && request.url === "/api/data") {
      sendJson(response, 200, await adminGetGameData());
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
      const data = await adminGetGameData();
      const player = cleanPlayer(body.player);
      const catchResult = rollFishForManager(data, player, body.fishId);
      const gain = addManagerCatch(data, player, catchResult.fish, catchResult.catchWeight);
      const saved = await adminSavePlayerData(playFabId, player);
      const discordUserId = String(saved.player?.discordUserId || player.discordUserId || "").trim();
      const messageChannel = resolveFishingMessageChannel(player, saved.player);
      const channelId = messageChannel.channelId;
      if (discordUserId && channelId) {
        signalEnforcedFishing({
          discordUserId,
          guildId: messageChannel.guildId,
          channelId,
          fish: catchResult.fish,
          catchWeight: catchResult.catchWeight,
          expGain: gain.expGain,
          expBase: gain.expBase,
          expEventInfo: gain.expEventInfo
        });
      }
      sendJson(response, 200, {
        ok: true,
        messageQueued: Boolean(discordUserId && channelId),
        player: saved,
        catch: {
          fish: catchResult.fish,
          catchWeight: catchResult.catchWeight,
          expGain: gain.expGain,
          luckScore: gain.luckScore
        }
      });
      return;
    }

    if (request.method === "POST" && request.url === "/api/players/enforce-fishing") {
      const data = await adminGetGameData();
      const players = await adminListPlayers();
      const updatedPlayers = [];
      const catches = [];
      let queuedCount = 0;
      let skippedCount = 0;

      for (const record of players) {
        const player = cleanPlayer(record.player);
        try {
          const catchResult = rollFishForManager(data, player);
          const gain = addManagerCatch(data, player, catchResult.fish, catchResult.catchWeight);
          const saved = await adminSavePlayerData(record.playFabId, player);
          updatedPlayers.push(saved);
          const discordUserId = String(saved.player?.discordUserId || player.discordUserId || record.discordUserId || "").trim();
          const messageChannel = resolveFishingMessageChannel(player, saved.player);
          if (discordUserId && messageChannel.channelId) {
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
            queuedCount += 1;
          } else {
            skippedCount += 1;
          }
        } catch (error) {
          skippedCount += 1;
          console.error(`Could not enforce fishing for ${record.playFabId}:`, error);
        }
      }

      if (catches.length) {
        signalEnforcedFishing({ catches });
      }
      sendJson(response, 200, { ok: true, count: updatedPlayers.length, queuedCount, skippedCount, players: updatedPlayers });
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

    if (request.method === "POST" && request.url === "/api/data") {
      const data = cleanData(JSON.parse(await readBody(request)));
      const savedData = await adminSaveGameData(data);
      signalBotConfigRefresh();
      sendJson(response, 200, { ok: true, ...savedData });
      return;
    }

    if (request.method === "POST" && request.url === "/api/event/deploy") {
      const data = cleanData(JSON.parse(await readBody(request)));
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
      await adminSaveGameData(data);
      signalBotConfigRefresh();
      sendJson(response, 200, { ok: true, activeEvent: data.activeEvent, events: data.events });
      return;
    }

    if (request.method === "POST" && request.url === "/api/event/stop") {
      const body = JSON.parse(await readBody(request));
      const current = await adminGetGameData();
      const now = new Date().toISOString();
      const events = cleanEvents(current.events, current.activeEvent).map((event) => (
        event.id === String(body.id || "") ? { ...event, endsAt: now, stoppedAt: now } : event
      ));
      const activeEvent = events.find((event) => event.id === current.activeEvent?.id) || current.activeEvent || null;
      await adminSaveGameData({ ...current, events, activeEvent });
      signalBotConfigRefresh();
      sendJson(response, 200, { ok: true, activeEvent, events });
      return;
    }

    if (request.method === "POST" && request.url === "/api/event/remove") {
      const body = JSON.parse(await readBody(request));
      const current = await adminGetGameData();
      const eventId = String(body.id || "");
      const events = cleanEvents(current.events, current.activeEvent).filter((event) => event.id !== eventId);
      const activeEvent = current.activeEvent?.id === eventId ? null : current.activeEvent || null;
      await adminSaveGameData({ ...current, events, activeEvent });
      signalBotConfigRefresh();
      sendJson(response, 200, { ok: true, activeEvent, events });
      return;
    }

    if (request.method === "POST" && request.url === "/api/seed") {
      const current = await adminGetGameData();
      const adminDiscordIds = current.adminDiscordIds || [];
      const settings = current.settings || {};
      const activeEvent = current.activeEvent || null;
      const events = current.events || [];
      await adminSaveGameData({ fish: defaultFish, rods: defaultRods, adminDiscordIds, settings, activeEvent, events });
      signalBotConfigRefresh();
      sendJson(response, 200, { ok: true, fish: defaultFish, rods: defaultRods, adminDiscordIds, settings, activeEvent, events });
      return;
    }

    sendJson(response, 404, { error: "Not found" });
  } catch (error) {
    sendJson(response, 500, { error: error.message });
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
      max-width: 1180px;
      margin: 0 auto;
      padding: 20px;
    }
    .toolbar, .tabs {
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
      align-items: center;
    }
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
    .fish-layout {
      grid-column: 1 / -1;
      display: grid;
      grid-template-columns: minmax(280px, 1fr) minmax(320px, 520px);
      gap: 14px;
      align-items: start;
    }
    .fish-toolbar {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      align-items: center;
      margin-bottom: 12px;
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
      .fish-detail { position: static; }
      .image-grid { grid-template-columns: 1fr; }
      .calc-table { display: block; overflow-x: auto; }
    }
  </style>
</head>
<body>
  <header>
    <h1>TR Fishing Manager</h1>
    <div class="toolbar">
      <button id="load">Load</button>
      <button id="seed">Seed Defaults</button>
      <button class="primary" id="save">Save</button>
    </div>
  </header>
  <main>
    <p class="notice">Manage fish and rods here. Images are uploaded to the Discord storage channel on save. PlayFab stores game data and the saved image URLs.</p>
    <div class="tabs">
      <button class="active" data-tab="fish">Fish</button>
      <button data-tab="rods">Rods</button>
      <button data-tab="calc">Calc Table</button>
      <button data-tab="admin">Admin Control</button>
      <button data-tab="settings">Settings</button>
      <button data-tab="event">Event</button>
      <button data-tab="players">Player Management</button>
    </div>
    <p class="status" id="status"></p>
    <section class="grid" id="grid"></section>
  </main>
  <script>
    const state = {
      tab: "fish",
      settingsTab: "general",
      fish: [],
      rods: [],
      adminDiscordIds: [],
      settings: { rodStoreImageBase64: "", rodStoreImageUrl: "", fishCompBannerBase64: "", fishCompBannerUrl: "", fishCompRegistrationBannerBase64: "", fishCompRegistrationBannerUrl: "", fishCompRunningBannerBase64: "", fishCompRunningBannerUrl: "", fishCompResultBannerBase64: "", fishCompResultBannerUrl: "", fishRaidBannerBase64: "", fishRaidBannerUrl: "", fishRaidRegistrationBannerBase64: "", fishRaidRegistrationBannerUrl: "", fishRaidRunningBannerBase64: "", fishRaidRunningBannerUrl: "", fishRaidResultBannerBase64: "", fishRaidResultBannerUrl: "", fishGuideBannerBase64: "", fishGuideBannerUrl: "", fishHelpBannerBase64: "", fishHelpBannerUrl: "", sellFishBannerBase64: "", sellFishBannerUrl: "", fishCompEvents: [], fishRaidEvents: [], fishRaidBosses: [{ id: "big_order", name: "Big Fish Order", quotaKg: 100, description: "Pesanan ikan besar hari ini sudah menunggu.", registrationBannerBase64: "", registrationBannerUrl: "", runningBannerBase64: "", runningBannerUrl: "", resultBannerBase64: "", resultBannerUrl: "", fulfilledBannerBase64: "", fulfilledBannerUrl: "", failedBannerBase64: "", failedBannerUrl: "" }], fishCompLogIntervalMs: 2500, fishCompHistoryLogHours: 24, fishCompExpReward: 50, fishCompGoldReward: 0, fishRaidLogIntervalMs: 2500, fishRaidParticipantExpReward: 25, fishRaidParticipantGoldReward: 0, fishRaidMvpExpReward: 75, fishRaidMvpGoldReward: 0, fishRaidClearParticipantExpReward: 50, fishRaidClearParticipantGoldReward: 0, fishRaidClearMvpExpReward: 150, fishRaidClearMvpGoldReward: 0, allowActivity: true, chatCooldownMs: 20000, expMultiplier: 1, levelExpMultiplier: 1, voiceExpAmount: 1, voiceExpIntervalMinutes: 15 },
      activeEvent: null,
      events: [],
      eventDraft: null,
      selectedFishId: "",
      selectedRodId: "",
      fishSort: "name",
      rodSort: "name",
      fishSearch: "",
      rodSearch: "",
      calcRodId: "",
      calcServerId: "",
      calcSort: "chance",
      selectedRaidBossId: "big_order",
      fishRaidControlGuildId: localStorage.getItem("trfishing:fishRaidControlGuildId") || "",
      fishRaidControlChannelId: localStorage.getItem("trfishing:fishRaidControlChannelId") || "",
      fishRaidState: {},
      infoCollapsed: { fish: false, rods: false },
      lastAnnouncementChannelId: localStorage.getItem("trfishing:lastAnnouncementChannelId") || "",
      players: [],
      playerSearch: "",
      selectedPlayerId: "",
      enforceFishId: "",
      catchNotice: "",
      giveMoneyAmount: 0,
      uploadNames: {}
    };
    const grid = document.querySelector("#grid");
    const statusEl = document.querySelector("#status");
    const fishRarities = ["Common", "Uncommon", "Rare", "Epic", "Legendary", "Secret", "Mythic", "Divine", "Celestial", "Abyssal", "Transcendent"];

    function setStatus(message, isError = false) {
      statusEl.textContent = message;
      statusEl.style.color = isError ? "var(--danger)" : "var(--muted)";
    }

    function iconSize(item) {
      return item.iconBase64 ? Math.round(item.iconBase64.length / 1024) : 0;
    }

    function makeEmptyItem() {
      if (state.tab === "fish") {
        return { id: "new_fish_" + Date.now(), name: "New Fish", rarity: "Common", baseWeight: 10, minWeight: 1, maxWeight: 5, luckScale: 0, exp: 5, gold: 10, serverId: "", description: "", descriptions: [], iconBase64: "" };
      }
      if (state.tab === "admin") {
        return "";
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
      });
    }

    function render() {
      const scrollState = captureScrollState();
      document.querySelectorAll("[data-tab]").forEach((button) => {
        button.classList.toggle("active", button.dataset.tab === state.tab);
      });
      grid.innerHTML = "";

      if (state.tab === "players") {
        grid.innerHTML = playerManagementTemplate();
        restoreScrollState(scrollState);
        return;
      }

      if (state.tab === "admin") {
        grid.innerHTML = adminTabTemplate();
        restoreScrollState(scrollState);
        return;
      }

      if (state.tab === "settings") {
        const card = document.createElement("article");
        card.className = "item";
        card.innerHTML = settingsTemplate();
        grid.appendChild(card);
        restoreScrollState(scrollState);
        return;
      }

      if (state.tab === "event") {
        if (state.eventDraft) {
          const formCard = document.createElement("article");
          formCard.className = "item";
          formCard.innerHTML = eventTemplate();
          grid.appendChild(formCard);
        }
        const listCard = document.createElement("article");
        listCard.className = "item";
        listCard.innerHTML = eventListTemplate();
        grid.appendChild(listCard);
        restoreScrollState(scrollState);
        return;
      }

      if (state.tab === "fish") {
        grid.innerHTML = fishTabTemplate();
        restoreScrollState(scrollState);
        return;
      }

      if (state.tab === "rods") {
        grid.innerHTML = rodTabTemplate();
        restoreScrollState(scrollState);
        return;
      }

      if (state.tab === "calc") {
        grid.innerHTML = calcTableTemplate();
        restoreScrollState(scrollState);
        return;
      }
      restoreScrollState(scrollState);
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
              <button data-enforce-all-fishing>Enforce Fishing To All Player</button>
              <button class="danger" data-reset-all-players>Reset All Player Data</button>
              <button class="danger" data-delete-all-players>Delete All Players</button>
            </div>
            <div class="small">Delete is queued by PlayFab. Reset is immediate and keeps the account but clears fishing progress.</div>
            <div class="player-list">\${rows}</div>
          </article>
          <article class="item">
            \${selected ? playerPanelTemplate(selected) : '<div class="small">Select a player to manage their data.</div>'}
          </article>
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
          \${playerField("Progress", "progress", player.progress || 0, "number", "1")}
          \${playerField("Total Fish Caught", "totalFishCaught", player.totalFishCaught || 0, "number", "1")}
          \${playerField("FishComp Wins", "fishCompWins", player.fishCompWins || 0, "number", "1")}
          \${playerField("Last Fishing Channel ID", "lastFishingChannelId", player.lastFishingChannelId || "")}
          \${playerField("Last Fishing Server ID", "lastFishingGuildId", player.lastFishingGuildId || "")}
          \${playerField("Voice Total, ms", "voiceTotalMs", player.voiceTotalMs || 0, "number", "1000")}
          <label class="wide">Owned Rod IDs JSON<textarea data-player-json="ownedRods">\${escapeHtml(JSON.stringify(player.ownedRods || [], null, 2))}</textarea></label>
          <label class="wide">Inventory JSON<textarea data-player-json="inventory">\${escapeHtml(JSON.stringify(player.inventory || {}, null, 2))}</textarea></label>
          <label class="wide">Heaviest Fish JSON<textarea data-player-json="heaviestFish">\${escapeHtml(JSON.stringify(player.heaviestFish || null, null, 2))}</textarea></label>
          <label class="wide">Luckiest Fish JSON<textarea data-player-json="luckiestFish">\${escapeHtml(JSON.stringify(player.luckiestFish || null, null, 2))}</textarea></label>
          <div class="wide button-row">
            <label>Give Money Amount<input type="number" step="1" min="1" data-give-money-amount value="\${escapeHtml(String(state.giveMoneyAmount || ""))}"></label>
            <button data-give-money>Give Money</button>
          </div>
          <div class="wide button-row">
            <button class="primary" data-save-player>Save Player</button>
            <label>Fish<select data-enforce-fish>
              <option value="">Random</option>
              \${state.fish.map((fish) => \`<option value="\${escapeHtml(String(fish.id || ""))}" \${state.enforceFishId === String(fish.id || "") ? "selected" : ""}>\${escapeHtml(fish.name || fish.id || "Unnamed Fish")}</option>\`).join("")}
            </select></label>
            <button data-enforce-fishing>Enforce Fishing</button>
            <button data-make-admin>Make Admin</button>
            <button class="danger" data-reset-player>Reset Player Data</button>
            <button class="danger" data-delete-player>Delete Player</button>
          </div>
        </div>\`;
    }

    function playerField(label, key, value, type = "text", step = "") {
      return \`<label>\${label}<input type="\${type}" step="\${step}" data-player-key="\${key}" value="\${escapeHtml(String(value ?? ""))}"></label>\`;
    }

    function settingsTemplate() {
      const tabs = \`
        <div class="tabs wide">
          <button class="\${state.settingsTab === "general" ? "active" : ""}" data-settings-tab="general" type="button">General</button>
          <button class="\${state.settingsTab === "fishcomp" ? "active" : ""}" data-settings-tab="fishcomp" type="button">FishComp</button>
          <button class="\${state.settingsTab === "fishraid" ? "active" : ""}" data-settings-tab="fishraid" type="button">FishRaid</button>
        </div>\`;
      const body = {
        general: settingsGeneralTemplate,
        fishcomp: settingsFishCompTemplate,
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

    function settingsFishRaidTemplate() {
      return \`
        <div class="fields">
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
          \${fishRaidBossGridTemplate()}
          <label class="wide">Raid Events JSON<textarea data-settings-json="fishRaidEvents">\${escapeHtml(JSON.stringify(state.settings.fishRaidEvents || [], null, 2))}</textarea></label>
          <div class="wide small">Raid events use the same format as Fish Comp Events, but only affect FishRaid turns.</div>
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
        <div class="fish-layout wide">
          <article class="item">
            <div class="fish-toolbar">
              <strong>Raid Bosses</strong>
              <button data-add-raid-boss type="button">Add Boss</button>
            </div>
            <div class="fish-gallery">\${cards}</div>
          </article>
          <article class="item fish-detail">
            \${selected ? fishRaidBossDetailTemplate(selected.boss, selected.index) : '<div class="small">Click a raid boss to edit it.</div>'}
          </article>
        </div>\`;
    }

    function fishRaidBossCardTemplate(boss, index) {
      const source = boss.registrationBannerBase64 || boss.registrationBannerUrl || boss.runningBannerBase64 || boss.runningBannerUrl || "";
      const active = String(boss.id || "") === state.selectedRaidBossId;
      return \`
        <button class="fish-card \${active ? "active" : ""}" data-select-raid-boss="\${escapeHtml(String(boss.id || ""))}" data-index="\${index}">
          \${source ? \`<img alt="" src="\${source}">\` : \`<div class="empty-preview">No image</div>\`}
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
            \${source ? \`<img class="image-preview" alt="\${label} preview" src="\${source}">\` : \`<div class="empty-preview">No preview</div>\`}
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
            \${source ? \`<img class="image-preview" alt="\${label} preview" src="\${source}">\` : \`<div class="empty-preview">No preview</div>\`}
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
            <div class="small">Start: \${escapeHtml(start)} · End: \${escapeHtml(end)}</div>
            <div class="small">Announcement Channel: \${escapeHtml(event.announcementChannelId || "-")} · Server: \${escapeHtml(event.guildId || "resolved by bot after announce")}</div>
            \${canStop ? \`<button class="danger" data-stop-event="\${escapeHtml(event.id)}">\${running ? "Stop Event" : "Cancel Event"}</button>\` : \`<button class="danger" data-remove-event="\${escapeHtml(event.id)}">Remove</button>\`}
          </div>\`;
      }).join("") : \`<div class="small">No events yet.</div>\`;
      return \`
        <div class="topline">
          <strong>Events</strong>
          <button data-create-event type="button">Create New Event</button>
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
          <label class="wide">Description<textarea data-event-key="description">\${escapeHtml(event.description || "")}</textarea></label>
          <div class="image-grid">
            <section class="image-panel">
              <strong>Event Banner</strong>
              \${bannerSource ? \`<img class="image-preview" alt="Event banner preview" src="\${bannerSource}">\` : \`<div class="empty-preview">No preview</div>\`}
              \${field("Banner Image URL Import", "bannerUrl", event.bannerUrl || "", 0, "url")}
              <label class="file-picker"><span>Choose Image</span><input type="file" accept="image/png,image/jpeg,image/gif,image/webp" data-event-banner></label>
              <div class="small">\${escapeHtml(bannerStatus)} File uploads are moved to the Discord storage channel when saved.</div>
              <button class="danger" data-clear-event-banner>Clear Event Banner</button>
            </section>
          </div>
          <button class="primary" data-deploy-event>Deploy Event</button>
        </div>\`;
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

    function selectedFishEntry() {
      return state.fish
        .map((item, index) => ({ item, index }))
        .find((entry) => String(entry.item.id || "") === state.selectedFishId)
        || null;
    }

    function fishTabTemplate() {
      const entries = sortedFishEntries();
      if (!state.selectedFishId && entries[0]) {
        state.selectedFishId = String(entries[0].item.id || "");
      }
      const selected = selectedFishEntry();
      const cards = entries.length
        ? entries.map(({ item, index }) => fishGridCardTemplate(item, index)).join("")
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
          \${source ? \`<img alt="" src="\${source}">\` : \`<div class="empty-preview">No image</div>\`}
          <span>\${escapeHtml(item.name || item.id || "Unnamed Fish")}</span>
        </button>\`;
    }

    function fishTemplate(item, index, size) {
      return \`
        <div class="topline">
          <img class="preview" alt="" src="\${item.iconBase64 || item.iconUrl || ""}">
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
          <img class="preview" alt="" src="\${item.iconBase64 || item.iconUrl || ""}">
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
          \${source ? \`<img alt="" src="\${source}">\` : \`<div class="empty-preview">No image</div>\`}
          <span>\${escapeHtml(item.name || item.id || "Unnamed Rod")}</span>
        </button>\`;
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

    function exportItemsJson(collectionName, fileName) {
      const items = state[collectionName] || [];
      const blob = new Blob([JSON.stringify(items, null, 2)], { type: "application/json" });
      const link = document.createElement("a");
      link.href = URL.createObjectURL(blob);
      link.download = fileName;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(link.href);
      setStatus("Exported " + items.length + " " + collectionName + ".");
    }

    function importFishJson(file) {
      importItemsJson(file, "fish", "fish");
    }

    function importRodsJson(file) {
      importItemsJson(file, "rods", "rods");
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
          if (collectionName === "rods" && !state.selectedRodId && state.rods[0]) {
            state.selectedRodId = String(state.rods[0].id || "");
          }
          setStatus("Imported " + payloadKey + " JSON. Replaced " + replaced + ", added " + added + ". Press Save to store changes.");
          render();
        } catch (error) {
          setStatus(error.message || "Could not import JSON.", true);
        }
      };
      reader.readAsText(file);
    }

    async function loadData() {
      setStatus("Loading from PlayFab...");
      const response = await fetch("/api/data");
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "Could not load data.");
      state.fish = payload.fish || [];
      state.rods = payload.rods || [];
      state.adminDiscordIds = payload.adminDiscordIds || [];
      state.settings = payload.settings || state.settings;
      state.activeEvent = payload.activeEvent || null;
      state.events = payload.events || (payload.activeEvent ? [payload.activeEvent] : []);
      state.eventDraft = null;
      state.selectedFishId = state.fish[0]?.id || "";
      state.selectedRodId = state.rods[0]?.id || "";
      state.selectedRaidBossId = state.settings.fishRaidBosses?.[0]?.id || "";
      state.calcRodId = state.rods[0]?.id || "";
      state.lastAnnouncementChannelId = state.activeEvent?.announcementChannelId || state.events[0]?.announcementChannelId || state.lastAnnouncementChannelId;
      if (state.lastAnnouncementChannelId) localStorage.setItem("trfishing:lastAnnouncementChannelId", state.lastAnnouncementChannelId);
      setStatus("Loaded from PlayFab.");
      render();
    }

    async function saveData() {
      setStatus("Saving to PlayFab...");
      const response = await fetch("/api/data", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fish: state.fish, rods: state.rods, adminDiscordIds: state.adminDiscordIds, settings: state.settings, activeEvent: state.activeEvent, events: state.events })
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "Could not save data.");
      state.fish = payload.fish || state.fish;
      state.rods = payload.rods || state.rods;
      state.adminDiscordIds = payload.adminDiscordIds || state.adminDiscordIds;
      state.settings = payload.settings || state.settings;
      state.activeEvent = payload.activeEvent || null;
      state.events = payload.events || (state.activeEvent ? [state.activeEvent] : state.events);
      setStatus("Saved. The bot will refresh automatically, or restart the bot to apply immediately.");
      render();
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
      setStatus("Forcing a fishing catch...");
      const response = await fetch("/api/player/enforce-fishing", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ playFabId: selected.playFabId, player: selected.player, fishId: state.enforceFishId || "" })
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "Could not enforce fishing.");
      updateSelectedPlayer(payload.player);
      const discordStatus = payload.messageQueued ? " Discord catch message queued." : " No last Discord channel is saved for this player yet.";
      state.catchNotice = \`Caught \${payload.catch.fish.name}, \${Number(payload.catch.catchWeight || 0).toFixed(2)} kg, +\${payload.catch.expGain} EXP, Luck Score \${payload.catch.luckScore}. Progress reset.\${discordStatus}\`;
      setStatus(payload.messageQueued ? "Fishing enforced and Discord message queued." : "Fishing enforced, but no Discord channel was saved.");
      render();
    }

    async function enforceFishingForAllPlayers() {
      if (!confirm("Enforce one fishing catch for every PlayFab player? Discord messages are queued immediately for players with a saved popup channel.")) return;
      setStatus("Forcing fishing catches for all players...");
      const response = await fetch("/api/players/enforce-fishing", { method: "POST" });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "Could not enforce fishing for all players.");
      state.players = payload.players || state.players;
      state.selectedPlayerId = state.players.some((player) => player.playFabId === state.selectedPlayerId) ? state.selectedPlayerId : state.players[0]?.playFabId || "";
      state.catchNotice = \`Enforced fishing for \${payload.count || 0} players. Discord catch messages queued: \${payload.queuedCount || 0}. Skipped/no channel: \${payload.skippedCount || 0}.\`;
      setStatus("Fishing enforced for all players.");
      render();
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
        body: JSON.stringify({ fish: state.fish, rods: state.rods, adminDiscordIds: state.adminDiscordIds, settings: state.settings, activeEvent: eventState, events: state.events })
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "Could not deploy event.");
      state.activeEvent = payload.activeEvent || eventState;
      state.events = payload.events || [state.activeEvent, ...state.events.filter((event) => event.id !== state.activeEvent.id)];
      state.eventDraft = null;
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

    async function seedData() {
      if (!confirm("Replace PlayFab item data with the default fish and rods?")) return;
      setStatus("Saving defaults to PlayFab...");
      const response = await fetch("/api/seed", { method: "POST" });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "Could not seed data.");
      state.fish = payload.fish || [];
      state.rods = payload.rods || [];
      state.adminDiscordIds = payload.adminDiscordIds || [];
      state.settings = payload.settings || state.settings;
      state.activeEvent = payload.activeEvent || null;
      state.events = payload.events || (payload.activeEvent ? [payload.activeEvent] : []);
      state.eventDraft = null;
      setStatus("Defaults saved to PlayFab.");
      render();
    }

    document.querySelector("#load").addEventListener("click", () => loadData().catch((error) => setStatus(error.message, true)));
    document.querySelector("#save").addEventListener("click", () => saveData().catch((error) => setStatus(error.message, true)));
    document.querySelector("#seed").addEventListener("click", () => seedData().catch((error) => setStatus(error.message, true)));
    document.querySelectorAll("[data-tab]").forEach((button) => {
      button.addEventListener("click", () => {
        state.tab = button.dataset.tab;
        render();
        if (state.tab === "players" && state.players.length === 0) {
          loadPlayers().catch((error) => setStatus(error.message, true));
        }
      });
    });
    grid.addEventListener("input", (event) => {
      const target = event.target;
      if (state.tab === "players") {
        if (target.dataset.playerSearch !== undefined) {
          state.playerSearch = target.value;
          return;
        }
        if (target.dataset.giveMoneyAmount !== undefined) {
          state.giveMoneyAmount = Number(target.value);
          return;
        }
        const selected = selectedPlayerRecord();
        if (!selected) return;
        if (target.dataset.playerKey) {
          const numericKeys = new Set(["gold", "exp", "progress", "totalFishCaught", "fishCompWins", "voiceTotalMs"]);
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
          const boss = state.settings.fishRaidBosses?.[Number(target.dataset.raidBossIndex)];
          if (!boss) return;
          boss[target.dataset.raidBossKey] = target.type === "number" ? Number(target.value) : target.value;
          if (target.dataset.raidBossKey === "id") {
            state.selectedRaidBossId = boss.id;
          }
          if (target.dataset.raidBossKey.endsWith("Url")) {
            boss[target.dataset.raidBossKey.replace(/Url$/, "Base64")] = "";
            boss[target.dataset.raidBossKey.replace(/Url$/, "Ref")] = null;
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
          delete state.uploadNames.rodStoreImageBase64;
        }
        if (target.dataset.key === "fishCompBannerUrl") {
          state.settings.fishCompBannerBase64 = "";
          state.settings.fishCompBannerRef = null;
          delete state.uploadNames.fishCompBannerBase64;
        }
        if (target.dataset.key.endsWith("BannerUrl")) {
          state.settings[target.dataset.key.replace(/Url$/, "Base64")] = "";
          state.settings[target.dataset.key.replace(/Url$/, "Ref")] = null;
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
          delete state.uploadNames.eventBanner;
        }
        return;
      }
      if (target.dataset.fishSearch !== undefined) {
        state.fishSearch = target.value;
        render();
        return;
      }
      if (target.dataset.rodSearch !== undefined) {
        state.rodSearch = target.value;
        render();
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
      updateItem(Number(target.dataset.index), target.dataset.key, target.type === "number" ? Number(target.value) : target.value);
      if (state.tab === "fish" && target.dataset.key === "description") {
        state.fish[itemIndex].descriptions = String(target.value || "").split(/\\r?\\n/).map((description) => description.trim()).filter(Boolean);
      }
      if (state.tab === "fish" && target.dataset.key === "id") {
        state.selectedFishId = state.fish[itemIndex]?.id || "";
      }
      if (state.tab === "rods" && target.dataset.key === "id") {
        state.selectedRodId = state.rods[itemIndex]?.id || "";
      }
      if (target.dataset.key === "iconUrl") {
        const item = state[state.tab][Number(target.dataset.index)];
        item.iconBase64 = "";
        item.iconRef = null;
      }
    });
    grid.addEventListener("change", (event) => {
      const target = event.target;
      if (target.dataset.enforceFish !== undefined) {
        state.enforceFishId = target.value;
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
      if (target.dataset.importSettings !== undefined) {
        importSettingsJson(target.files[0]);
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
        const bossIndex = Number(target.dataset.raidBossIndex);
        const boss = state.settings.fishRaidBosses?.[bossIndex];
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
      if (state.tab === "settings" && target.dataset.key && target.dataset.key.endsWith("Url")) {
        render();
        return;
      }
      if (state.tab === "event" && (target.dataset.eventKey === "bannerUrl" || target.dataset.key === "bannerUrl")) {
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
        render();
        return;
      }
      const rodSortButton = event.target.closest("[data-rod-sort]");
      if (rodSortButton) {
        state.rodSort = rodSortButton.dataset.rodSort;
        render();
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
        const collectionName = addItemButton.dataset.addItem;
        const previousTab = state.tab;
        state.tab = collectionName;
        const item = makeEmptyItem();
        state[collectionName].push(item);
        if (collectionName === "fish") {
          state.selectedFishId = item.id;
        }
        if (collectionName === "rods") {
          state.selectedRodId = item.id;
        }
        state.tab = previousTab;
        render();
        return;
      }
      if (event.target.closest("[data-add-admin]")) {
        state.adminDiscordIds.push("");
        render();
        return;
      }
      if (event.target.closest("[data-add-raid-boss]")) {
        if (!Array.isArray(state.settings.fishRaidBosses)) {
          state.settings.fishRaidBosses = [];
        }
        const boss = makeEmptyRaidBoss();
        state.settings.fishRaidBosses.push(boss);
        state.selectedRaidBossId = boss.id;
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
      if (event.target.closest("[data-export-settings]")) {
        exportSettingsJson();
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
        const bossIndex = Number(indexText);
        const boss = state.settings.fishRaidBosses?.[bossIndex];
        if (!boss || !base64Key) return;
        boss[base64Key] = "";
        boss[base64Key.replace(/Base64$/, "Url")] = "";
        boss[base64Key.replace(/Base64$/, "Ref")] = null;
        delete state.uploadNames[\`raidBoss:\${bossIndex}:\${base64Key}\`];
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
      const stopEventButton = event.target.closest("[data-stop-event]");
      if (stopEventButton) {
        stopEvent(stopEventButton.dataset.stopEvent).catch((error) => setStatus(error.message, true));
        return;
      }
      const removeEventButton = event.target.closest("[data-remove-event]");
      if (removeEventButton) {
        if (!confirm("Remove this event from the manager?")) return;
        removeEvent(removeEventButton.dataset.removeEvent).catch((error) => setStatus(error.message, true));
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
        deployEventData().catch((error) => setStatus(error.message, true));
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
      }
      render();
    });

    loadData().catch((error) => setStatus(error.message, true));
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
