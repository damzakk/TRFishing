require("dotenv").config();

const fs = require("node:fs");
const path = require("node:path");
const {
  ActionRowBuilder,
  ApplicationCommandOptionType,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  Client,
  ContainerBuilder,
  AttachmentBuilder,
  GatewayIntentBits,
  MediaGalleryBuilder,
  MediaGalleryItemBuilder,
  MessageFlags,
  Partials,
  EmbedBuilder,
  PermissionFlagsBits,
  SectionBuilder,
  SeparatorBuilder,
  StringSelectMenuBuilder,
  TextDisplayBuilder,
  ThumbnailBuilder
} = require("discord.js");
const {
  entersState,
  getVoiceConnection,
  joinVoiceChannel,
  VoiceConnectionStatus
} = require("@discordjs/voice");
const { adminListPlayers, adminSaveGameData, getGameData, getPlayer, savePlayer } = require("./playfab");
const { makeFishShowoffBanner } = require("./fishShowoffBanner");
const { makeIconAttachment, parseDataImage } = require("./imageUtils");

const token = process.env.DISCORD_TOKEN;
const prefix = process.env.PREFIX || "!";
const minMessageLength = 4;
const configRefreshMs = Number(process.env.CONFIG_REFRESH_MS || 30_000);
const maxEventAnnouncementTimeoutMs = 2_147_000_000;
const runtimeDirectory = path.join(__dirname, "..", ".runtime");
const configSignalPath = path.join(runtimeDirectory, "config-refresh.json");
const enforcedFishingSignalPath = path.join(runtimeDirectory, "enforced-fishing.json");
const giveMoneySignalPath = path.join(runtimeDirectory, "give-money.json");
const fishVoiceChannelsPath = path.join(runtimeDirectory, "fish-voice-channels.json");
const defaultFishingChannelsPath = path.join(runtimeDirectory, "default-fishing-channels.json");
const fishRaidStatePath = path.join(runtimeDirectory, "fish-raid-state.json");
const fishRaidSignalPath = path.join(runtimeDirectory, "fish-raid-signal.json");
const fishDuelPendingPath = path.join(runtimeDirectory, "fish-duel-pending.json");
const pendingMessageDeletesPath = path.join(runtimeDirectory, "pending-message-deletes.json");
const competitionHistoryPath = path.join(runtimeDirectory, "competition-history-logs.json");
const announcementStatePath = path.join(runtimeDirectory, "announcement-state.json");
const processStartedAt = Date.now();
const voiceTickMs = 60_000;
const fishDuelPendingTtlMs = 5 * 60_000;
const publicShowoffTtlMs = 30 * 60_000;
const fishDailyResetHour = 12;
const fishDailyWindowMs = 24 * 60 * 60 * 1000;

const rarityColors = {
  Common: 0x95a5a6,
  Uncommon: 0x2ecc71,
  Rare: 0x3498db,
  Epic: 0x9b59b6,
  Legendary: 0xf1c40f,
  Secret: 0xe84393,
  Mythic: 0xff6b6b,
  Divine: 0xffffff,
  Celestial: 0x7bdff2,
  Abyssal: 0x141922,
  Transcendent: 0xff9ff3
};

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.MessageContent
  ],
  partials: [Partials.Channel]
});

let gameData = {
  fish: [],
  rods: [],
  fishBags: [],
  adminDiscordIds: [],
  settings: {
    rodStoreImageBase64: "",
    rodStoreImageUrl: "",
    fishCompBannerBase64: "",
    fishCompBannerUrl: "",
    fishCompRegistrationBannerBase64: "",
    fishCompRegistrationBannerUrl: "",
    fishCompRunningBannerBase64: "",
    fishCompRunningBannerUrl: "",
    fishCompResultBannerBase64: "",
    fishCompResultBannerUrl: "",
    fishGuideBannerBase64: "",
    fishGuideBannerUrl: "",
    fishHelpBannerBase64: "",
    fishHelpBannerUrl: "",
    sellFishBannerBase64: "",
    sellFishBannerUrl: "",
    fishCompEvents: [],
    fishRaidRegistrationBannerBase64: "",
    fishRaidRegistrationBannerUrl: "",
    fishRaidRunningBannerBase64: "",
    fishRaidRunningBannerUrl: "",
    fishRaidResultBannerBase64: "",
    fishRaidResultBannerUrl: "",
    fishRaidBannerBase64: "",
    fishRaidBannerUrl: "",
    fishRaidEvents: [],
    fishRaidBosses: [],
    fishDuelRegistrationBannerBase64: "",
    fishDuelRegistrationBannerUrl: "",
    fishDuelRunningBannerBase64: "",
    fishDuelRunningBannerUrl: "",
    fishDuelResultBannerBase64: "",
    fishDuelResultBannerUrl: "",
    fishDuelEvents: [],
    fishDuelExpReward: 40,
    fishDuelLogIntervalMs: 2500,
    fishCompLogIntervalMs: 2500,
    fishCompHistoryLogHours: 24,
    fishCompExpReward: 50,
    fishCompGoldReward: 0,
    fishRaidLogIntervalMs: 2500,
    fishRaidCooldownMinutes: 60,
    fishRaidParticipantExpReward: 25,
    fishRaidParticipantGoldReward: 0,
    fishRaidMvpExpReward: 75,
    fishRaidMvpGoldReward: 0,
    fishRaidClearParticipantExpReward: 50,
    fishRaidClearParticipantGoldReward: 0,
    fishRaidClearMvpExpReward: 150,
    fishRaidClearMvpGoldReward: 0,
    allowActivity: true,
    chatCooldownMs: 20_000,
    expMultiplier: 1,
    levelExpMultiplier: 1,
    voiceExpAmount: 1,
    voiceExpIntervalMinutes: 15
  },
  activeEvent: null,
  events: [],
  routineMessages: []
};
const playerQueues = new Map();
const announcedEvents = new Set();
const announcedEndedEvents = new Set();
const competitions = new Map();
const fishRaids = new Map();
const fishDuels = new Map();
const pendingFishDuels = new Map();
const pendingFishDuelTimers = new Map();
const pendingMessageDeletes = new Map();
const pendingMessageDeleteTimers = new Map();
const dailyFishRaids = new Map();
const finishedCompetitionLogs = new Map();
let announcementState = {
  activeEvents: {},
  endedEvents: {},
  routines: {}
};
const fishVoiceChannels = new Map();
const defaultFishingChannels = new Map();
const activeVoiceSessions = new Map();
const guildActivity = new Map();
let voiceTickTimer = null;
let enforcedFishingTimer = null;
let giveMoneyTimer = null;
let fishRaidSignalTimer = null;
let fishRaidMidnightTimer = null;
let eventAnnouncementTimer = null;
let routineMessageTimer = null;
const processedEnforcedFishingIds = new Set();
const processedGiveMoneyIds = new Set();
const processedFishRaidSignalIds = new Set();
let leaderboardCache = { records: [], loadedAt: 0 };
const leaderboardCacheTtlMs = 2 * 60 * 1000;

function formatLogValue(value, fallback = "-") {
  const text = String(value || "").trim();
  return text || fallback;
}

function channelLogName(channel) {
  if (!channel) {
    return "";
  }
  const name = channel.name ? `#${channel.name}` : "";
  return name ? `${name} (${channel.id})` : channel.id;
}

function guildLogName(channel, guildId = "") {
  const guild = channel?.guild;
  const id = guild?.id || guildId;
  if (!id) {
    return "";
  }
  return guild?.name ? `${guild.name} (${id})` : id;
}

function logBotAction(action, details = {}) {
  const fields = [
    `time=${new Date().toISOString()}`,
    details.user ? `user=${formatLogValue(details.user)}` : "",
    details.guild || details.guildId ? `server=${formatLogValue(details.guild || details.guildId)}` : "",
    details.channel || details.channelId ? `channel=${formatLogValue(details.channel || details.channelId)}` : "",
    details.extra ? String(details.extra) : ""
  ].filter(Boolean);
  console.log(`[Bot] ${action}${fields.length ? ` | ${fields.join(" | ")}` : ""}`);
}

function competitionLogName(competition) {
  if (competition?.mode === "raid") return "Fish Raid";
  if (competition?.mode === "duel") return "Fish Duel";
  return "Fish Comp";
}

function readJsonFile(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) {
      return fallback;
    }
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : fallback;
  } catch (error) {
    console.warn(`Could not read runtime state | time=${new Date().toISOString()} | file=${path.basename(filePath)} | message=${error.message}`);
    return fallback;
  }
}

function writeJsonFile(filePath, payload) {
  try {
    fs.mkdirSync(runtimeDirectory, { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(payload, null, 2));
  } catch (error) {
    console.warn(`Could not save runtime state | time=${new Date().toISOString()} | file=${path.basename(filePath)} | message=${error.message}`);
  }
}

function loadCompetitionHistoryLogs() {
  const saved = readJsonFile(competitionHistoryPath, { logs: [] });
  finishedCompetitionLogs.clear();
  for (const entry of Array.isArray(saved.logs) ? saved.logs : []) {
    if (!entry?.id || !entry.content) {
      continue;
    }
    finishedCompetitionLogs.set(String(entry.id), {
      createdAt: Math.max(0, Number(entry.createdAt || 0)),
      fileName: String(entry.fileName || "match_log.txt"),
      content: String(entry.content || "")
    });
  }
  cleanupFinishedCompetitionLogs();
}

function saveCompetitionHistoryLogs() {
  writeJsonFile(competitionHistoryPath, {
    savedAt: new Date().toISOString(),
    logs: [...finishedCompetitionLogs.entries()].map(([id, record]) => ({
      id,
      createdAt: Math.max(0, Number(record.createdAt || 0)),
      fileName: String(record.fileName || "match_log.txt"),
      content: String(record.content || "")
    }))
  });
}

function loadAnnouncementState() {
  const saved = readJsonFile(announcementStatePath, {});
  announcementState = {
    activeEvents: saved.activeEvents && typeof saved.activeEvents === "object" && !Array.isArray(saved.activeEvents) ? saved.activeEvents : {},
    endedEvents: saved.endedEvents && typeof saved.endedEvents === "object" && !Array.isArray(saved.endedEvents) ? saved.endedEvents : {},
    routines: saved.routines && typeof saved.routines === "object" && !Array.isArray(saved.routines) ? saved.routines : {}
  };
  for (const eventKey of Object.keys(announcementState.activeEvents)) {
    announcedEvents.add(eventKey);
  }
  for (const eventKey of Object.keys(announcementState.endedEvents)) {
    announcedEndedEvents.add(eventKey);
  }
}

function saveAnnouncementState() {
  writeJsonFile(announcementStatePath, {
    savedAt: new Date().toISOString(),
    activeEvents: announcementState.activeEvents,
    endedEvents: announcementState.endedEvents,
    routines: announcementState.routines
  });
}

function eventAnnouncementKey(event, phase = "start") {
  const marker = phase === "end" ? getEventEndedAt(event) || event.stoppedAt || event.endsAt : event.deployedAt || event.startAt || event.endsAt || "";
  return `${event?.id || event?.title || "event"}:${phase}:${marker}`;
}

function isEventAnnouncementLocallyMarked(event, phase = "start") {
  const key = eventAnnouncementKey(event, phase);
  return phase === "end"
    ? Boolean(announcementState.endedEvents[key] || announcedEndedEvents.has(key) || announcedEndedEvents.has(event.id))
    : Boolean(announcementState.activeEvents[key] || announcedEvents.has(key) || announcedEvents.has(event.id));
}

function markEventAnnouncementLocal(event, phase = "start", guildId = "", channelId = "") {
  const key = eventAnnouncementKey(event, phase);
  const target = phase === "end" ? announcementState.endedEvents : announcementState.activeEvents;
  target[key] = {
    eventId: event?.id || "",
    title: event?.title || "",
    guildId: guildId || event?.guildId || "",
    channelId: channelId || event?.announcementChannelId || "",
    markedAt: new Date().toISOString()
  };
  if (phase === "end") {
    announcedEndedEvents.add(key);
    announcedEndedEvents.add(event.id);
  } else {
    announcedEvents.add(key);
    announcedEvents.add(event.id);
  }
  saveAnnouncementState();
}

function routineAnnouncementKey(routineId, guildId, triggerKey) {
  return `${routineId || "routine"}:${guildId || "guild"}:${triggerKey || "trigger"}`;
}

function isRoutineLocallyMarked(routineId, guildId, triggerKey) {
  return Boolean(announcementState.routines[routineAnnouncementKey(routineId, guildId, triggerKey)]);
}

function markRoutineLocal(routineId, guildId, triggerKey, channelId = "") {
  const key = routineAnnouncementKey(routineId, guildId, triggerKey);
  announcementState.routines[key] = {
    routineId,
    guildId,
    triggerKey,
    channelId,
    markedAt: new Date().toISOString()
  };
  saveAnnouncementState();
}

async function refreshGameData(caller = "unknown") {
  gameData = await getGameData({ caller });
  if (client.isReady()) {
    await hydrateActiveEventGuilds();
  }
  scheduleNextEventAnnouncement();
  if (!Array.isArray(gameData.fishBags)) {
    gameData.fishBags = [];
  }
}

function queuePlayerWork(userId, work) {
  const previous = playerQueues.get(userId) || Promise.resolve();
  const next = previous
    .catch(() => {})
    .then(work)
    .finally(() => {
      if (playerQueues.get(userId) === next) {
        playerQueues.delete(userId);
      }
    });

  playerQueues.set(userId, next);
  return next;
}

function getRod(rodId) {
  return gameData.rods.find((rod) => rod.id === rodId) || gameData.rods[0];
}

function getFishBag(fishBagId) {
  const id = String(fishBagId || "").trim();
  return id ? gameData.fishBags.find((bag) => bag.id === id) || null : null;
}

function getItemBonuses(item, context = {}) {
  const bonuses = Array.isArray(item?.bonuses) ? item.bonuses : [];
  return bonuses.filter((bonus) => {
    if (!bonus?.type) return false;
    if (bonus.mode && bonus.mode !== context.mode) return false;
    if (bonus.target && bonus.target !== context.target) return false;
    if (bonus.condition === "opponent_higher_level" && !(Number(context.opponentLevel || 0) > Number(context.userLevel || 0))) return false;
    if (bonus.condition === "opponent_lower_level" && !(Number(context.opponentLevel || 0) < Number(context.userLevel || 0))) return false;
    return true;
  });
}

function sumItemBonus(item, type, context = {}) {
  return getItemBonuses(item, context)
    .filter((bonus) => bonus.type === type)
    .reduce((total, bonus) => total + Number(bonus.value || 0), 0);
}

function getEffectiveRodAccuracy(rod, context = {}) {
  return Math.max(0, Math.min(100, Number(rod?.accuracy ?? 50) + sumItemBonus(rod, "accuracy", context)));
}

function getEffectiveFishBagSpace(player, context = {}) {
  const bag = getFishBag(player?.fishBagId);
  if (!bag) {
    return 0;
  }
  return Math.max(1, Number(bag.spaceKg || 0) + sumItemBonus(bag, "spaceKg", context));
}

function getEffectiveFishBagCapacity(player, context = {}) {
  return getEffectiveFishBagSpace(player, context);
}

function hasEquippedFishBag(player) {
  const bag = getFishBag(player?.fishBagId);
  return Boolean(bag && Array.isArray(player?.ownedFishBags) && player.ownedFishBags.includes(bag.id));
}

function getSettings() {
  return gameData.settings || {
    rodStoreImageBase64: "",
    rodStoreImageUrl: "",
    fishCompBannerBase64: "",
    fishCompBannerUrl: "",
    fishCompRegistrationBannerBase64: "",
    fishCompRegistrationBannerUrl: "",
    fishCompRunningBannerBase64: "",
    fishCompRunningBannerUrl: "",
    fishCompResultBannerBase64: "",
    fishCompResultBannerUrl: "",
    fishGuideBannerBase64: "",
    fishGuideBannerUrl: "",
    fishHelpBannerBase64: "",
    fishHelpBannerUrl: "",
    sellFishBannerBase64: "",
    sellFishBannerUrl: "",
    fishCompEvents: [],
    fishRaidRegistrationBannerBase64: "",
    fishRaidRegistrationBannerUrl: "",
    fishRaidRunningBannerBase64: "",
    fishRaidRunningBannerUrl: "",
    fishRaidResultBannerBase64: "",
    fishRaidResultBannerUrl: "",
    fishRaidBannerBase64: "",
    fishRaidBannerUrl: "",
    fishRaidEvents: [],
    fishRaidBosses: [],
    fishDuelRegistrationBannerBase64: "",
    fishDuelRegistrationBannerUrl: "",
    fishDuelRunningBannerBase64: "",
    fishDuelRunningBannerUrl: "",
    fishDuelResultBannerBase64: "",
    fishDuelResultBannerUrl: "",
    fishDuelEvents: [],
    fishDuelExpReward: 40,
    fishDuelLogIntervalMs: 2500,
    fishCompLogIntervalMs: 2500,
    fishCompExpReward: 50,
    fishCompGoldReward: 0,
    fishRaidLogIntervalMs: 2500,
    fishRaidCooldownMinutes: 60,
    fishRaidParticipantExpReward: 25,
    fishRaidParticipantGoldReward: 0,
    fishRaidMvpExpReward: 75,
    fishRaidMvpGoldReward: 0,
    fishRaidClearParticipantExpReward: 50,
    fishRaidClearParticipantGoldReward: 0,
    fishRaidClearMvpExpReward: 150,
    fishRaidClearMvpGoldReward: 0,
    allowActivity: true,
    chatCooldownMs: 20_000,
    expMultiplier: 1,
    levelExpMultiplier: 1,
    voiceExpAmount: 1,
    voiceExpIntervalMinutes: 15
  };
}

function getVoiceExpIntervalMs() {
  return Math.max(60_000, Number(getSettings().voiceExpIntervalMinutes || 15) * 60_000);
}

function getVoiceExpAmount() {
  return Math.max(0, Math.floor(Number(getSettings().voiceExpAmount ?? 1)));
}

function addFishingProgress(player, progressAmount = 1, guildId = "") {
  const rod = getRod(player.rodId);
  if (!rod || gameData.fish.length === 0) {
    return [];
  }

  const catches = [];
  const speed = Math.max(1, Number(rod.speed || 1));
  const progressMultiplier = getEventMultiplier("fishing_speed", guildId);
  player.progress = Math.max(0, Number(player.progress || 0)) + Math.max(0, Number(progressAmount || 0) * progressMultiplier);
  while (player.progress >= speed) {
    player.progress -= speed;
    const catchResult = rollFish(rod, guildId);
    if (!catchResult) {
      break;
    }
    const { expGain, expBase, expEventInfo } = addCatch(player, catchResult.fish, catchResult.catchWeight, guildId);
    catches.push({ caughtFish: catchResult.fish, catchWeight: catchResult.catchWeight, expGain, expBase, expEventInfo });
  }
  return catches;
}

function formatDurationIndonesian(durationMs) {
  const totalMinutes = Math.max(0, Math.floor(Number(durationMs || 0) / 60_000));
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;

  if (hours && minutes) {
    return `${hours} jam ${minutes} menit`;
  }
  if (hours) {
    return `${hours} jam`;
  }
  return `${minutes} menit`;
}

function loadFishVoiceChannels() {
  fs.mkdirSync(runtimeDirectory, { recursive: true });
  if (!fs.existsSync(fishVoiceChannelsPath)) {
    return;
  }

  try {
    const savedChannels = JSON.parse(fs.readFileSync(fishVoiceChannelsPath, "utf8"));
    for (const [guildId, channelId] of Object.entries(savedChannels || {})) {
      if (guildId && channelId) {
        fishVoiceChannels.set(guildId, channelId);
      }
    }
  } catch (error) {
    console.error("Could not load fish voice channels:", error);
  }
}

function saveFishVoiceChannels() {
  fs.mkdirSync(runtimeDirectory, { recursive: true });
  fs.writeFileSync(fishVoiceChannelsPath, JSON.stringify(Object.fromEntries(fishVoiceChannels), null, 2));
}

function loadDefaultFishingChannels() {
  fs.mkdirSync(runtimeDirectory, { recursive: true });
  if (!fs.existsSync(defaultFishingChannelsPath)) {
    return;
  }

  try {
    const savedChannels = JSON.parse(fs.readFileSync(defaultFishingChannelsPath, "utf8"));
    for (const [guildId, channelId] of Object.entries(savedChannels || {})) {
      if (guildId && channelId) {
        defaultFishingChannels.set(guildId, channelId);
      }
    }
  } catch (error) {
    console.error("Could not load default fishing channels:", error);
  }
}

function saveDefaultFishingChannels() {
  fs.mkdirSync(runtimeDirectory, { recursive: true });
  fs.writeFileSync(defaultFishingChannelsPath, JSON.stringify(Object.fromEntries(defaultFishingChannels), null, 2));
}

function normalizePendingFishDuel(raw, options = {}) {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const id = String(raw.id || "").trim();
  const creatorId = String(raw.creator?.id || raw.creatorId || "").trim();
  const createdAt = Number(raw.createdAt || 0);
  const allowExpired = Boolean(options.allowExpired);
  if (!id || !creatorId || !createdAt || (!allowExpired && Date.now() - createdAt >= fishDuelPendingTtlMs)) {
    return null;
  }

  const targetId = String(raw.target?.id || raw.targetId || "").trim();
  return {
    id,
    guildId: raw.guildId ? String(raw.guildId) : "",
    channelId: raw.channelId ? String(raw.channelId) : "",
    messageId: raw.messageId ? String(raw.messageId) : "",
    creatorId,
    targetId,
    creator: {
      id: creatorId,
      username: String(raw.creator?.username || "Challenger"),
      globalName: String(raw.creator?.globalName || ""),
      displayName: String(raw.creator?.displayName || raw.creator?.username || "Challenger")
    },
    target: targetId ? {
      id: targetId,
      username: String(raw.target?.username || "Target"),
      globalName: String(raw.target?.globalName || ""),
      displayName: String(raw.target?.displayName || raw.target?.username || "Target")
    } : null,
    betAmount: Math.max(0, Math.floor(Number(raw.betAmount || 0))),
    createdAt
  };
}

function savePendingFishDuels() {
  try {
    fs.mkdirSync(runtimeDirectory, { recursive: true });
    fs.writeFileSync(fishDuelPendingPath, JSON.stringify({ duels: [...pendingFishDuels.values()] }, null, 2));
  } catch (error) {
    console.error("Could not save pending fish duels:", error);
  }
}

async function deletePendingFishDuelMessage(pending) {
  if (!pending?.channelId || !pending?.messageId) {
    return;
  }
  const channel = await client.channels.fetch(pending.channelId).catch(() => null);
  if (!channel?.messages?.fetch) {
    return;
  }
  const message = await channel.messages.fetch(pending.messageId).catch(() => null);
  await message?.delete?.().catch(() => {});
}

async function expirePendingFishDuel(duelId, deleteMessage = true) {
  const pending = pendingFishDuels.get(duelId);
  pendingFishDuelTimers.delete(duelId);
  pendingFishDuels.delete(duelId);
  savePendingFishDuels();
  if (deleteMessage) {
    await deletePendingFishDuelMessage(pending);
  }
}

function schedulePendingFishDuelExpiry(duelId) {
  const pending = pendingFishDuels.get(duelId);
  if (!pending) {
    return;
  }
  if (pendingFishDuelTimers.has(duelId)) {
    clearTimeout(pendingFishDuelTimers.get(duelId));
  }
  const remainingMs = pending.createdAt + fishDuelPendingTtlMs - Date.now();
  if (remainingMs <= 0) {
    expirePendingFishDuel(duelId).catch((error) => console.error("Could not expire pending fish duel:", error));
    return;
  }
  const timer = setTimeout(() => {
    expirePendingFishDuel(duelId).catch((error) => console.error("Could not expire pending fish duel:", error));
  }, remainingMs);
  pendingFishDuelTimers.set(duelId, timer);
}

function setPendingFishDuel(duelId, pending) {
  const normalized = normalizePendingFishDuel({ ...pending, id: duelId });
  if (!normalized) {
    return;
  }
  pendingFishDuels.set(duelId, normalized);
  schedulePendingFishDuelExpiry(duelId);
  savePendingFishDuels();
}

function deletePendingFishDuel(duelId) {
  if (pendingFishDuelTimers.has(duelId)) {
    clearTimeout(pendingFishDuelTimers.get(duelId));
    pendingFishDuelTimers.delete(duelId);
  }
  pendingFishDuels.delete(duelId);
  savePendingFishDuels();
}

function getPendingFishDuel(duelId) {
  const pending = normalizePendingFishDuel(pendingFishDuels.get(duelId));
  if (!pending) {
    if (pendingFishDuels.has(duelId)) {
      deletePendingFishDuel(duelId);
    }
    return null;
  }
  return pending;
}

function deletePendingFishDuelByMessageId(messageId) {
  if (!messageId) {
    return;
  }
  for (const pending of pendingFishDuels.values()) {
    if (pending.messageId === messageId) {
      deletePendingFishDuel(pending.id);
    }
  }
}

function loadPendingFishDuels() {
  fs.mkdirSync(runtimeDirectory, { recursive: true });
  if (!fs.existsSync(fishDuelPendingPath)) {
    return;
  }

  try {
    const saved = JSON.parse(fs.readFileSync(fishDuelPendingPath, "utf8"));
    const duels = Array.isArray(saved?.duels) ? saved.duels : Array.isArray(saved) ? saved : [];
    pendingFishDuels.clear();
    for (const raw of duels) {
      const pending = normalizePendingFishDuel(raw, { allowExpired: true });
      if (!pending) {
        continue;
      }
      if (Date.now() - pending.createdAt >= fishDuelPendingTtlMs) {
        deletePendingFishDuelMessage(pending).catch((error) => console.error("Could not delete expired pending fish duel message:", error));
      } else {
        pendingFishDuels.set(pending.id, pending);
        schedulePendingFishDuelExpiry(pending.id);
      }
    }
    savePendingFishDuels();
  } catch (error) {
    console.error("Could not load pending fish duels:", error);
  }
}

function voiceSessionKey(guildId, userId) {
  return `${guildId}:${userId}`;
}

function getCurrentVoiceSessionMs(userId) {
  const now = Date.now();
  let total = 0;
  for (const session of activeVoiceSessions.values()) {
    if (session.userId === userId) {
      total += Math.max(0, now - session.lastSyncedAt);
    }
  }
  return total;
}

async function fetchFishingMessageChannel(player = null, guildId = "") {
  const defaultChannelId = defaultFishingChannels.get(guildId);
  if (defaultChannelId) {
    const channel = await client.channels.fetch(defaultChannelId).catch(() => null);
    if (channel?.isTextBased?.() && (!guildId || !channel.guildId || channel.guildId === guildId)) {
      return channel;
    }
  }

  const lastChannelId = String(player?.lastFishingChannelId || "").trim();
  if (lastChannelId) {
    const channel = await client.channels.fetch(lastChannelId).catch(() => null);
    if (channel?.isTextBased?.() && (!guildId || !channel.guildId || channel.guildId === guildId)) {
      return channel;
    }
  }

  return null;
}

async function resolveParentTextChannel(channel) {
  if (!channel?.isTextBased?.()) {
    return null;
  }
  if (!channel.isThread?.()) {
    return channel;
  }
  if (channel.parent?.isTextBased?.()) {
    return channel.parent;
  }
  if (channel.parentId) {
    const parent = await client.channels.fetch(channel.parentId).catch(() => null);
    return parent?.isTextBased?.() ? parent : null;
  }
  return null;
}

function pendingMessageDeleteKey(channelId, messageId) {
  return `${channelId}:${messageId}`;
}

function savePendingMessageDeletes() {
  try {
    fs.mkdirSync(runtimeDirectory, { recursive: true });
    fs.writeFileSync(pendingMessageDeletesPath, JSON.stringify({ messages: [...pendingMessageDeletes.values()] }, null, 2));
  } catch (error) {
    console.error("Could not save pending message deletes:", error);
  }
}

async function deleteTrackedMessage(entry) {
  if (!entry?.channelId || !entry?.messageId) {
    return;
  }
  const channel = await client.channels.fetch(entry.channelId).catch(() => null);
  if (!channel?.messages?.fetch) {
    return;
  }
  const message = await channel.messages.fetch(entry.messageId).catch(() => null);
  await message?.delete?.().catch(() => {});
}

function removePendingMessageDelete(key) {
  const timer = pendingMessageDeleteTimers.get(key);
  if (timer) {
    clearTimeout(timer);
    pendingMessageDeleteTimers.delete(key);
  }
  pendingMessageDeletes.delete(key);
  savePendingMessageDeletes();
}

function scheduleTrackedMessageDelete(entry) {
  const normalized = {
    channelId: String(entry?.channelId || "").trim(),
    messageId: String(entry?.messageId || "").trim(),
    deleteAt: Math.max(0, Number(entry?.deleteAt || 0)),
    reason: String(entry?.reason || "scheduled message cleanup")
  };
  if (!normalized.channelId || !normalized.messageId || !normalized.deleteAt) {
    return;
  }

  const key = pendingMessageDeleteKey(normalized.channelId, normalized.messageId);
  const existingTimer = pendingMessageDeleteTimers.get(key);
  if (existingTimer) {
    clearTimeout(existingTimer);
  }
  pendingMessageDeletes.set(key, normalized);
  savePendingMessageDeletes();

  const runDelete = () => {
    deleteTrackedMessage(normalized)
      .catch((error) => console.error("Could not delete scheduled message:", error))
      .finally(() => removePendingMessageDelete(key));
  };
  const remainingMs = normalized.deleteAt - Date.now();
  if (remainingMs <= 0) {
    runDelete();
    return;
  }
  pendingMessageDeleteTimers.set(key, setTimeout(runDelete, Math.min(remainingMs, 2_147_000_000)));
}

function scheduleMessageDelete(message, delayMs = publicShowoffTtlMs, reason = "public showoff cleanup") {
  if (!message?.id || !message?.channelId) {
    if (message?.delete) {
      setTimeout(() => {
        message.delete().catch(() => {});
      }, Math.max(0, delayMs));
    }
    return;
  }
  scheduleTrackedMessageDelete({
    channelId: message.channelId,
    messageId: message.id,
    deleteAt: Date.now() + Math.max(0, delayMs),
    reason
  });
}

function loadPendingMessageDeletes() {
  fs.mkdirSync(runtimeDirectory, { recursive: true });
  if (!fs.existsSync(pendingMessageDeletesPath)) {
    return;
  }
  try {
    const saved = JSON.parse(fs.readFileSync(pendingMessageDeletesPath, "utf8"));
    const messages = Array.isArray(saved?.messages) ? saved.messages : Array.isArray(saved) ? saved : [];
    pendingMessageDeletes.clear();
    for (const entry of messages) {
      scheduleTrackedMessageDelete(entry);
    }
  } catch (error) {
    console.error("Could not load pending message deletes:", error);
  }
}

async function fetchMainTextChannel(player = null, guildId = "", fallbackChannel = null) {
  let channel = await fetchFishingMessageChannel(player, guildId) || fallbackChannel;
  if (!channel && !guildId && defaultFishingChannels.size === 1) {
    const channelId = [...defaultFishingChannels.values()][0];
    channel = await client.channels.fetch(channelId).catch(() => null);
  }
  return await resolveParentTextChannel(channel) || channel || null;
}

async function fetchRoutineMessageChannel(routine, guildId = "") {
  const channelId = String(routine?.channelId || "").trim();
  if (channelId) {
    return resolveParentTextChannel(await client.channels.fetch(channelId).catch(() => null));
  }

  const defaultChannelId = defaultFishingChannels.get(guildId);
  if (!defaultChannelId) {
    return null;
  }

  return resolveParentTextChannel(await client.channels.fetch(defaultChannelId).catch(() => null));
}

async function createFishingPopupThread(channel) {
  if (!channel?.isTextBased?.()) {
    return null;
  }
  if (channel.isThread?.()) {
    return channel;
  }
  if (!channel.threads?.create) {
    return null;
  }
  return channel.threads.create({
    name: "Fishing!",
    type: channel.type === ChannelType.GuildAnnouncement ? ChannelType.AnnouncementThread : ChannelType.PublicThread,
    autoArchiveDuration: 1440,
    reason: "TRFishing popup thread"
  });
}

async function sendFishingCatchMessages(channel, user, catches, previousLevel, currentLevel, member = null) {
  if (!channel?.isTextBased?.() || !catches.length) {
    return;
  }

  for (const result of catches) {
    await channel.send(makeCatchMessage(user, result.caughtFish, result.catchWeight, result.expGain, {
      expBase: result.expBase,
      expEventInfo: result.expEventInfo
    })).catch((error) => {
      console.error("Could not send fishing catch message:", error);
    });
  }

  if (currentLevel > previousLevel && typeof user !== "string") {
    const levelUpChannel = await resolveParentTextChannel(channel) || channel;
    await levelUpChannel.send({ embeds: [makeLevelUpEmbed(user, currentLevel, member)] }).catch((error) => {
      console.error("Could not send fishing level-up message:", error);
    });
  }
}

async function resolveCatchShowcaseChannel(interaction) {
  const channel = interaction.channel;
  if (!channel?.isTextBased?.()) {
    return null;
  }
  if (!channel.isThread?.()) {
    return channel;
  }
  if (channel.parent?.isTextBased?.()) {
    return channel.parent;
  }
  if (channel.parentId) {
    return client.channels.fetch(channel.parentId).catch(() => null);
  }
  return null;
}

async function handleCatchShowcase(interaction) {
  const targetChannel = await resolveCatchShowcaseChannel(interaction);
  if (!targetChannel?.isTextBased?.()) {
    await interaction.reply({ content: "Aku belum bisa menemukan channel utama untuk pamer tangkapan ini.", flags: MessageFlags.Ephemeral });
    return;
  }

  const embeds = interaction.message.embeds.map((embed) => EmbedBuilder.from(embed));
  const components = stripActionRowsWithCustomIdPrefix(interaction.message.components, "catch_showcase");
  if (!embeds.length && !components.length) {
    await interaction.reply({ content: "Popup tangkapan ini tidak bisa dipamerkan.", flags: MessageFlags.Ephemeral });
    return;
  }

  const files = [...interaction.message.attachments.values()].map((attachment) => ({
    attachment: attachment.url,
    name: attachment.name || undefined
  }));

  if (components.length) {
    const showcaseMessage = await targetChannel.send(makeComponentsV2Message([
      makeTextDisplay(`### ${formatDiscordMention(interaction.user.id)} meminta izin untuk pamer nih bos!`),
      ...components
    ], {
      files,
      allowedMentions: { users: [interaction.user.id] }
    }));
    scheduleMessageDelete(showcaseMessage);
  } else {
    const showcaseMessage = await targetChannel.send({
      content: `${formatDiscordMention(interaction.user.id)} meminta izin untuk pamer nih bos!`,
      embeds,
      files,
      allowedMentions: { users: [interaction.user.id] }
    });
    scheduleMessageDelete(showcaseMessage);
  }
  await interaction.reply({ content: "Tangkapanmu sudah dipamerkan di channel utama.", flags: MessageFlags.Ephemeral });
}

function isCountedVoiceState(voiceState) {
  if (!voiceState?.guild || !voiceState.channelId || voiceState.member?.user?.bot) {
    return false;
  }
  if (!fishVoiceChannels.has(voiceState.guild.id)) {
    return false;
  }
  return voiceState.channelId !== voiceState.guild.afkChannelId;
}

function startVoiceSession(member, channelId) {
  if (!member?.guild || member.user.bot || channelId === member.guild.afkChannelId) {
    return;
  }
  if (!fishVoiceChannels.has(member.guild.id)) {
    return;
  }

  const key = voiceSessionKey(member.guild.id, member.id);
  const session = activeVoiceSessions.get(key);
  if (session) {
    session.channelId = channelId;
    return;
  }

  const now = Date.now();
  activeVoiceSessions.set(key, {
    guildId: member.guild.id,
    userId: member.id,
    channelId,
    lastSyncedAt: now
  });
}

async function processVoiceSession(key, forceSave = false) {
  if (!isActivityAllowed()) {
    return;
  }
  const session = activeVoiceSessions.get(key);
  if (!session) {
    return;
  }

  const now = Date.now();
  const elapsedMs = Math.max(0, now - session.lastSyncedAt);
  const intervalMs = getVoiceExpIntervalMs();

  if (!forceSave && elapsedMs <= 0) {
    return;
  }

  await withPlayer(session.userId, async (player) => {
    player.voiceTotalMs = Math.max(0, Number(player.voiceTotalMs || 0)) + elapsedMs;
    const voiceRemainderMs = Math.max(0, Number(player.voiceExpRemainderMs || 0)) + elapsedMs;
    const intervals = Math.floor(voiceRemainderMs / intervalMs);
    const progressGain = intervals * getVoiceExpAmount();
    player.voiceExpRemainderMs = voiceRemainderMs - intervals * intervalMs;
    if (progressGain > 0) {
      const previousLevel = getLevel(player.exp);
      const catches = addFishingProgress(player, progressGain, session.guildId);
      if (catches.length) {
        const channel = await fetchFishingMessageChannel(player, session.guildId);
        const guild = channel?.guild || client.guilds.cache.get(session.guildId);
        const memberPromise = guild?.members?.fetch
          ? guild.members.fetch(session.userId).catch(() => null)
          : Promise.resolve(null);
        const [user, member] = await Promise.all([
          client.users.fetch(session.userId).catch(() => formatDiscordMention(session.userId)),
          memberPromise
        ]);
        await sendFishingCatchMessages(channel, user, catches, previousLevel, getLevel(player.exp), member);
      }
    }
  });

  session.lastSyncedAt = now;
}

async function stopVoiceSession(guildId, userId) {
  const key = voiceSessionKey(guildId, userId);
  if (!activeVoiceSessions.has(key)) {
    return;
  }
  await processVoiceSession(key, true);
  activeVoiceSessions.delete(key);
}

async function reconcileGuildVoiceSessions(guild) {
  if (!guild || !fishVoiceChannels.has(guild.id)) {
    return;
  }

  const countedUserIds = new Set();
  for (const channel of guild.channels.cache.values()) {
    if (!channel.isVoiceBased?.() || channel.id === guild.afkChannelId) {
      continue;
    }
    for (const member of channel.members.values()) {
      if (!member.user.bot) {
        countedUserIds.add(member.id);
        startVoiceSession(member, channel.id);
      }
    }
  }

  await Promise.all([...activeVoiceSessions.entries()]
    .filter(([, session]) => session.guildId === guild.id && !countedUserIds.has(session.userId))
    .map(([key, session]) => stopVoiceSession(session.guildId, session.userId)));
}

async function joinFishVoiceChannel(channel) {
  const existingConnection = getVoiceConnection(channel.guild.id);
  if (existingConnection?.joinConfig?.channelId === channel.id) {
    fishVoiceChannels.set(channel.guild.id, channel.id);
    saveFishVoiceChannels();
    return existingConnection;
  }

  const connection = joinVoiceChannel({
    channelId: channel.id,
    guildId: channel.guild.id,
    adapterCreator: channel.guild.voiceAdapterCreator,
    selfDeaf: true,
    selfMute: true
  });

  fishVoiceChannels.set(channel.guild.id, channel.id);
  saveFishVoiceChannels();

  connection.on(VoiceConnectionStatus.Disconnected, () => {
    setTimeout(async () => {
      if (fishVoiceChannels.get(channel.guild.id) !== channel.id || !client.isReady()) {
        return;
      }
      const savedChannel = await client.channels.fetch(channel.id).catch(() => null);
      if (savedChannel?.isVoiceBased?.()) {
        joinFishVoiceChannel(savedChannel).catch((error) => console.error("Could not rejoin fish voice channel:", error));
      }
    }, 5_000);
  });

  await entersState(connection, VoiceConnectionStatus.Ready, 15_000).catch(() => connection);
  return connection;
}

async function restoreFishVoiceChannels() {
  for (const [guildId, channelId] of [...fishVoiceChannels.entries()]) {
    const channel = await client.channels.fetch(channelId).catch(() => null);
    if (!channel?.isVoiceBased?.()) {
      fishVoiceChannels.delete(guildId);
      saveFishVoiceChannels();
      continue;
    }
    await joinFishVoiceChannel(channel).catch((error) => console.error("Could not restore fish voice channel:", error));
    await reconcileGuildVoiceSessions(channel.guild).catch((error) => console.error("Could not scan voice sessions:", error));
  }
}

function startVoiceExpTimer() {
  clearInterval(voiceTickTimer);
  voiceTickTimer = setInterval(() => {
    Promise.all([...activeVoiceSessions.keys()].map((key) => processVoiceSession(key)))
      .catch((error) => console.error("Could not process voice progress:", error));
  }, voiceTickMs);
}

function getEvents() {
  const events = Array.isArray(gameData.events) ? [...gameData.events] : [];
  const activeEvent = gameData.activeEvent;
  if (activeEvent && !events.some((event) => event.id === activeEvent.id)) {
    events.push(activeEvent);
  }
  return events;
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

function getEventEndedAt(event) {
  const stoppedAt = Date.parse(event?.stoppedAt || "");
  if (Number.isFinite(stoppedAt)) {
    return stoppedAt;
  }

  const endsAt = Date.parse(event?.endsAt || "");
  return Number.isFinite(endsAt) && endsAt <= Date.now() ? endsAt : 0;
}

function isEventEnded(event) {
  return Boolean(event?.title && event?.announcementChannelId && event?.deployedAt && getEventEndedAt(event));
}

function getEventStartMs(event) {
  const startsAt = Date.parse(event?.startAt || event?.deployedAt || "");
  return Number.isFinite(startsAt) ? startsAt : 0;
}

function getNextUnannouncedEventStartMs() {
  const now = Date.now();
  return getEvents()
    .filter((event) => event?.title && event.announcementChannelId && event.deployedAt && !event.isAnnounced && !event.stoppedAt)
    .map(getEventStartMs)
    .filter((startsAt) => startsAt > now)
    .sort((a, b) => a - b)[0] || 0;
}

function scheduleNextEventAnnouncement() {
  clearTimeout(eventAnnouncementTimer);
  const nextStartAt = getNextUnannouncedEventStartMs();
  if (!nextStartAt) {
    eventAnnouncementTimer = null;
    return;
  }

  const delayMs = Math.min(Math.max(0, nextStartAt - Date.now()), maxEventAnnouncementTimeoutMs);
  eventAnnouncementTimer = setTimeout(() => {
    refreshGameData("scheduled event announcement")
      .then(() => announceEventUpdates())
      .catch((error) => console.error("Could not announce scheduled event:", error));
  }, delayMs);
}

function getActiveEvents(guildId = "") {
  return getEvents().filter((event) => isEventRunning(event) && event.guildId && event.guildId === guildId);
}

function getEventMultiplier(type, guildId = "", fishId = "") {
  return getActiveEvents(guildId).reduce((multiplier, event) => {
    const eventMultiplier = normalizeEventBonuses(event)
      .filter((bonus) => bonus.type === type)
      .filter((bonus) => type !== "fish_chance" || !bonus.fishId || bonus.fishId === fishId)
      .reduce((bonusMultiplier, bonus) => bonusMultiplier * Math.max(0, Number(bonus.value || 1)), 1);
    return multiplier * eventMultiplier;
  }, 1);
}

function getEventMultiplierInfo(type, guildId = "", fishId = "") {
  const multiplier = getEventMultiplier(type, guildId, fishId);
  return {
    multiplier,
    active: Math.abs(multiplier - 1) > 0.000001
  };
}

function normalizeAdminValue(value) {
  return String(value || "").trim().toLowerCase();
}

function isAdmin(user) {
  const allowedAdmins = gameData.adminDiscordIds.map(normalizeAdminValue);
  return [
    user.id,
    user.username,
    user.globalName,
    user.displayName
  ].map(normalizeAdminValue).some((value) => value && allowedAdmins.includes(value));
}

function formatKg(weight) {
  return `${Number(weight || 0).toFixed(2)} kg`;
}

function truncateText(value, maxLength) {
  const text = String(value || "");
  return text.length > maxLength ? `${text.slice(0, Math.max(0, maxLength - 3))}...` : text;
}

function escapeXml(value) {
  return String(value || "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&apos;"
  }[char]));
}

const componentsV2Flag = MessageFlags.IsComponentsV2 || 32768;

function makeTextDisplay(content) {
  return new TextDisplayBuilder().setContent(truncateText(String(content || "\u200b"), 3900));
}

function formatEmbedMainText(embedData, prefix = "") {
  return [
    prefix,
    embedData.title ? `## ${embedData.title}` : "",
    embedData.description || ""
  ].filter(Boolean).join("\n");
}

function formatEmbedFields(fields = []) {
  return fields
    .map((field) => `**${field.name}**\n${field.value}`)
    .filter(Boolean)
    .join("\n\n");
}

function makeMediaGallery(url, description = "") {
  return new MediaGalleryBuilder().addItems(
    new MediaGalleryItemBuilder()
      .setURL(url)
      .setDescription(description || "Message image")
  );
}

function makeComponentsV2Message(components, options = {}) {
  return {
    content: null,
    embeds: [],
    flags: options.flags ? options.flags | componentsV2Flag : componentsV2Flag,
    files: options.files || [],
    allowedMentions: options.allowedMentions,
    components
  };
}

function makeEmbedPanelMessage(embed, options = {}) {
  const data = typeof embed?.toJSON === "function" ? embed.toJSON() : embed || {};
  const container = new ContainerBuilder();
  if (data.color) {
    container.setAccentColor(data.color);
  }

  const mainText = formatEmbedMainText(data, options.prefix || "");
  if (data.thumbnail?.url) {
    container.addSectionComponents(
      new SectionBuilder()
        .addTextDisplayComponents(makeTextDisplay(mainText || "\u200b"))
        .setThumbnailAccessory(new ThumbnailBuilder().setURL(data.thumbnail.url))
    );
  } else if (mainText) {
    container.addTextDisplayComponents(makeTextDisplay(mainText));
  }

  const fieldText = formatEmbedFields(data.fields);
  if (fieldText) {
    container.addTextDisplayComponents(makeTextDisplay(fieldText));
  }

  if (data.image?.url) {
    container.addMediaGalleryComponents(makeMediaGallery(data.image.url, data.title || "Message image"));
  }

  if (options.componentBlocks?.length) {
    container.addSeparatorComponents(new SeparatorBuilder());
    for (const block of options.componentBlocks) {
      if (block.text) {
        container.addTextDisplayComponents(makeTextDisplay(block.text));
      }
      if (block.components?.length) {
        container.addActionRowComponents(block.components);
      }
    }
  } else if (options.components?.length) {
    container.addSeparatorComponents(new SeparatorBuilder());
    container.addActionRowComponents(options.components);
  }

  return makeComponentsV2Message([container], {
    files: options.files,
    allowedMentions: options.allowedMentions,
    flags: options.flags
  });
}

function makeSimplePanelMessage(title, description, color = 0xe74c3c) {
  return makeEmbedPanelMessage(
    new EmbedBuilder()
      .setColor(color)
      .setTitle(title)
      .setDescription(description)
  );
}

function componentCustomId(component) {
  return component?.custom_id || component?.customId || "";
}

function stripActionRowsWithCustomIdPrefix(components, customIdPrefix) {
  return (components || [])
    .map((component) => {
      const data = typeof component?.toJSON === "function" ? component.toJSON() : component;
      if (!data || typeof data !== "object") {
        return null;
      }
      if (data.type === 1 && (data.components || []).some((child) => componentCustomId(child).startsWith(customIdPrefix))) {
        return null;
      }
      if (Array.isArray(data.components)) {
        return {
          ...data,
          components: stripActionRowsWithCustomIdPrefix(data.components, customIdPrefix)
        };
      }
      return data;
    })
    .filter((component) => component && (!Array.isArray(component.components) || component.components.length));
}

function makeProgressBar(value, max, size = 10) {
  const safeMax = Math.max(1, Number(max || 1));
  const safeValue = Math.max(0, Math.min(safeMax, Number(value || 0)));
  const filled = Math.round((safeValue / safeMax) * size);
  return `${"█".repeat(filled)}${"░".repeat(size - filled)}`;
}

function rollCatchWeight(fish, rod) {
  const minWeight = Math.max(0.01, Number(fish.minWeight || 0.1));
  const fishMaxWeight = Math.max(minWeight, Number(fish.maxWeight || minWeight));
  const rodMaxWeight = Number(rod.maxWeight || fishMaxWeight);
  const maxWeight = Math.max(minWeight, Math.min(fishMaxWeight, rodMaxWeight));
  return minWeight + Math.random() * (maxWeight - minWeight);
}

function expForLevel(level) {
  return Math.floor(75 * level ** 1.7 * Number(getSettings().levelExpMultiplier || 1));
}

function getLevel(exp) {
  let level = 1;
  while (exp >= expForLevel(level)) {
    level += 1;
  }
  return level;
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
const fishRarities = Object.keys(fishLuckRarityBaseScores);

function getFishLuckRarityBaseScore(rarity) {
  const rarityName = String(rarity || "Common").trim();
  if (fishLuckRarityBaseScores[rarityName] !== undefined) {
    return fishLuckRarityBaseScores[rarityName];
  }
  const rarityIndex = fishRarities.indexOf(rarityName);
  return rarityIndex >= 0 ? 1000 + rarityIndex * 1500 : 1000;
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

function getFishLuckScoreRanges() {
  const fish = Array.isArray(gameData.fish) ? gameData.fish : [];
  const baseWeights = fish.map((entry) => Math.max(0, Number(entry.baseWeight || 0))).filter((value) => value > 0);
  const minWeights = fish.map((entry) => Math.max(0, Number(entry.minWeight || 0))).filter((value) => value > 0);
  return {
    minBaseWeight: Math.min(...baseWeights, 1),
    maxBaseWeight: Math.max(...baseWeights, 1),
    minWeight: Math.min(...minWeights, 0.01),
    maxWeight: Math.max(...minWeights, 0.01)
  };
}

function formatFishLuckScore(fishEntry) {
  if (!fishEntry || typeof fishEntry !== "object") {
    return Math.max(0, Math.round((1 + Number(fishEntry || 0)) * 5000));
  }
  const ranges = getFishLuckScoreRanges();
  const baseScore = getFishLuckRarityBaseScore(fishEntry.rarity);
  const scarcityScore = Math.round((1 - normalizeLogRange(fishEntry.baseWeight, ranges.minBaseWeight, ranges.maxBaseWeight)) * 700);
  const weightScore = Math.round(normalizeLogRange(fishEntry.minWeight, ranges.minWeight, ranges.maxWeight) * 500);
  return Math.max(0, baseScore + scarcityScore + weightScore);
}

function normalizeMessage(content) {
  return content.toLowerCase().replace(/\s+/g, " ").trim();
}

function isPotentialFishingChat(message) {
  if (message.author.bot || !message.guild) {
    return false;
  }

  const content = normalizeMessage(message.content);
  return !content.startsWith(prefix) && content.length >= minMessageLength;
}

function isValidFishingChat(message, player) {
  if (!isPotentialFishingChat(message)) {
    return false;
  }

  const content = normalizeMessage(message.content);
  if (content === player.lastMessage) {
    return false;
  }

  const now = Date.now();
  if (now - player.lastCountedAt < Number(getSettings().chatCooldownMs || 20_000)) {
    return false;
  }

  player.lastCountedAt = now;
  player.lastMessage = content;
  return true;
}

function isActivityAllowed() {
  return getSettings().allowActivity !== false;
}

function activityBlockedMessage() {
  return "Saat ini aktivitas sedang dibatas, mohon menunggu ya";
}

function recordGuildActivity(guildId) {
  const selectedGuildId = String(guildId || "").trim();
  if (selectedGuildId) {
    guildActivity.set(selectedGuildId, Date.now());
  }
}

function getAvailableFish(guildId = "") {
  const selectedGuildId = String(guildId || "").trim();
  return gameData.fish.filter((entry) => {
    const fishServerId = String(entry.serverId || "").trim();
    return !fishServerId || (selectedGuildId && fishServerId === selectedGuildId);
  });
}

function rollFish(rod, guildId = "") {
  const rodMaxWeight = Number(rod.maxWeight || Infinity);
  const availableFish = getAvailableFish(guildId);
  const catchableFish = availableFish.filter((entry) => Number(entry.minWeight || 0) <= rodMaxWeight);
  const fishPool = catchableFish.length ? catchableFish : availableFish;
  const weightedFish = fishPool.map((entry) => {
    const luckWeight = Number(entry.baseWeight || 0) + Number(rod.luck || 0) * Number(entry.luckScale || 0);
    return {
      fish: entry,
      weight: Math.max(0.1, luckWeight) * getEventMultiplier("fish_chance", guildId, entry.id)
    };
  });
  const totalWeight = weightedFish.reduce((sum, entry) => sum + entry.weight, 0);
  let roll = Math.random() * totalWeight;

  for (const entry of weightedFish) {
    roll -= entry.weight;
    if (roll <= 0) {
      return {
        fish: entry.fish,
        catchWeight: rollCatchWeight(entry.fish, rod)
      };
    }
  }

  const fallback = weightedFish[0]?.fish;
  return fallback ? { fish: fallback, catchWeight: rollCatchWeight(fallback, rod) } : null;
}

function addCatch(player, caughtFish, catchWeight, guildId = "") {
  const expReward = calculateCatchExp(caughtFish, guildId);
  const expGain = expReward.total;
  const luckScore = formatFishLuckScore(caughtFish);
  player.inventory[caughtFish.id] = (player.inventory[caughtFish.id] || 0) + 1;
  player.fishDex = player.fishDex && typeof player.fishDex === "object" ? player.fishDex : {};
  const dexEntry = player.fishDex[caughtFish.id] && typeof player.fishDex[caughtFish.id] === "object"
    ? player.fishDex[caughtFish.id]
    : {};
  player.fishDex[caughtFish.id] = {
    count: Math.max(0, Math.floor(Number(dexEntry.count || 0))) + 1,
    heaviestWeight: Math.max(Number(dexEntry.heaviestWeight || 0), Number(catchWeight || 0))
  };
  player.totalFishCaught = Math.max(0, Number(player.totalFishCaught || 0)) + 1;
  if (!player.heaviestFish || Number(catchWeight || 0) > Number(player.heaviestFish.weight || 0)) {
    player.heaviestFish = {
      fishId: caughtFish.id,
      name: caughtFish.name,
      weight: Number(catchWeight || 0)
    };
  }
  refreshPlayerLuckiestFish(player, guildId);
  player.exp += expGain;
  return { expGain, expBase: expReward.base, expEventInfo: expReward.eventInfo, luckScore };
}

function calculateCatchExp(caughtFish, guildId = "") {
  const base = Math.max(0, Math.round(Number(caughtFish.exp || 0) * Number(getSettings().expMultiplier || 1)));
  const eventInfo = getEventMultiplierInfo("exp_multiplier", guildId);
  return {
    base,
    total: Math.max(0, Math.round(base * eventInfo.multiplier)),
    eventInfo
  };
}

function formatFishLine(fishEntry, quantity = null) {
  const amount = quantity === null ? "" : ` x${quantity}`;
  const minWeight = Number(fishEntry.minWeight || 0);
  const maxWeight = Number(fishEntry.maxWeight || minWeight);
  return `${fishEntry.name}${amount} - ${fishEntry.rarity}, ${formatKg(minWeight)}-${formatKg(maxWeight)}, ${fishEntry.exp} EXP, ${fishEntry.gold} gold`;
}

function formatInventoryFishLine(fishEntry, quantity) {
  const minWeight = Number(fishEntry.minWeight || 0);
  const maxWeight = Number(fishEntry.maxWeight || minWeight);
  const totalSellGold = Math.max(0, Math.round(Number(quantity || 0) * Number(fishEntry.gold || 0)));
  return [
    `**${fishEntry.name}** x${quantity}`,
    `${fishEntry.rarity} | ${formatKg(minWeight)}-${formatKg(maxWeight)} | ${fishEntry.exp} EXP | ${formatGoldAmount(totalSellGold)}`
  ].join("\n");
}

function calculateInventorySellGold(player, guildId = "") {
  const goldEventInfo = getEventMultiplierInfo("gold_multiplier", guildId);
  const baseGold = gameData.fish.reduce((sum, fishEntry) => {
    const quantity = Math.max(0, Math.floor(Number(player.inventory?.[fishEntry.id] || 0)));
    return sum + Math.max(0, Math.round(quantity * Number(fishEntry.gold || 0)));
  }, 0);
  return {
    baseGold,
    totalGold: Math.max(0, Math.round(baseGold * goldEventInfo.multiplier)),
    goldEventInfo
  };
}

function getFishDexEntry(player, fishEntry) {
  const fishDex = player.fishDex && typeof player.fishDex === "object" ? player.fishDex : {};
  const dexEntry = fishDex[fishEntry.id] && typeof fishDex[fishEntry.id] === "object" ? fishDex[fishEntry.id] : {};
  const inventoryCount = Math.max(0, Math.floor(Number(player.inventory?.[fishEntry.id] || 0)));
  const count = Math.max(0, Math.floor(Number(dexEntry.count || 0)), inventoryCount);
  const heaviestWeight = Math.max(0, Number(dexEntry.heaviestWeight || 0));
  return { count, heaviestWeight, caught: count > 0 || heaviestWeight > 0 };
}

function getLuckScoreFishPool(guildId = "") {
  return guildId ? getAvailableFish(guildId) : gameData.fish;
}

function findFishEntryByRecord(record, guildId = "") {
  const fishId = String(record?.fishId || "").trim();
  const fishName = String(record?.name || "").trim();
  return getLuckScoreFishPool(guildId).find((fishEntry) => fishEntry.id === fishId || fishEntry.name === fishName) || null;
}

function makeLuckiestFishRecord(fishEntry) {
  return {
    fishId: fishEntry.id,
    name: fishEntry.name,
    luckScale: Number(fishEntry.luckScale || 0),
    score: formatFishLuckScore(fishEntry)
  };
}

function refreshPlayerLuckiestFish(player, guildId = "") {
  if (!player || typeof player !== "object") {
    return null;
  }
  const candidates = getLuckScoreFishPool(guildId).filter((fishEntry) => getFishDexEntry(player, fishEntry).caught);
  const storedFishEntry = findFishEntryByRecord(player.luckiestFish, guildId);
  if (storedFishEntry && !candidates.some((fishEntry) => fishEntry.id === storedFishEntry.id)) {
    candidates.push(storedFishEntry);
  }
  const luckiestFish = candidates
    .map(makeLuckiestFishRecord)
    .sort((a, b) => b.score - a.score || b.luckScale - a.luckScale || a.name.localeCompare(b.name))[0] || null;
  player.luckiestFish = luckiestFish;
  return luckiestFish;
}

function countCaughtFishTypes(player, guildId = "") {
  return getAvailableFish(guildId).filter((fishEntry) => getFishDexEntry(player, fishEntry).caught).length;
}

function getShowcasedFish(player, guildId = "") {
  const showcasedFishId = String(player.showcasedFishId || "").trim();
  if (!showcasedFishId) {
    return null;
  }
  const fishEntry = getAvailableFish(guildId).find((entry) => entry.id === showcasedFishId);
  return fishEntry && getFishDexEntry(player, fishEntry).caught ? fishEntry : null;
}

function makeProfileEmbed(user, player) {
  const rod = getRod(player.rodId);
  const level = getLevel(player.exp);
  const nextExp = expForLevel(level);
  const heaviestFish = player.heaviestFish;
  const heaviestFishEntry = heaviestFish
    ? gameData.fish.find((fishEntry) => fishEntry.id === heaviestFish.fishId || fishEntry.name === heaviestFish.name)
    : null;
  const heaviestText = heaviestFish
    ? `${heaviestFish.name} - ${formatKg(heaviestFish.weight)}`
    : "Belum ada";
  const progressBar = makeProgressBar(player.progress, rod?.speed || 1);
  const voiceTime = formatDurationIndonesian(Number(player.voiceTotalMs || 0) + getCurrentVoiceSessionMs(user.id));
  const embed = new EmbedBuilder()
    .setColor(0x2ecc71)
    .setTitle(`${user.username} · Level ${level}`)
    .addFields(
      { name: "EXP", value: `${player.exp}/${nextExp}`, inline: true },
      { name: "Gold", value: `${player.gold}`, inline: true },
      { name: "Pancingan", value: rod?.name || "No rod found", inline: true },
      { name: "Voice", value: voiceTime, inline: true },
      { name: "Total Ikan Ditangkap", value: `${Math.max(0, Number(player.totalFishCaught || 0))}`, inline: false },
      { name: "Ikan Terberat", value: heaviestText, inline: false },
      { name: "Fishing Progress", value: `${progressBar} ${player.progress}/${rod?.speed || "?"}`, inline: false }
    );

  const icon = heaviestFishEntry ? makeIconAttachment(heaviestFishEntry, "fish") : null;
  if (icon) {
    embed.setThumbnail(icon.url);
  }

  return { embed, files: icon?.attachment ? [icon.attachment] : [] };
}

function makeFishCompRoleRow(member = null, fishCompRoleOverride = null) {
  if (!member?.guild) {
    return [];
  }
  const role = findFishCompRole(member.guild);
  const hasRole = typeof fishCompRoleOverride === "boolean"
    ? fishCompRoleOverride
    : role ? member.roles.cache.has(role.id) : false;
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId("fishcomp_role_toggle")
        .setLabel(hasRole ? "Remove FishComp Role" : "Get FishComp Role")
        .setStyle(hasRole ? ButtonStyle.Secondary : ButtonStyle.Primary)
    )
  ];
}

function makeProfileRodOptions(player) {
  const ownedRodIds = new Set(Array.isArray(player.ownedRods) ? player.ownedRods : []);
  return gameData.rods
    .filter((rod) => ownedRodIds.has(rod.id))
    .slice(0, 25)
    .map((rod) => ({
      label: truncateText(rod.name, 100),
      description: truncateText(`${rod.rarity || "Common"} · Speed ${rod.speed} · Luck ${rod.luck} · Max ${rod.maxWeight || "?"} kg · Acc ${rod.accuracy ?? 50}%`, 100),
      value: rod.id,
      default: rod.id === player.rodId
    }));
}

function makeProfileFishBagOptions(player) {
  const ownedFishBagIds = new Set(Array.isArray(player.ownedFishBags) ? player.ownedFishBags : []);
  return gameData.fishBags
    .filter((bag) => ownedFishBagIds.has(bag.id))
    .slice(0, 25)
    .map((bag) => ({
      label: truncateText(bag.name, 100),
      description: truncateText(`${bag.rarity || "Common"} · Capacity ${bag.spaceKg || 0} kg`, 100),
      value: bag.id,
      default: bag.id === player.fishBagId
    }));
}

function makeProfileComponents(player, member = null, fishCompRoleOverride = null) {
  const components = [];
  const rodOptions = makeProfileRodOptions(player);
  if (rodOptions.length) {
    components.push(
      new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId("profile_rod_select")
          .setPlaceholder("Pilih pancingan aktif")
          .addOptions(rodOptions)
      )
    );
  }
  const fishBagOptions = makeProfileFishBagOptions(player);
  if (fishBagOptions.length) {
    components.push(
      new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId("profile_fishbag_select")
          .setPlaceholder("Pilih tas pancing aktif")
          .addOptions(fishBagOptions)
      )
    );
  }
  components.push(...makeFishCompRoleRow(member, fishCompRoleOverride));
  return components;
}

function makeProfileMessage(user, player, member = null, guildId = "", fishCompRoleOverride = null) {
  const rod = getRod(player.rodId);
  const fishBag = getFishBag(player.fishBagId);
  const level = getLevel(player.exp);
  const nextExp = expForLevel(level);
  const heaviestFish = player.heaviestFish;
  const heaviestFishEntry = heaviestFish
    ? gameData.fish.find((fishEntry) => fishEntry.id === heaviestFish.fishId || fishEntry.name === heaviestFish.name)
    : null;
  const heaviestText = heaviestFish
    ? `${heaviestFish.name} - ${formatKg(heaviestFish.weight)}`
    : "Belum ada";
  const progressBar = makeProgressBar(player.progress, rod?.speed || 1);
  const voiceTime = formatDurationIndonesian(Number(player.voiceTotalMs || 0) + getCurrentVoiceSessionMs(user.id));
  const availableFishCount = getAvailableFish(guildId).length;
  const caughtFishTypes = countCaughtFishTypes(player, guildId);
  const showcasedFishEntry = getShowcasedFish(player, guildId);
  const profileFishIconEntry = showcasedFishEntry || heaviestFishEntry;
  const icon = profileFishIconEntry ? makeIconAttachment(profileFishIconEntry, "fish") : null;
  const profileText = [
    `## ${user.username} · Level ${level}`,
    "",
    `**EXP:** ${player.exp}/${nextExp} · **Gold:** ${player.gold}`,
    `**Pancingan:** ${rod?.name || "No rod found"} · **Voice:** ${voiceTime}`,
    `**Total Ikan:** ${Math.max(0, Number(player.totalFishCaught || 0))}`,
    `**Jenis Ikan Tertangkap:** ${caughtFishTypes}/${availableFishCount}`,
    `**Ikan Terberat:** ${heaviestText}`,
    `**Progress:** ${progressBar} ${player.progress}/${rod?.speed || "?"}`
  ].join("\n");
  const container = new ContainerBuilder().setAccentColor(0x2ecc71);
  if (icon) {
    container.addSectionComponents(
      new SectionBuilder()
        .addTextDisplayComponents(makeTextDisplay(profileText))
        .setThumbnailAccessory(new ThumbnailBuilder().setURL(icon.url))
    );
  } else {
    container.addTextDisplayComponents(makeTextDisplay(profileText));
  }
  const components = makeProfileComponents(player, member, fishCompRoleOverride);
  if (components.length) {
    container.addSeparatorComponents(new SeparatorBuilder());
    let renderedFishBagSelect = false;
    for (const component of components) {
      const row = component.toJSON?.() || {};
      const customId = row.components?.[0]?.custom_id || "";
      if (customId === "fishcomp_role_toggle" && !renderedFishBagSelect && gameData.fishBags.length) {
        container.addTextDisplayComponents(makeTextDisplay("**Tas Pancing dipakai**\nBelum ada tas pancing yang bisa dipakai."));
        renderedFishBagSelect = true;
      }
      if (customId === "profile_rod_select") {
        container.addTextDisplayComponents(makeTextDisplay("**Pancing dipakai**"));
      }
      if (customId === "profile_fishbag_select") {
        container.addTextDisplayComponents(makeTextDisplay("**Tas Pancing dipakai**"));
        renderedFishBagSelect = true;
      }
      container.addActionRowComponents(component);
    }
    if (!renderedFishBagSelect && gameData.fishBags.length) {
      container.addTextDisplayComponents(makeTextDisplay("**Tas Pancing dipakai**\nBelum ada tas pancing yang bisa dipakai."));
    }
  }
  return makeComponentsV2Message([container], {
    files: icon?.attachment ? [icon.attachment] : []
  });
}

function getHeaviestFishEntry(player, guildId = "") {
  const heaviestFish = player?.heaviestFish;
  if (!heaviestFish) {
    return null;
  }
  return getAvailableFish(guildId).find((fishEntry) => fishEntry.id === heaviestFish.fishId || fishEntry.name === heaviestFish.name)
    || gameData.fish.find((fishEntry) => fishEntry.id === heaviestFish.fishId || fishEntry.name === heaviestFish.name)
    || null;
}

function getLuckiestFishEntry(player, guildId = "") {
  const luckiestFish = player?.luckiestFish;
  if (!luckiestFish) {
    return null;
  }
  return getAvailableFish(guildId).find((fishEntry) => fishEntry.id === luckiestFish.fishId || fishEntry.name === luckiestFish.name)
    || gameData.fish.find((fishEntry) => fishEntry.id === luckiestFish.fishId || fishEntry.name === luckiestFish.name)
    || null;
}

function getFishShowoffFish(player, guildId = "") {
  return getShowcasedFish(player, guildId)
    || getHeaviestFishEntry(player, guildId)
    || getLuckiestFishEntry(player, guildId)
    || null;
}

async function makeFishShowoffMessage(user, player, member = null, guildId = "") {
  const rod = getRod(player.rodId);
  const level = getLevel(player.exp);
  const nextExp = expForLevel(level);
  const heaviestFish = player.heaviestFish;
  const heaviestText = heaviestFish
    ? `${heaviestFish.name} - ${formatKg(heaviestFish.weight)}`
    : "Belum ada";
  const selectedFish = getFishShowoffFish(player, guildId);
  const selectedFishDexEntry = selectedFish ? getFishDexEntry(player, selectedFish) : null;
  const displayName = truncateText(member?.displayName || user.globalName || user.displayName || user.username, 28);
  const avatarUrl = member?.displayAvatarURL?.({ extension: "png", size: 512 })
    || user.displayAvatarURL?.({ extension: "png", size: 512 })
    || player.discordAvatarUrl
    || "";
  const selectedFishLuckScore = selectedFish ? formatFishLuckScore(selectedFish) : "";
  const imageTrace = {};
  const banner = await makeFishShowoffBanner({
    avatarUrl,
    fish: selectedFish,
    imageTrace,
    stats: {
      displayName,
      level,
      exp: Math.max(0, Number(player.exp || 0)),
      nextExp,
      gold: Math.max(0, Number(player.gold || 0)),
      totalFishCaught: Math.max(0, Number(player.totalFishCaught || 0)),
      caughtFishTypes: countCaughtFishTypes(player, guildId),
      availableFishCount: getAvailableFish(guildId).length,
      fishName: selectedFish?.name || "",
      fishRarity: selectedFish?.rarity || "",
      fishMaxWeight: selectedFishDexEntry?.caught ? formatKg(selectedFishDexEntry.heaviestWeight) : "",
      fishLuckScore: selectedFishLuckScore,
      heaviestText,
      rodName: rod?.name || ""
    }
  });
  console.info(`${displayName} is showing off ${selectedFish?.name || "no fish"}, image used is <${imageTrace.name || "placeholder fish icon"}><${imageTrace.url || "no image URL"}>${imageTrace.error ? `, error is <${imageTrace.error}>` : ""}`);
  const fileName = `fishshowoff-${user.id}.png`;
  return {
    content: `## ${formatDiscordMention(user.id)} Ingin Pamer!`,
    allowedMentions: { users: [user.id] },
    files: [new AttachmentBuilder(banner, { name: fileName })]
  };
}

function getRandomFishDescription(caughtFish) {
  const descriptions = Array.isArray(caughtFish.descriptions)
    ? caughtFish.descriptions.map((description) => String(description || "").trim()).filter(Boolean)
    : [];
  const pool = descriptions.length ? descriptions : String(caughtFish.description || "").split(/\r?\n/).map((description) => description.trim()).filter(Boolean);
  return pool.length ? pool[Math.floor(Math.random() * pool.length)] : "";
}

function makeCatchEmbed(user, caughtFish, catchWeight, expGain, expBase = expGain, expEventInfo = null) {
  const description = getRandomFishDescription(caughtFish);
  const descriptionLine = description ? `\n${description}` : "";
  const bonusLine = formatBonusNotice("EXP", expEventInfo, expGain, expBase);
  const luckScore = formatFishLuckScore(caughtFish);
  const embed = new EmbedBuilder()
    .setColor(rarityColors[caughtFish.rarity] || 0x2ecc71)
    .setTitle("Umpan Disambar!")
    .setDescription(
      [
        `**${caughtFish.name}** berhasil ditangkap!!`,
        "",
        `Kelangkaan: **${caughtFish.rarity}**`,
        `Berat: **${formatKg(catchWeight)}**`,
        `Luck Score: **${luckScore}**`,
        `Exp: **+${formatRewardWithBonus(expGain, expBase, "EXP")}**`,
        bonusLine,
        descriptionLine.trim()
      ].filter(Boolean).join("\n")
    );

  const icon = makeIconAttachment(caughtFish, "fish");
  if (icon) {
    embed.setThumbnail(icon.url);
  }

  return { embed, files: icon?.attachment ? [icon.attachment] : [] };
}

function getUserMentionForMessage(user, options = {}) {
  const suffix = options.enforced ? ", hasil dari sedekah atmin" : "";
  if (user?.id) {
    return { content: `### 🎣 Tangkapan baru untuk ${formatDiscordMention(user.id)}${suffix}!\n\n`, allowedMentions: { users: [user.id] } };
  }
  const mention = String(user || "").match(/^<@!?(\d+)>$/);
  if (mention) {
    return { content: `### 🎣 Tangkapan baru untuk ${formatDiscordMention(mention[1])}${suffix}!\n\n`, allowedMentions: { users: [mention[1]] } };
  }
  return { content: "" };
}

function getCatchOwnerId(user) {
  if (user?.id) {
    return String(user.id);
  }
  const mention = String(user || "").match(/^<@!?(\d+)>$/);
  return mention ? mention[1] : "";
}

function makeCatchShareRow(user) {
  const ownerId = getCatchOwnerId(user);
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`catch_showcase:${ownerId || "unknown"}`)
      .setLabel("Pamerkan")
      .setStyle(ButtonStyle.Primary)
  );
}

function makeCatchMessage(user, caughtFish, catchWeight, expGain, options = {}) {
  const catchEmbed = makeCatchEmbed(user, caughtFish, catchWeight, expGain, options.expBase ?? expGain, options.expEventInfo || null);
  const mention = getUserMentionForMessage(user, options);
  return makeEmbedPanelMessage(catchEmbed.embed, {
    prefix: mention.content,
    allowedMentions: mention.allowedMentions,
    files: catchEmbed.files,
    components: [makeCatchShareRow(user)]
  });
}

function makeLevelUpEmbed(user, level, member = null) {
  const avatarUrl = member?.displayAvatarURL?.({ size: 128 }) || user.displayAvatarURL?.({ size: 128 }) || "";
  const embed = new EmbedBuilder()
    .setColor(0x36c28a)
    .setTitle(`Selamat ${member?.displayName || user.username}!`)
    .setDescription(`Sekarang memancing level **${level}**!`);
  if (avatarUrl) {
    embed.setThumbnail(avatarUrl);
  }
  return embed;
}

function getFishDailyWindowStartAt(timestamp = Date.now()) {
  const date = new Date(timestamp);
  date.setHours(fishDailyResetHour, 0, 0, 0);
  const noonToday = date.getTime();
  return timestamp >= noonToday ? noonToday : noonToday - fishDailyWindowMs;
}

function getFishDailyWindowIndex(timestamp = Date.now()) {
  return Math.floor(getFishDailyWindowStartAt(timestamp) / fishDailyWindowMs);
}

function getFishDailyNextAvailableAt(player, now = Date.now()) {
  const lastClaimedAt = Math.max(0, Number(player?.dailyLastClaimedAt || 0));
  if (lastClaimedAt <= 0) return 0;

  const lastClaimedWindow = getFishDailyWindowIndex(lastClaimedAt);
  const currentWindow = getFishDailyWindowIndex(now);
  if (lastClaimedWindow < currentWindow) return 0;

  return getFishDailyWindowStartAt(now) + fishDailyWindowMs;
}

function isFishDailyAvailable(player, now = Date.now()) {
  const nextAvailableAt = getFishDailyNextAvailableAt(player, now);
  return nextAvailableAt <= 0 || now >= nextAvailableAt;
}

function claimFishDailyReward(player, now = Date.now()) {
  const nextAvailableAt = getFishDailyNextAvailableAt(player, now);
  if (nextAvailableAt > 0 && now < nextAvailableAt) {
    return { ok: false, remainingMs: nextAvailableAt - now, nextAvailableAt };
  }

  const lastClaimedAt = Math.max(0, Number(player.dailyLastClaimedAt || 0));
  const oldStreak = Math.max(0, Math.floor(Number(player.dailyStreak || 0)));
  const currentWindow = getFishDailyWindowIndex(now);
  const lastClaimedWindow = lastClaimedAt > 0 ? getFishDailyWindowIndex(lastClaimedAt) : null;
  const nextStreak = lastClaimedWindow === currentWindow - 1
    ? oldStreak + 1
    : 1;
  const rewardGold = 35 * nextStreak;
  const goldBefore = Math.max(0, Math.floor(Number(player.gold || 0)));

  player.gold = goldBefore + rewardGold;
  player.dailyLastClaimedAt = now;
  player.dailyStreak = nextStreak;

  return {
    ok: true,
    rewardGold,
    streak: nextStreak,
    goldBefore,
    goldAfter: player.gold,
    nextAvailableAt: getFishDailyWindowStartAt(now) + fishDailyWindowMs
  };
}

function makeFishDailyResultMessage(result) {
  if (!result.ok) {
    return makeSimplePanelMessage(
      "Fish Daily",
      `Hadiah harianmu belum siap. Coba lagi dalam **${formatDurationIndonesian(result.remainingMs)}**.`,
      0xf1c40f
    );
  }

  return makeSimplePanelMessage(
    "Fish Daily",
    [
      `Kamu mendapat **${result.rewardGold} Gold**.`,
      `Daily streak: **${result.streak}**`,
      `Gold: **${result.goldBefore} -> ${result.goldAfter}**`,
      "",
      "Hadiah berikutnya tersedia setelah reset jam **12:00**."
    ].join("\n"),
    0x2ecc71
  );
}

async function replyWithFishDaily(interaction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  let claimResult = null;
  await withPlayer(interaction.user, async (player) => {
    claimResult = claimFishDailyReward(player);
    return claimResult.ok ? undefined : { save: false };
  });
  await interaction.editReply(makeFishDailyResultMessage(claimResult));
}

function getPublicImageUrl(value) {
  const url = String(value || "").trim();
  return /^https?:\/\//i.test(url) ? url : "";
}

function makeEventImage(event) {
  const imageUrl = getPublicImageUrl(event?.bannerUrl);
  if (imageUrl) {
    return { url: imageUrl, attachment: null };
  }

  const image = parseDataImage(event?.bannerBase64);
  if (!image) {
    return null;
  }
  const fileName = `event-banner.${image.extension}`;
  return {
    attachment: new AttachmentBuilder(image.buffer, { name: fileName }),
    url: `attachment://${fileName}`
  };
}

function makeEventEmbed(event) {
  const typeLines = normalizeEventBonuses(event).map((bonus) => ({
    gold_multiplier: `Gold ${formatEventMultiplier(bonus.value)}`,
    exp_multiplier: `EXP ${formatEventMultiplier(bonus.value)}`,
    fish_chance: `${bonus.fishId || "Ikan tertentu"} chance ${formatEventMultiplier(bonus.value)}`,
    fishing_speed: `Fishing speed ${formatEventMultiplier(bonus.value)}`
  }[bonus.type] || `Multiplier ${formatEventMultiplier(bonus.value)}`)).join("\n");
  const endsAt = event.endsAt ? `<t:${Math.floor(Date.parse(event.endsAt) / 1000)}:R>` : "Belum ditentukan";
  const description = [
    event.description || "",
    `Bonus:\n**${typeLines || "Tidak ada"}**`,
    `Berakhir: **${endsAt}**`
  ].filter(Boolean).join("\n\n");
  const embed = new EmbedBuilder()
    .setColor(0xf39c12)
    .setTitle(event.title || "Event Dimulai!")
    .setDescription(description);
  const banner = makeEventImage(event);
  if (banner?.url) {
    embed.setImage(banner.url);
  }
  return { embed, files: banner?.attachment ? [banner.attachment] : [] };
}

function makeEventEndedEmbed(event) {
  const embed = new EmbedBuilder()
    .setColor(0x95a5a6)
    .setTitle(event.title || "Event")
    .setDescription("Event ini sudah berakhir, terima kasih untuk yang sudah berpartisipasi");
  const banner = makeEventImage(event);
  if (banner?.url) {
    embed.setImage(banner.url);
  }
  return { embed, files: banner?.attachment ? [banner.attachment] : [] };
}

function makeRoutineImage(routine) {
  const imageUrl = getPublicImageUrl(routine?.bannerUrl);
  if (imageUrl) {
    return { url: imageUrl, attachment: null };
  }

  const image = parseDataImage(routine?.bannerBase64);
  if (!image) {
    return null;
  }
  const fileName = `routine-message-banner.${image.extension}`;
  return {
    attachment: new AttachmentBuilder(image.buffer, { name: fileName }),
    url: `attachment://${fileName}`
  };
}

function parseRoutineColor(value) {
  const color = String(value || "").trim().replace(/^#/, "");
  return /^[0-9a-f]{6}$/i.test(color) ? Number.parseInt(color, 16) : 0x36c28a;
}

function makeRoutineButtonStyle(style) {
  return {
    Primary: ButtonStyle.Primary,
    Secondary: ButtonStyle.Secondary,
    Success: ButtonStyle.Success,
    Danger: ButtonStyle.Danger
  }[String(style || "Primary")] || ButtonStyle.Primary;
}

function pickRoutineMessageVariant(routine) {
  const variants = (Array.isArray(routine.messageVariants) ? routine.messageVariants : [])
    .filter((variant) => variant && (variant.title || variant.description));
  if (!variants.length) {
    return {
      title: routine.title || routine.name || "Routine Message",
      description: routine.description || ""
    };
  }
  const variant = variants[Math.floor(Math.random() * variants.length)];
  return {
    title: variant.title || routine.title || routine.name || "Routine Message",
    description: variant.description || routine.description || ""
  };
}

function makeRoutineMessage(routine) {
  const message = pickRoutineMessageVariant(routine);
  const embed = new EmbedBuilder()
    .setColor(parseRoutineColor(routine.color))
    .setTitle(message.title);
  if (message.description) {
    embed.setDescription(message.description);
  }
  const banner = makeRoutineImage(routine);
  if (banner?.url) {
    embed.setImage(banner.url);
  }

  const buttons = (Array.isArray(routine.buttons) ? routine.buttons : []).slice(0, 25);
  const components = [];
  for (let index = 0; index < buttons.length; index += 5) {
    components.push(new ActionRowBuilder().addComponents(
      buttons.slice(index, index + 5).map((button) => new ButtonBuilder()
        .setCustomId(`routine:${routine.id}:${button.id || index}`)
        .setLabel(String(button.label || button.action || "Open").slice(0, 80))
        .setStyle(makeRoutineButtonStyle(button.style)))
    ));
  }

  return makeEmbedPanelMessage(embed, {
    files: banner?.attachment ? [banner.attachment] : [],
    components
  });
}

function makeSettingsImage(baseKey, fallbackBaseKey = "") {
  const settings = getSettings();
  const imageUrl = getPublicImageUrl(settings[`${baseKey}Url`]) || getPublicImageUrl(fallbackBaseKey ? settings[`${fallbackBaseKey}Url`] : "");
  if (imageUrl) {
    return { url: imageUrl, attachment: null };
  }

  const image = parseDataImage(settings[`${baseKey}Base64`]) || parseDataImage(fallbackBaseKey ? settings[`${fallbackBaseKey}Base64`] : "");
  if (!image) {
    return null;
  }

  const fileName = `${baseKey.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}.${image.extension}`;
  return {
    attachment: new AttachmentBuilder(image.buffer, { name: fileName }),
    url: `attachment://${fileName}`
  };
}

function makeFishCompImage(status = "registration") {
  const bannerKey = {
    registration: "fishCompRegistrationBanner",
    closed: "fishCompRegistrationBanner",
    running: "fishCompRunningBanner",
    result: "fishCompResultBanner"
  }[status] || "fishCompRegistrationBanner";
  return makeSettingsImage(bannerKey, "fishCompBanner");
}

function makeFishRaidImage(status = "registration", boss = null) {
  const bossKey = {
    registration: "registrationBanner",
    closed: "registrationBanner",
    running: "runningBanner",
    result: "resultBanner",
    fulfilled: "fulfilledBanner",
    failed: "failedBanner"
  }[status] || "registrationBanner";
  const bossImageUrl = getPublicImageUrl(boss?.[`${bossKey}Url`]);
  if (bossImageUrl) {
    return { url: bossImageUrl, attachment: null };
  }
  const bossImage = parseDataImage(boss?.[`${bossKey}Base64`]);
  if (bossImage) {
    const fileName = `fish-raid-${bossKey.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}.${bossImage.extension}`;
    return {
      attachment: new AttachmentBuilder(bossImage.buffer, { name: fileName }),
      url: `attachment://${fileName}`
    };
  }

  return null;
}

function makeFishDuelImage(status = "registration") {
  const bannerKey = {
    registration: "fishDuelRegistrationBanner",
    closed: "fishDuelRegistrationBanner",
    running: "fishDuelRunningBanner",
    result: "fishDuelResultBanner"
  }[status] || "fishDuelRegistrationBanner";
  return makeSettingsImage(bannerKey);
}

function makeMessageWithBanner(embed, banner) {
  if (banner?.url) {
    embed.setImage(banner.url);
  }
  return {
    embeds: [embed],
    files: banner?.attachment ? [banner.attachment] : []
  };
}

function formatGoldAmount(value) {
  return `${Math.max(0, Math.floor(Number(value || 0))).toLocaleString("id-ID")} Gold`;
}

function formatEventMultiplier(value) {
  const percent = Math.max(0, Number(value || 0) * 100);
  const rounded = Math.round(percent * 100) / 100;
  return `x${rounded.toLocaleString("id-ID", { maximumFractionDigits: 2 })}%`;
}

function formatRewardAmount(value, unit) {
  const amount = Math.max(0, Math.round(Number(value || 0)));
  if (unit === "Gold") {
    return formatGoldAmount(amount);
  }
  return `${amount.toLocaleString("id-ID")} ${unit}`;
}

function formatRewardWithBonus(total, base, unit) {
  const safeTotal = Math.max(0, Math.round(Number(total || 0)));
  const safeBase = Math.max(0, Math.round(Number(base || 0)));
  const bonus = safeTotal - safeBase;
  const totalText = formatRewardAmount(safeTotal, unit);
  if (bonus === 0) {
    return totalText;
  }
  const sign = bonus > 0 ? "+" : "-";
  return `${totalText} (${sign}${formatRewardAmount(Math.abs(bonus), unit)})`;
}

function formatBonusNotice(label, eventInfo, total = null, base = null) {
  if (!eventInfo?.active) {
    return "";
  }
  if (total !== null && base !== null && Math.round(Number(total || 0)) === Math.round(Number(base || 0))) {
    return "";
  }
  return `-# *Bonus ${label} aktif: ${formatEventMultiplier(eventInfo.multiplier)}!*`;
}

function describeEventBonus(bonus) {
  return {
    gold_multiplier: `Gold ${formatEventMultiplier(bonus.value)}`,
    exp_multiplier: `EXP ${formatEventMultiplier(bonus.value)}`,
    fish_chance: `${bonus.fishId || "Ikan tertentu"} chance ${formatEventMultiplier(bonus.value)}`,
    fishing_speed: `Fishing speed ${formatEventMultiplier(bonus.value)}`
  }[bonus.type] || `Multiplier ${formatEventMultiplier(bonus.value)}`;
}

async function makeServerStatusMessage(guild) {
  const records = await loadAdminPlayersSafely();
  const totalCaught = records.reduce((sum, record) => sum + Math.max(0, Number(record.player?.totalFishCaught || 0)), 0);
  const biggest = records
    .map((record) => ({ record, fish: record.player?.heaviestFish || null }))
    .filter((entry) => entry.fish)
    .sort((a, b) => Number(b.fish.weight || 0) - Number(a.fish.weight || 0))[0];
  const activeEvents = getActiveEvents(guild?.id || "");
  const buffs = activeEvents.flatMap((event) => normalizeEventBonuses(event).map((bonus) => {
    const endsAt = event.endsAt ? ` sampai <t:${Math.floor(Date.parse(event.endsAt) / 1000)}:R>` : "";
    return `**${event.title}** - ${describeEventBonus(bonus)}${endsAt}`;
  }));
  const birthday = guild?.createdTimestamp ? `<t:${Math.floor(guild.createdTimestamp / 1000)}:D>` : "Tidak diketahui";
  const biggestText = biggest
    ? `${biggest.fish.name || "-"} - **${formatKg(biggest.fish.weight || 0)}** oleh ${getLeaderboardName(biggest.record)}`
    : "Belum ada";
  const embed = new EmbedBuilder()
    .setColor(0x36c28a)
    .setTitle("TRFishing · Server Status")
    .setDescription([
      "# Server Status",
      "Ringkasan aktivitas memancing di server ini.",
      "",
      "## Statistik",
      `Fisher terdaftar: **${records.length}**`,
      `Total ikan tertangkap: **${totalCaught}**`,
      `Ikan terbesar server: ${biggestText}`,
      "",
      "## Buff Aktif",
      buffs.length ? buffs.join("\n") : "Tidak ada buff aktif.",
      "",
      "## Server Birthday",
      birthday
    ].join("\n"));
  return { embeds: [embed] };
}

async function loadAdminPlayersSafely(search = "", options = {}) {
  try {
    return await adminListPlayers(search, options);
  } catch (error) {
    console.error("Could not load admin player list:", error);
    return [];
  }
}

async function loadLeaderboardPlayersSafely(forceRefresh = false) {
  const now = Date.now();
  if (!forceRefresh && leaderboardCache.records.length && now - leaderboardCache.loadedAt < leaderboardCacheTtlMs) {
    return leaderboardCache.records;
  }
  const records = (await loadAdminPlayersSafely("", { preferIndex: true })).map((record) => {
    refreshPlayerLuckiestFish(record.player);
    return record;
  });
  leaderboardCache = { records, loadedAt: Date.now() };
  return records;
}

function formatDiscordMention(userId) {
  return `<@${userId}>`;
}

function findFishCompRole(guild) {
  return guild?.roles?.cache?.find((role) => role.name === "FishComp") || null;
}

async function ensureFishCompRole(guild) {
  if (!guild) {
    return null;
  }

  const existingRole = findFishCompRole(guild);
  if (existingRole) {
    if (!existingRole.mentionable && guild.members.me?.permissions.has(PermissionFlagsBits.ManageRoles)) {
      await existingRole.edit({ mentionable: true }, "TRFishing FishComp role ping").catch(() => {});
    }
    return existingRole;
  }

  if (!guild.members.me?.permissions.has(PermissionFlagsBits.ManageRoles)) {
    return null;
  }

  return guild.roles.create({
    name: "FishComp",
    color: 0xf1c40f,
    mentionable: true,
    reason: "TRFishing competition notification role"
  }).catch((error) => {
    console.error(`Could not create FishComp role for guild ${guild.id}:`, error);
    return null;
  });
}

async function ensureFishCompRolesForGuilds() {
  for (const guild of client.guilds.cache.values()) {
    await ensureFishCompRole(guild);
  }
}

async function hydrateEventGuild(event) {
  if (!event?.announcementChannelId || event.guildId) {
    return;
  }

  const channel = await client.channels.fetch(event.announcementChannelId).catch((error) => {
    console.error(`Could not fetch event announcement channel ${event.announcementChannelId} for event ${event.id || event.title || "unknown"}:`, error);
    return null;
  });
  if (channel?.guildId) {
    event.guildId = channel.guildId;
    await markEventGuild(event.id, channel.guildId);
  }
}

async function announceActiveEvent() {
  for (const event of getEvents().filter(isEventRunning)) {
    await hydrateEventGuild(event);
    if (!event?.announcementChannelId || !event.deployedAt || event.isAnnounced || isEventAnnouncementLocallyMarked(event, "start")) {
      continue;
    }

    const channel = await client.channels.fetch(event.announcementChannelId).catch((error) => {
      console.error(`Could not fetch event announcement channel ${event.announcementChannelId} for event ${event.id || event.title || "unknown"}:`, error);
      return null;
    });
    if (!channel?.isTextBased()) {
      console.warn(`Event ${event.id || event.title || "unknown"} announcement channel ${event.announcementChannelId} is not available or is not text based.`);
      continue;
    }

    if (!event.guildId && channel.guildId) {
      event.guildId = channel.guildId;
      await markEventGuild(event.id, channel.guildId);
    }

    const eventMessage = makeEventEmbed(event);
    try {
      logBotAction("Event start announcement sending", {
        guild: guildLogName(channel, event.guildId),
        channel: channelLogName(channel),
        extra: `event=${event.id || event.title || "unknown"}`
      });
      await channel.send({ embeds: [eventMessage.embed], files: eventMessage.files });
    } catch (error) {
      console.error(`Could not send announcement for event ${event.id || event.title || "unknown"} to channel ${event.announcementChannelId}: ${error.message}`);
      continue;
    }
    logBotAction("Event start announcement sent", {
      guild: guildLogName(channel, event.guildId),
      channel: channelLogName(channel),
      extra: `event=${event.id || event.title || "unknown"}`
    });
    markEventAnnouncementLocal(event, "start", event.guildId || channel.guildId || "", channel.id);
    await markEventAnnounced(event.id, event.guildId || channel.guildId || "");
  }
}

async function markEventGuild(eventId, guildId = "") {
  const selectedEventId = String(eventId || "");
  const selectedGuildId = String(guildId || "");
  if (!selectedEventId || !selectedGuildId) {
    return;
  }

  const applyGuildMark = (event) => (
    event?.id === selectedEventId && !event.guildId
      ? { ...event, guildId: selectedGuildId }
      : event
  );

  gameData = {
    ...gameData,
    activeEvent: gameData.activeEvent ? applyGuildMark(gameData.activeEvent) : null,
    events: getEvents().map(applyGuildMark)
  };

  await adminSaveGameData(gameData);
}

async function markEventAnnounced(eventId, guildId = "") {
  const selectedEventId = String(eventId || "");
  const applyAnnouncementMark = (event) => (
    event?.id === selectedEventId
      ? { ...event, guildId: event.guildId || guildId, isAnnounced: true }
      : event
  );

  gameData = {
    ...gameData,
    activeEvent: gameData.activeEvent ? applyAnnouncementMark(gameData.activeEvent) : null,
    events: getEvents().map(applyAnnouncementMark)
  };

  await adminSaveGameData(gameData);
}

async function announceEndedEvents() {
  for (const event of getEvents().filter(isEventEnded)) {
    const endedAt = getEventEndedAt(event);
    if (endedAt < processStartedAt || isEventAnnouncementLocallyMarked(event, "end")) {
      continue;
    }

    const channel = await client.channels.fetch(event.announcementChannelId).catch(() => null);
    if (!channel?.isTextBased()) {
      continue;
    }

    if (!event.guildId && channel.guildId) {
      event.guildId = channel.guildId;
    }

    const eventMessage = makeEventEndedEmbed(event);
    logBotAction("Event end announcement sending", {
      guild: guildLogName(channel, event.guildId),
      channel: channelLogName(channel),
      extra: `event=${event.id || event.title || "unknown"}`
    });
    await channel.send({ embeds: [eventMessage.embed], files: eventMessage.files });
    logBotAction("Event end announcement sent", {
      guild: guildLogName(channel, event.guildId),
      channel: channelLogName(channel),
      extra: `event=${event.id || event.title || "unknown"}`
    });
    markEventAnnouncementLocal(event, "end", event.guildId || channel.guildId || "", channel.id);
  }
}

async function announceEventUpdates() {
  await announceActiveEvent();
  await announceEndedEvents();
  scheduleNextEventAnnouncement();
}

function getRoutineMessages() {
  return Array.isArray(gameData.routineMessages) ? gameData.routineMessages : [];
}

function getRoutineGuildIds(routine) {
  const guildId = String(routine.guildId || "").trim();
  if (guildId) {
    return [guildId];
  }
  return [...defaultFishingChannels.keys()];
}

function routineTriggerKey(routine, guildId, now = new Date()) {
  const condition = routine.condition || {};
  if (condition.type === "fishraid_cooldown_ready") {
    const state = normalizeDailyRaidState(guildId);
    const cooldownMs = Math.max(0, Number(getSettings().fishRaidCooldownMinutes ?? 60)) * 60_000;
    return `${guildId}:fishraid_cooldown_ready:${Number(state.lastRaidEndedAt || 0) + cooldownMs}`;
  }
  if (condition.type === "daily_time") {
    return `${guildId}:${getLocalDateKey(now)}:${condition.time || "00:00"}`;
  }
  if (condition.type === "specific_datetime") {
    return `${guildId}:${condition.dateTime || ""}`;
  }
  return `${guildId}:${Math.floor(now.getTime() / 60_000)}`;
}

function getRoutineGuildState(routine, guildId) {
  const state = routine.lastSentByGuild && typeof routine.lastSentByGuild === "object" ? routine.lastSentByGuild[guildId] : null;
  return state && typeof state === "object" ? state : {};
}

function isRoutineDueForGuild(routine, guildId, now = new Date()) {
  if (routine.enabled === false) {
    return false;
  }

  const condition = routine.condition || {};
  const nowMs = now.getTime();
  const guildState = getRoutineGuildState(routine, guildId);
  const lastSentMs = Date.parse(guildState.lastSentAt || routine.lastSentAt || 0) || 0;
  if (condition.type === "fishraid_cooldown_ready") {
    const state = normalizeDailyRaidState(guildId);
    if (fishRaids.has(guildId) || state.fulfilledAt || !Number(state.lastRaidEndedAt || 0)) {
      return false;
    }
    return getRaidCooldownRemainingMs(guildId) <= 0
      && guildState.lastTriggerKey !== routineTriggerKey(routine, guildId, now);
  }
  if (condition.type === "interval") {
    return !lastSentMs || nowMs - lastSentMs >= Math.max(1, Number(condition.intervalMinutes || 60)) * 60_000;
  }
  if (condition.type === "idle_since_activity") {
    const idleMs = Math.max(1, Number(condition.idleMinutes || 120)) * 60_000;
    const lastActivityAt = guildActivity.get(guildId) || processStartedAt;
    return nowMs - lastActivityAt >= idleMs
      && (!lastSentMs || nowMs - lastSentMs >= idleMs);
  }
  if (condition.type === "specific_datetime") {
    return Boolean(condition.dateTime) && nowMs >= Date.parse(condition.dateTime) && !lastSentMs;
  }

  const [hourText, minuteText] = String(condition.time || "00:00").split(":");
  const dueHour = Number(hourText);
  const dueMinute = Number(minuteText);
  return now.getHours() === dueHour
    && now.getMinutes() === dueMinute
    && guildState.lastTriggerKey !== routineTriggerKey(routine, guildId, now);
}

async function markRoutineSent(routineId, guildId, triggerKey) {
  const sentAt = new Date().toISOString();
  const applyMark = (routine) => {
    if (routine?.id !== routineId) {
      return routine;
    }
    return {
      ...routine,
      lastSentAt: sentAt,
      lastTriggerKey: triggerKey,
      lastSentByGuild: {
        ...(routine.lastSentByGuild || {}),
        [guildId]: { lastSentAt: sentAt, lastTriggerKey: triggerKey }
      }
    };
  };
  gameData = {
    ...gameData,
    routineMessages: getRoutineMessages().map(applyMark)
  };
  await adminSaveGameData(gameData);
}

async function processRoutineMessages() {
  if (!client.isReady()) {
    return;
  }

  const now = new Date();
  for (const routine of getRoutineMessages()) {
    for (const guildId of getRoutineGuildIds(routine)) {
      if (!isRoutineDueForGuild(routine, guildId, now)) {
        continue;
      }
      const triggerKey = routineTriggerKey(routine, guildId, now);
      if (isRoutineLocallyMarked(routine.id, guildId, triggerKey)) {
        continue;
      }
      const channel = await fetchRoutineMessageChannel(routine, guildId);
      if (!channel?.isTextBased?.()) {
        continue;
      }
      let sent = false;
      logBotAction("Routine message sending", {
        guild: guildLogName(channel, guildId),
        channel: channelLogName(channel),
        extra: `routine=${routine.id || routine.name || "unknown"} trigger=${triggerKey}`
      });
      await channel.send(makeRoutineMessage(routine)).then(() => {
        sent = true;
        logBotAction("Routine message sent", {
          guild: guildLogName(channel, guildId),
          channel: channelLogName(channel),
          extra: `routine=${routine.id || routine.name || "unknown"} trigger=${triggerKey}`
        });
        markRoutineLocal(routine.id, guildId, triggerKey, channel.id);
      }).catch((error) => {
        console.error(`Could not send routine message ${routine.id || routine.name || "unknown"} to channel ${channel.id}: ${error.message}`);
      });
      if (!sent) {
        continue;
      }
      await markRoutineSent(routine.id, guildId, triggerKey);
    }
  }
}

function scheduleRoutineMessages() {
  clearInterval(routineMessageTimer);
  routineMessageTimer = setInterval(() => {
    processRoutineMessages().catch((error) => console.error("Could not process routine messages:", error));
  }, 60_000);
}

async function hydrateActiveEventGuilds() {
  for (const event of getEvents().filter(isEventRunning)) {
    await hydrateEventGuild(event);
  }
}

let signalRefreshTimer = null;

function scheduleSignalRefresh() {
  clearTimeout(signalRefreshTimer);
  signalRefreshTimer = setTimeout(() => {
    refreshGameData("manager config refresh signal")
      .then(() => Promise.all([announceEventUpdates(), processRoutineMessages()]))
      .catch((error) => console.error("Could not refresh PlayFab config from manager signal:", error));
  }, 500);
}

function watchManagerConfigSignal() {
  fs.mkdirSync(runtimeDirectory, { recursive: true });
  if (!fs.existsSync(configSignalPath)) {
    fs.writeFileSync(configSignalPath, JSON.stringify({ updatedAt: new Date().toISOString() }));
  }

  fs.watch(configSignalPath, scheduleSignalRefresh);
  console.log("Watching manager config refresh signal.");
}

async function processEnforcedFishingSignal() {
  if (!fs.existsSync(enforcedFishingSignalPath)) {
    return;
  }

  const request = JSON.parse(fs.readFileSync(enforcedFishingSignalPath, "utf8"));
  if (!request?.id || processedEnforcedFishingIds.has(request.id)) {
    return;
  }
  processedEnforcedFishingIds.add(request.id);
  const catches = Array.isArray(request.catches) && request.catches.length ? request.catches : [request];
  logBotAction("Enforce Fishing signal received", {
    guildId: request.guildId || catches[0]?.guildId,
    channelId: request.channelId || catches[0]?.channelId,
    extra: `catches=${catches.length}`
  });
  for (const entry of catches) {
    if (!entry.fish?.id || !entry.discordUserId || !entry.channelId) {
      console.warn("Could not post enforced fishing catch: signal payload is incomplete.");
      continue;
    }

    const channel = await fetchFishingMessageChannel(null, String(entry.guildId || "")) || await client.channels.fetch(String(entry.channelId || "")).catch(() => null);
    if (!channel?.isTextBased?.()) {
      console.warn("Could not post enforced fishing catch: channel is not available.");
      continue;
    }
    if (entry.guildId && channel.guildId && entry.guildId !== channel.guildId) {
      console.warn("Could not post enforced fishing catch: channel guild does not match saved player guild.");
      continue;
    }

    logBotAction("Enforce Fishing sending Discord popup", {
      user: entry.discordUserId,
      guild: guildLogName(channel, entry.guildId),
      channel: channelLogName(channel),
      extra: `fish=${entry.fish.name || entry.fish.id}`
    });
    const mention = `<@${entry.discordUserId}>`;
    await channel.send(makeCatchMessage(mention, entry.fish, entry.catchWeight, entry.expGain, {
      enforced: true,
      expBase: entry.expBase,
      expEventInfo: entry.expEventInfo
    })).then(() => {
      logBotAction("Enforce Fishing Discord popup sent", {
        user: entry.discordUserId,
        guild: guildLogName(channel, entry.guildId),
        channel: channelLogName(channel),
        extra: `fish=${entry.fish.name || entry.fish.id}`
      });
    }).catch((error) => {
      console.error(`Could not post enforced fishing catch for ${entry.discordUserId} in channel ${entry.channelId}: ${error.message}`);
    });
  }
  fs.writeFileSync(enforcedFishingSignalPath, JSON.stringify({ id: "", processedAt: new Date().toISOString(), processedId: request.id }));
}

async function processGiveMoneySignal() {
  if (!fs.existsSync(giveMoneySignalPath)) {
    return;
  }

  const request = JSON.parse(fs.readFileSync(giveMoneySignalPath, "utf8"));
  if (!request?.id || processedGiveMoneyIds.has(request.id)) {
    return;
  }
  processedGiveMoneyIds.add(request.id);
  if (!request.discordUserId || !request.channelId || Number(request.amount || 0) <= 0) {
    console.warn("Could not post give money message: signal payload is incomplete.");
    return;
  }

  const channel = await fetchFishingMessageChannel(null, String(request.guildId || "")) || await client.channels.fetch(String(request.channelId || "")).catch(() => null);
  if (!channel?.isTextBased?.()) {
    console.warn("Could not post give money message: channel is not available.");
    return;
  }
  if (request.guildId && channel.guildId && request.guildId !== channel.guildId) {
    console.warn("Could not post give money message: channel guild does not match saved player guild.");
    return;
  }

  const amount = Math.max(0, Math.floor(Number(request.amount || 0)));
  await channel.send({
    content: `## Atmin telah memberikan sedekah kepada <@${request.discordUserId}> sebesar ${amount} Gold.\n-# *Jangan lupa bilang terima kasih ya wahai anak muda.*`,
    allowedMentions: { users: [String(request.discordUserId)] }
  });
  fs.writeFileSync(giveMoneySignalPath, JSON.stringify({ id: "", processedAt: new Date().toISOString(), processedId: request.id }));
}

async function fetchRaidAnnouncementChannel(state, channelId = "") {
  const selectedChannelId = String(channelId || state?.channelId || "").trim();
  if (!selectedChannelId) {
    return null;
  }
  const channel = await client.channels.fetch(selectedChannelId).catch(() => null);
  return channel?.isTextBased?.() ? channel : null;
}

function makeFishRaidFulfilledMessage(state, forced = false) {
  const dailyResults = getSortedRaidResults(Object.values(state.participants || {}));
  const embed = new EmbedBuilder()
    .setColor(0x2ecc71)
    .setTitle(forced ? "Fish Raid · Quota Dipenuhi Admin" : "Fish Raid · Quota Terpenuhi")
    .setDescription([
      `Boss: **${state.boss?.name || "Raid Boss"}**`,
      formatRaidQuotaLine(state),
      "",
      "**Ranking Harian**",
      dailyResults.length ? dailyResults.map((result, index) => `${index + 1}. ${formatCompetitionResultLine(result)}`).join("\n") : "Belum ada peserta.",
      "",
      forced ? "Quota hari ini sudah ditandai terpenuhi oleh admin." : "Quota hari ini sudah terpenuhi."
    ].join("\n"));
  const banner = makeFishRaidImage("fulfilled", state.boss);
  return makeMessageWithBanner(embed, banner);
}

function makeFishRaidFailedMessage(state) {
  const dailyResults = getSortedRaidResults(Object.values(state.participants || {}));
  const embed = new EmbedBuilder()
    .setColor(0xe74c3c)
    .setTitle("Fish Raid Gagal")
    .setDescription([
      "Waktu sudah lewat 00:00 dan quota raid belum terpenuhi.",
      "",
      `Boss: **${state.boss?.name || "Raid Boss"}**`,
      formatRaidQuotaLine(state),
      "",
      "**Kontribusi Harian**",
      dailyResults.length ? dailyResults.map((result, index) => `${index + 1}. ${formatCompetitionResultLine(result)}`).join("\n") : "Belum ada peserta.",
      "",
      "Raid hari ini gagal. Boss dan quota akan direset untuk hari baru."
    ].join("\n"));
  const banner = makeFishRaidImage("failed", state.boss);
  return makeMessageWithBanner(embed, banner);
}

async function resetTodayFishRaid(guildId, channelId = "", reason = "manual") {
  const activeRaid = fishRaids.get(guildId);
  if (activeRaid) {
    await cancelCompetition(activeRaid, "Raid direset oleh admin.");
  }
  const previousState = dailyFishRaids.get(guildId) || null;
  dailyFishRaids.delete(guildId);
  const nextState = normalizeDailyRaidState(guildId);
  nextState.channelId = String(channelId || previousState?.channelId || "").trim();
  saveFishRaidState();
  return { previousState, nextState, reason };
}

async function forceClearFishRaid(guildId, channelId = "") {
  const state = normalizeDailyRaidState(guildId);
  state.filledKg = Math.max(1, Number(state.quotaKg || 1));
  state.fulfilledAt = new Date().toISOString();
  state.channelId = String(channelId || state.channelId || "").trim();
  saveFishRaidState();
  const channel = await fetchRaidAnnouncementChannel(state, channelId);
  if (channel) {
    await channel.send(makeFishRaidFulfilledMessage(state, true)).catch((error) => {
      console.error("Could not post forced fish raid clear message:", error);
    });
  }
}

function resetFishRaidCooldown(guildId, channelId = "") {
  const state = normalizeDailyRaidState(guildId);
  state.lastRaidEndedAt = 0;
  state.channelId = String(channelId || state.channelId || "").trim();
  saveFishRaidState();
}

async function processFishRaidSignal() {
  if (!fs.existsSync(fishRaidSignalPath)) {
    return;
  }

  const request = JSON.parse(fs.readFileSync(fishRaidSignalPath, "utf8"));
  if (!request?.id || processedFishRaidSignalIds.has(request.id)) {
    return;
  }
  processedFishRaidSignalIds.add(request.id);
  const guildId = String(request.guildId || "").trim();
  if (!guildId) {
    console.warn("Could not process fish raid signal: missing guild ID.");
    return;
  }

  if (request.action === "reset") {
    await resetTodayFishRaid(guildId, request.channelId || "", "manager");
  } else if (request.action === "force_clear") {
    await forceClearFishRaid(guildId, request.channelId || "");
  } else if (request.action === "reset_cooldown") {
    resetFishRaidCooldown(guildId, request.channelId || "");
  }
  fs.writeFileSync(fishRaidSignalPath, JSON.stringify({ id: "", processedAt: new Date().toISOString(), processedId: request.id }));
}

async function processFishRaidMidnightReset() {
  const today = getLocalDateKey();
  for (const [guildId, state] of [...dailyFishRaids.entries()]) {
    if (!state?.dateKey || state.dateKey === today) {
      continue;
    }
    const hadActivity = Number(state.filledKg || 0) > 0 || Object.keys(state.participants || {}).length > 0 || Number(state.lastRaidEndedAt || 0) > 0;
    if (!state.fulfilledAt && hadActivity) {
      const channel = await fetchRaidAnnouncementChannel(state);
      if (channel) {
        await channel.send(makeFishRaidFailedMessage(state)).catch((error) => {
          console.error("Could not post fish raid failed message:", error);
        });
      }
    }
    dailyFishRaids.delete(guildId);
  }
  saveFishRaidState();
}

function scheduleEnforcedFishingSignal() {
  clearTimeout(enforcedFishingTimer);
  enforcedFishingTimer = setTimeout(() => {
    processEnforcedFishingSignal()
      .catch((error) => console.error("Could not post enforced fishing catch from manager signal:", error));
  }, 250);
}

function scheduleGiveMoneySignal() {
  clearTimeout(giveMoneyTimer);
  giveMoneyTimer = setTimeout(() => {
    processGiveMoneySignal()
      .catch((error) => console.error("Could not post give money message from manager signal:", error));
  }, 250);
}

function scheduleFishRaidSignal() {
  clearTimeout(fishRaidSignalTimer);
  fishRaidSignalTimer = setTimeout(() => {
    processFishRaidSignal()
      .catch((error) => console.error("Could not process fish raid manager signal:", error));
  }, 250);
}

function scheduleFishRaidMidnightReset() {
  clearTimeout(fishRaidMidnightTimer);
  const now = new Date();
  const nextMidnight = new Date(now);
  nextMidnight.setDate(now.getDate() + 1);
  nextMidnight.setHours(0, 0, 0, 0);
  fishRaidMidnightTimer = setTimeout(() => {
    processFishRaidMidnightReset()
      .catch((error) => console.error("Could not process fish raid midnight reset:", error))
      .finally(scheduleFishRaidMidnightReset);
  }, Math.max(1000, nextMidnight.getTime() - now.getTime()));
}

function watchEnforcedFishingSignal() {
  fs.mkdirSync(runtimeDirectory, { recursive: true });
  if (!fs.existsSync(enforcedFishingSignalPath)) {
    fs.writeFileSync(enforcedFishingSignalPath, JSON.stringify({ id: "", createdAt: new Date().toISOString() }));
  }

  fs.watch(enforcedFishingSignalPath, scheduleEnforcedFishingSignal);
  console.log("Watching manager enforced fishing signal.");
}

function watchGiveMoneySignal() {
  fs.mkdirSync(runtimeDirectory, { recursive: true });
  if (!fs.existsSync(giveMoneySignalPath)) {
    fs.writeFileSync(giveMoneySignalPath, JSON.stringify({ id: "", createdAt: new Date().toISOString() }));
  }

  fs.watch(giveMoneySignalPath, scheduleGiveMoneySignal);
  console.log("Watching manager give money signal.");
}

function watchFishRaidSignal() {
  fs.mkdirSync(runtimeDirectory, { recursive: true });
  if (!fs.existsSync(fishRaidSignalPath)) {
    fs.writeFileSync(fishRaidSignalPath, JSON.stringify({ id: "", createdAt: new Date().toISOString() }));
  }

  fs.watch(fishRaidSignalPath, scheduleFishRaidSignal);
  console.log("Watching manager fish raid signal.");
}

function makeInventoryEmbed(user, player, guildId = "") {
  const lines = gameData.fish
    .map((fishEntry) => [fishEntry, player.inventory[fishEntry.id] || 0])
    .filter(([, quantity]) => quantity > 0)
    .map(([fishEntry, quantity]) => formatInventoryFishLine(fishEntry, quantity));
  const { baseGold, totalGold, goldEventInfo } = calculateInventorySellGold(player, guildId);
  const goldSummary = [
    `Gold kamu sekarang: **${formatGoldAmount(player.gold)}**`,
    `Kalau jual semua ikan: **${formatRewardWithBonus(totalGold, baseGold, "Gold")}**`,
    formatBonusNotice("Gold", goldEventInfo, totalGold, baseGold)
  ].filter(Boolean);

  return new EmbedBuilder()
    .setColor(0x3498db)
    .setTitle(`${user.username}'s Fish Inventory`)
    .setDescription([
      lines.length ? lines.join("\n\n") : "Inventory ikan kamu kosong.",
      goldSummary.join("\n")
    ].join("\n\n"));
}

function makeStoreEmbed(player, status = "") {
  const statusLine = status ? `\n\n${status}` : "";
  const storeImageUrl = getPublicImageUrl(getSettings().rodStoreImageUrl);
  const fishBag = getFishBag(player.fishBagId);
  return new EmbedBuilder()
    .setColor(0xf1c40f)
    .setTitle("Toko Pancingan")
    .setDescription(`Gold kamu: **${player.gold}**\nPancingan sekarang: **${getRod(player.rodId)?.name || "Belum ada"}**\nTas pancing sekarang: **${fishBag?.name || "Belum ada"}**${fishBag ? ` (${formatKg(getEffectiveFishBagCapacity(player))} Capacity)` : ""}${statusLine}`)
    .setImage(storeImageUrl || (getSettings().rodStoreImageBase64 ? "attachment://rod-store-custom.png" : "attachment://rod-store.svg"));
}

function makeRodStoreImageAttachment(player) {
  if (getPublicImageUrl(getSettings().rodStoreImageUrl)) {
    return null;
  }

  const customImage = parseDataImage(getSettings().rodStoreImageBase64);
  if (customImage) {
    return new AttachmentBuilder(customImage.buffer, { name: "rod-store-custom.png" });
  }

  const width = 900;
  const columns = 5;
  const cardWidth = 164;
  const cardHeight = 164;
  const gap = 12;
  const items = [
    ...gameData.rods.map((item) => ({ ...item, storeType: "rod" })),
    ...gameData.fishBags.map((item) => ({ ...item, storeType: "fishBag" }))
  ];
  const rows = Math.max(1, Math.ceil(items.length / columns));
  const height = 24 + rows * cardHeight + (rows - 1) * gap + 24;
  const cards = items.map((item, index) => {
    const x = 24 + (index % columns) * (cardWidth + gap);
    const y = 24 + Math.floor(index / columns) * (cardHeight + gap);
    const isBag = item.storeType === "fishBag";
    const owned = isBag ? (player.ownedFishBags || []).includes(item.id) : player.ownedRods.includes(item.id);
    const equipped = isBag ? player.fishBagId === item.id : player.rodId === item.id;
    const status = equipped ? "Equipped" : owned ? "Owned" : `${item.price} gold`;
    const icon = makeIconAttachment(item, isBag ? "fish-bag" : "rod");
    const image = icon
      ? `<image href="${escapeXml(icon.url)}" x="${x + 46}" y="${y + 16}" width="72" height="72" preserveAspectRatio="xMidYMid meet" />`
      : `<rect x="${x + 46}" y="${y + 16}" width="72" height="72" rx="10" fill="#30323a" /><text x="${x + 82}" y="${y + 59}" text-anchor="middle" font-size="16" font-weight="700" fill="#f1c40f">${isBag ? "BAG" : "ROD"}</text>`;
    const statLine = isBag ? `Capacity ${item.spaceKg || 0} kg` : `SPD ${item.speed} · LUCK ${item.luck}`;
    return `
      <rect x="${x}" y="${y}" width="${cardWidth}" height="${cardHeight}" rx="8" fill="#272933" stroke="#444755" />
      ${image}
      <text x="${x + 12}" y="${y + 108}" font-size="16" font-weight="700" fill="#ffffff">${escapeXml(truncateText(item.name, 18))}</text>
      <text x="${x + 12}" y="${y + 128}" font-size="12" fill="#f1c40f">${escapeXml(item.rarity || "Common")} · ${isBag ? "Bag" : "Rod"}</text>
      <text x="${x + 12}" y="${y + 145}" font-size="13" fill="#c9cad3">${escapeXml(statLine)}</text>
      <text x="${x + 12}" y="${y + 160}" font-size="13" fill="${equipped ? "#36c28a" : owned ? "#86a8ff" : "#f1c40f"}">${escapeXml(status)}</text>
    `;
  }).join("");
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
      <rect width="100%" height="100%" fill="#1f2130" />
      ${cards}
    </svg>
  `;

  return {
    attachment: Buffer.from(svg),
    name: "rod-store.svg"
  };
}

function makeRodSelectOptions(player) {
  return [...gameData.rods]
    .sort((left, right) => Number(left.price || 0) - Number(right.price || 0) || left.name.localeCompare(right.name))
    .slice(0, 25)
    .map((rod) => {
    const owned = player.ownedRods.includes(rod.id);
    const equipped = player.rodId === rod.id;
    const status = equipped ? "[Equipped]" : owned ? "[Owned]" : "";
    const price = owned ? "-" : `${rod.price} gold`;
    return {
      label: truncateText(`${rod.name} ${status}`.trim(), 100),
      description: truncateText(`${rod.rarity || "Common"} · Speed ${rod.speed} · Luck ${rod.luck} · Max ${rod.maxWeight || "?"} kg · Acc ${rod.accuracy ?? 50}% · Price ${price}`, 100),
      value: rod.id
    };
    });
}

function makeFishBagSelectOptions(player) {
  return [...gameData.fishBags]
    .sort((left, right) => Number(left.price || 0) - Number(right.price || 0) || left.name.localeCompare(right.name))
    .slice(0, 25)
    .map((bag) => {
    const owned = (player.ownedFishBags || []).includes(bag.id);
    const equipped = player.fishBagId === bag.id;
    const status = equipped ? "[Equipped]" : owned ? "[Owned]" : "";
    const price = owned ? "-" : `${bag.price} gold`;
    return {
      label: truncateText(`${bag.name} ${status}`.trim(), 100),
      description: truncateText(`${bag.rarity || "Common"} · Capacity ${bag.spaceKg || 0} kg · Price ${price}`, 100),
      value: bag.id
    };
    });
}

function makeStoreComponents(player, selectedRodId = null, selectedFishBagId = null) {
  const selectedRod = gameData.rods.find((rod) => rod.id === selectedRodId) || gameData.rods[0];
  const selectedFishBag = gameData.fishBags.find((bag) => bag.id === selectedFishBagId) || gameData.fishBags[0];
  const owned = selectedRod ? player.ownedRods.includes(selectedRod.id) : false;
  const equipped = selectedRod ? player.rodId === selectedRod.id : false;
  const rodSelect = new StringSelectMenuBuilder()
    .setCustomId(`rod_select:${selectedRod?.id || ""}`)
    .setPlaceholder("Pilih pancingan")
    .addOptions(makeRodSelectOptions(player).map((option) => ({
      ...option,
      default: option.value === selectedRod?.id
    })));
  const button = new ButtonBuilder()
    .setCustomId(`rod_buy:${selectedRod?.id || ""}`)
    .setLabel(equipped ? "Equipped" : owned ? "Equip" : "Buy")
    .setStyle(owned ? ButtonStyle.Primary : ButtonStyle.Success)
    .setDisabled(!selectedRod || equipped);
  const components = [
    new ActionRowBuilder().addComponents(rodSelect),
    new ActionRowBuilder().addComponents(button)
  ];

  if (gameData.fishBags.length) {
    const bagOwned = selectedFishBag ? (player.ownedFishBags || []).includes(selectedFishBag.id) : false;
    const bagEquipped = selectedFishBag ? player.fishBagId === selectedFishBag.id : false;
    const bagSelect = new StringSelectMenuBuilder()
      .setCustomId(`fishbag_select:${selectedFishBag?.id || ""}`)
      .setPlaceholder("Pilih tas pancing")
      .addOptions(makeFishBagSelectOptions(player).map((option) => ({
        ...option,
        default: option.value === selectedFishBag?.id
      })));
    const bagButton = new ButtonBuilder()
      .setCustomId(`fishbag_buy:${selectedFishBag?.id || ""}`)
      .setLabel(bagEquipped ? "Equipped" : bagOwned ? "Equip Fish Bag" : "Buy Fish Bag")
      .setStyle(bagOwned ? ButtonStyle.Primary : ButtonStyle.Success)
      .setDisabled(!selectedFishBag || bagEquipped);
    components.push(new ActionRowBuilder().addComponents(bagSelect));
    components.push(new ActionRowBuilder().addComponents(bagButton));
  }
  return components;
}

function makeStoreMessage(player, selectedRodId = null, status = "", selectedFishBagId = null) {
  const imageAttachment = makeRodStoreImageAttachment(player);
  const components = makeStoreComponents(player, selectedRodId, selectedFishBagId);
  const componentBlocks = gameData.fishBags.length
    ? [
      { text: "**Pancingan**", components: components.slice(0, 2) },
      { text: "**Tas Pancing**", components: components.slice(2) }
    ]
    : [{ text: "**Pancingan**", components }];
  return makeEmbedPanelMessage(makeStoreEmbed(player, status), {
    files: imageAttachment ? [imageAttachment] : [],
    componentBlocks
  });
}

const fishDexPageSize = 25;
const unknownFishName = "????????";
const unknownFishValue = "??????";

function getFishDexPageCount(guildId = "") {
  return Math.max(1, Math.ceil(getAvailableFish(guildId).length / fishDexPageSize));
}

function getFishDexPageFish(guildId = "", page = 0) {
  const pageCount = getFishDexPageCount(guildId);
  const selectedPage = Math.max(0, Math.min(pageCount - 1, Number(page) || 0));
  const availableFish = getAvailableFish(guildId);
  return {
    page: selectedPage,
    pageCount,
    fish: availableFish.slice(selectedPage * fishDexPageSize, (selectedPage + 1) * fishDexPageSize),
    totalFish: availableFish.length
  };
}

function makeFishDexEmbed(user, player, selectedFishId = "", guildId = "", page = 0) {
  const pageData = getFishDexPageFish(guildId, page);
  const selectedFish = getAvailableFish(guildId).find((fishEntry) => fishEntry.id === selectedFishId)
    || pageData.fish[0]
    || null;
  const dexEntry = selectedFish ? getFishDexEntry(player, selectedFish) : null;
  const caught = Boolean(dexEntry?.caught);
  const caughtTypes = countCaughtFishTypes(player, guildId);
  const color = selectedFish && caught ? rarityColors[selectedFish.rarity] || 0x3498db : 0x5865f2;
  const name = selectedFish && caught ? selectedFish.name : unknownFishName;
  const description = selectedFish && caught
    ? getRandomFishDescription(selectedFish) || selectedFish.description || "-"
    : unknownFishValue;
  const embed = new EmbedBuilder()
    .setColor(color)
    .setTitle(`${user.username}'s Fishdex`)
    .setDescription([
      `Jenis ikan tertangkap: **${caughtTypes}/${pageData.totalFish}**`,
      "",
      `**${name}**`,
      description
    ].join("\n"))
    .addFields(
      { name: "Rarity", value: selectedFish?.rarity || "-", inline: true },
      { name: "Caught", value: caught ? `${dexEntry.count}` : unknownFishValue, inline: true },
      { name: "Heaviest", value: caught ? formatKg(dexEntry.heaviestWeight) : unknownFishValue, inline: true },
      { name: "Sell Price", value: caught ? `${Number(selectedFish.gold || 0)} gold` : unknownFishValue, inline: true }
    );

  const icon = selectedFish && caught ? makeIconAttachment(selectedFish, "fish") : null;
  if (icon) {
    embed.setThumbnail(icon.url);
  }

  return { embed, files: icon?.attachment ? [icon.attachment] : [], page: pageData.page, pageCount: pageData.pageCount, selectedFish, caught };
}

function makeFishDexOptions(player, guildId = "", page = 0, selectedFishId = "") {
  const pageData = getFishDexPageFish(guildId, page);
  return pageData.fish.map((fishEntry) => {
    const dexEntry = getFishDexEntry(player, fishEntry);
    const caught = dexEntry.caught;
    return {
      label: truncateText(caught ? fishEntry.name : unknownFishName, 100),
      description: truncateText(`${fishEntry.rarity || "Common"}${caught ? ` · Caught ${dexEntry.count} · Best ${formatKg(dexEntry.heaviestWeight)}` : ""}`, 100),
      value: fishEntry.id,
      default: fishEntry.id === selectedFishId
    };
  });
}

function makeFishDexShowcaseButton(player, userId, page = 0, selectedFish = null, caught = false) {
  return new ButtonBuilder()
    .setCustomId(`fishdex_showcase:${userId}:${page}:${selectedFish?.id || "none"}`)
    .setLabel("Showcase This Fish")
    .setStyle(ButtonStyle.Primary)
    .setDisabled(!selectedFish?.id || !caught);
}

function makeFishDexComponents(player, userId, guildId = "", page = 0, selectedFishId = "") {
  const pageData = getFishDexPageFish(guildId, page);
  const options = makeFishDexOptions(player, guildId, pageData.page, selectedFishId);
  const components = { selectRow: null, pageText: "", buttonRow: null };
  if (options.length) {
    components.selectRow =
      new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId(`fishdex_select:${userId}:${pageData.page}`)
          .setPlaceholder("Pilih ikan")
          .addOptions(options)
      );
  }
  components.pageText = `Page **${pageData.page + 1}/${pageData.pageCount}**`;
  if (pageData.pageCount > 1) {
    components.buttonRow =
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`fishdex_page:${userId}:${Math.max(0, pageData.page - 1)}`)
          .setLabel("Previous")
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(pageData.page <= 0),
        new ButtonBuilder()
          .setCustomId(`fishdex_page:${userId}:${Math.min(pageData.pageCount - 1, pageData.page + 1)}`)
          .setLabel("Next")
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(pageData.page >= pageData.pageCount - 1)
      );
  }
  return components;
}

function makeFishDexMessage(user, player, selectedFishId = "", guildId = "", page = 0) {
  const fishDexEmbed = makeFishDexEmbed(user, player, selectedFishId, guildId, page);
  const data = fishDexEmbed.embed.toJSON();
  const container = new ContainerBuilder().setAccentColor(data.color || 0x5865f2);
  const mainText = formatEmbedMainText(data);
  if (data.thumbnail?.url) {
    container.addSectionComponents(
      new SectionBuilder()
        .addTextDisplayComponents(makeTextDisplay(mainText || "\u200b"))
        .setThumbnailAccessory(new ThumbnailBuilder().setURL(data.thumbnail.url))
    );
  } else {
    container.addTextDisplayComponents(makeTextDisplay(mainText || "\u200b"));
  }

  const fieldText = formatEmbedFields(data.fields);
  if (fieldText) {
    container.addTextDisplayComponents(makeTextDisplay(fieldText));
  }

  container.addSectionComponents(
    new SectionBuilder()
      .addTextDisplayComponents(makeTextDisplay("Profile Showcase"))
      .setButtonAccessory(makeFishDexShowcaseButton(player, user.id, fishDexEmbed.page, fishDexEmbed.selectedFish, fishDexEmbed.caught))
  );

  const controls = makeFishDexComponents(player, user.id, guildId, fishDexEmbed.page, fishDexEmbed.selectedFish?.id || "");
  if (controls.selectRow || controls.buttonRow) {
    container.addSeparatorComponents(new SeparatorBuilder());
    if (controls.selectRow) {
      container.addActionRowComponents(controls.selectRow);
    }
    container.addTextDisplayComponents(makeTextDisplay(controls.pageText));
    if (controls.buttonRow) {
      container.addActionRowComponents(controls.buttonRow);
    }
  }

  return makeComponentsV2Message([container], {
    files: fishDexEmbed.files
  });
}

function makeCompetitionEmbed(competition, status = "registration") {
  const startsAt = Math.floor(competition.startsAt / 1000);
  const isRaid = competition.mode === "raid";
  const isDuel = competition.mode === "duel";
  const raidState = isRaid ? normalizeDailyRaidState(competition.guildId) : null;
  const embed = new EmbedBuilder()
    .setColor(isDuel ? 0xf39c12 : isRaid ? 0x3ba1ff : 0xe67e22)
    .setTitle(isDuel ? "Duel Adu Dermawan!" : isRaid ? "Fish Raid" : "Kompetisi Memancing");

  if (status === "closed") {
    embed.setDescription(
      [
        "Registrasi sudah ditutup.",
        isDuel ? "Duel sedang disiapkan." : isRaid ? "Raid sedang disiapkan." : "Kompetisi sedang disiapkan."
      ].join("\n")
    );
    return embed;
  }

  if (status === "complete") {
    embed.setColor(0x2ecc71);
    embed.setDescription(
      [
        isDuel ? "Duel sudah selesai." : isRaid ? "Raid sudah selesai." : "Kompetisi sudah selesai.",
        isDuel ? "Hasil duel sudah keluar." : isRaid ? "Hasil raid sudah keluar." : "Hasil kompetisi sudah keluar."
      ].join("\n")
    );
    return embed;
  }

  const participants = listCompetitionParticipants(competition, true);
  const raidIntro = isRaid
    ? [
      `Boss: **${raidState.boss.name}**`,
      raidState.boss.description || "",
      formatRaidQuotaLine(raidState),
      ""
    ].filter(Boolean)
    : [];
  embed.setDescription(
    [
      ...(isDuel ? ["Siapa yang bisa membuat tas lawannya penuh lebih dahulu ialah yang lebih dermawan!", competition.betAmount > 0 ? `Taruhan: **${formatGoldAmount(competition.betAmount)}** per pemain` : "Tanpa taruhan", ""] : []),
      ...raidIntro,
      `Dimulai: <t:${startsAt}:R> · <t:${startsAt}:T>`,
      isDuel ? "Durasi: **sampai salah satu tas penuh**" : `Durasi: **${competition.turns} turn**`,
      `Peserta: **${competition.participants.size}/${competition.maxParticipants}**`,
      "",
      participants
    ].join("\n")
  );

  if (status === "running") {
    const scoreboard = formatCompetitionScoreboard(competition);
    const visibleLogs = Array.isArray(competition.visibleLogs) ? competition.visibleLogs : competition.logs;
    const recentLogs = formatCompetitionLogs(visibleLogs) || "Menunggu hasil...";
    embed.setDescription(
      [
        ...(isDuel ? ["Duel Adu Dermawan!", "Siapa yang bisa membuat tas lawannya penuh lebih dahulu ialah yang lebih dermawan!", ""] : []),
        ...(isRaid ? [`Boss: **${raidState.boss.name}**`, formatRaidQuotaLine({ ...raidState, filledKg: Math.min(raidState.quotaKg, Number(raidState.filledKg || 0) + Number(competition.raidGainedWeight || 0)) }), ""] : []),
        scoreboard || "Belum ada hasil.",
        "",
        isDuel ? "Duel sedang berjalan." : isRaid ? "Raid sedang berjalan." : "Kompetisi sedang berjalan.",
        isDuel ? `Ronde: **${competition.currentTurn}**` : `Turn: **${competition.currentTurn}/${competition.turns}**`,
        "",
        recentLogs
      ].join("\n")
    );
  }
  if (status !== "complete") {
    const banner = isDuel ? makeFishDuelImage(status) : isRaid ? makeFishRaidImage(status, raidState.boss) : makeFishCompImage(status);
    if (banner?.url) {
      embed.setImage(banner.url);
    }
  }
  return embed;
}

function makeCompetitionMessage(competition, status = "registration", components = []) {
  const embed = makeCompetitionEmbed(competition, status);
  const banner = status === "closed" || status === "complete"
    ? null
    : competition.mode === "duel" ? makeFishDuelImage(status) : competition.mode === "raid" ? makeFishRaidImage(status, normalizeDailyRaidState(competition.guildId).boss) : makeFishCompImage(status);
  return makeEmbedPanelMessage(embed, {
    files: banner?.attachment ? [banner.attachment] : [],
    components
  });
}

function formatCompetitionLogs(logs) {
  const recentLogs = logs.slice(-12);
  return recentLogs.reduce((lines, log, index) => {
    if (index > 0) {
      const previousTurn = recentLogs[index - 1].match(/^\[(\d+)\]/)?.[1];
      const currentTurn = log.match(/^\[(\d+)\]/)?.[1];
      if (previousTurn && currentTurn && previousTurn !== currentTurn) {
        lines.push("");
      }
    }
    lines.push(log);
    return lines;
  }, []).join("\n");
}

function formatCompetitionLogFileLines(competition) {
  const logs = competition.logs.length ? competition.logs : ["No battle log."];
  return logs.reduce((lines, log, index) => {
    if (index > 0) {
      const previousTurn = logs[index - 1].match(/^\[(\d+)\]/)?.[1];
      const currentTurn = log.match(/^\[(\d+)\]/)?.[1];
      if (previousTurn && currentTurn && previousTurn !== currentTurn) {
        lines.push("");
      }
    }
    lines.push(formatCompetitionLogForFile(competition, log));
    return lines;
  }, []);
}

function formatCompetitionLogForFile(competition, log) {
  return [...competition.participants.values()].reduce((text, participant) => {
    const readableName = getCompetitionLogName(participant);
    const mentionReplaced = text.replaceAll(formatDiscordMention(participant.id), readableName);
    return participant.logName && participant.logName !== readableName
      ? mentionReplaced.replaceAll(participant.logName, readableName)
      : mentionReplaced;
  }, log);
}

function shuffleList(items) {
  const shuffled = [...items];
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const targetIndex = Math.floor(Math.random() * (index + 1));
    [shuffled[index], shuffled[targetIndex]] = [shuffled[targetIndex], shuffled[index]];
  }
  return shuffled;
}

function shuffleCompetitionParticipants(participants) {
  return shuffleList(participants);
}

function getFishCompEvents(mode = "competition") {
  const settingsKey = mode === "duel" ? "fishDuelEvents" : mode === "raid" ? "fishRaidEvents" : "fishCompEvents";
  return (Array.isArray(getSettings()[settingsKey]) ? getSettings()[settingsKey] : [])
    .filter((event) => event && Number(event.chance || 0) > 0 && event.startText);
}

function formatCompEventText(template, participant, target = null) {
  return String(template || "")
    .replaceAll("{user}", participant.displayName)
    .replaceAll("{username}", participant.logName || participant.username || participant.displayName)
    .replaceAll("{target}", target?.displayName || "")
    .replaceAll("{targetname}", target?.logName || target?.username || target?.displayName || "");
}

function typeLuckModifier(type, value) {
  const modifier = Number(value || 0);
  if (type === "buff") {
    return Math.abs(modifier);
  }
  if (type === "debuff") {
    return -Math.abs(modifier);
  }
  return modifier;
}

function makeCompEventState(event, type, durationTurns, luckModifier, activeText, endText) {
  return {
    eventId: event.id,
    type,
    durationTurns: Math.max(1, Math.floor(Number(durationTurns || 1))),
    turnIndex: 1,
    luckModifier: typeLuckModifier(type, luckModifier),
    canFishWhileActive: event.canFishWhileActive !== false,
    canFishOnEnd: event.canFishOnEnd !== false,
    activeText: activeText || "",
    endText: endText || ""
  };
}

function pickCompetitionEvent(competition) {
  for (const event of shuffleList(getFishCompEvents(competition?.mode))) {
    if (Math.random() * 100 < Number(event.chance || 0)) {
      return event;
    }
  }
  return null;
}

function pickOtherParticipant(competition, participant) {
  const others = [...competition.participants.values()].filter((entry) => entry.id !== participant.id);
  return others.length ? others[Math.floor(Math.random() * others.length)] : null;
}

function applyExistingCompetitionEvents(competition, participant, turn) {
  const states = competition.eventStates.get(participant.id) || [];
  if (!states.length) {
    return { canFish: true, luckModifier: 0 };
  }

  let canFish = true;
  let luckModifier = 0;
  const remainingStates = [];
  for (const state of states) {
    state.turnIndex += 1;
    const isEnding = state.turnIndex >= state.durationTurns;
    const text = isEnding ? state.endText : state.activeText;
    if (text) {
      competition.logs.push(`[${turn}] ${formatCompEventText(text, participant)}`);
    }
    canFish = canFish && (isEnding ? state.canFishOnEnd : state.canFishWhileActive);
    luckModifier += Number(state.luckModifier || 0);
    if (!isEnding) {
      remainingStates.push(state);
    }
  }

  if (remainingStates.length) {
    competition.eventStates.set(participant.id, remainingStates);
  } else {
    competition.eventStates.delete(participant.id);
  }

  return { canFish, luckModifier };
}

function applyNewCompetitionEvent(competition, participant, turn) {
  const event = pickCompetitionEvent(competition);
  if (!event) {
    return { canFish: true, luckModifier: 0 };
  }

  competition.logs.push(`[${turn}] ${formatCompEventText(event.startText, participant)}`);
  const durationTurns = Math.max(1, Math.floor(Number(event.durationTurns || 1)));
  if (durationTurns > 1) {
    const states = competition.eventStates.get(participant.id) || [];
    states.push(makeCompEventState(event, event.type, durationTurns, event.luckModifier, event.activeText, event.endText));
    competition.eventStates.set(participant.id, states);
  }

  if (event.affectOther && Math.random() * 100 < Number(event.affectOtherChance ?? 100)) {
    const target = pickOtherParticipant(competition, participant);
    if (target) {
      if (event.otherStartText) {
        competition.logs.push(`[${turn}] ${formatCompEventText(event.otherStartText, participant, target)}`);
      }
      const targetState = makeCompEventState(
        event,
        event.otherType || event.type,
        event.otherDurationTurns || event.durationTurns,
        event.otherLuckModifier ?? event.luckModifier,
        event.otherActiveText || event.activeText,
        event.otherEndText || event.endText
      );
      const targetStates = competition.eventStates.get(target.id) || [];
      if (targetState.durationTurns > 1) {
        targetStates.push(targetState);
        competition.eventStates.set(target.id, targetStates);
      }
      competition.currentTurnEffects.set(target.id, {
        canFish: event.canFishOnStart !== false && targetState.type !== "stun",
        luckModifier: Number(targetState.luckModifier || 0),
        fromCurrentTurn: true
      });
    }
  }

  return {
    canFish: event.canFishOnStart !== false && event.type !== "stun",
    luckModifier: typeLuckModifier(event.type, event.luckModifier)
  };
}

function makeCompetitionJoinRow(disabled = false) {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId("fishcomp_join")
        .setLabel("Join")
        .setStyle(ButtonStyle.Success)
        .setDisabled(disabled),
      new ButtonBuilder()
        .setCustomId("fishcomp_leave")
        .setLabel("Leave")
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(disabled),
      new ButtonBuilder()
        .setCustomId("fishcomp_cancel")
        .setLabel("Cancel")
        .setStyle(ButtonStyle.Danger)
        .setDisabled(disabled)
    )
  ];
}

function makeFishRaidJoinRow(disabled = false) {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId("fishraid_join")
        .setLabel("Join Raid")
        .setStyle(ButtonStyle.Success)
        .setDisabled(disabled),
      new ButtonBuilder()
        .setCustomId("fishraid_cancel")
        .setLabel("Cancel")
        .setStyle(ButtonStyle.Danger)
        .setDisabled(disabled)
    )
  ];
}

function makeFishDuelAcceptRow(duelId, disabled = false) {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`fishduel_accept:${duelId}`)
        .setLabel("Accept")
        .setStyle(ButtonStyle.Success)
        .setDisabled(disabled),
      new ButtonBuilder()
        .setCustomId(`fishduel_decline:${duelId}`)
        .setLabel("Decline")
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(disabled)
    )
  ];
}

function makeOpenFishDuelRow(duelId, disabled = false) {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`fishduel_open_accept:${duelId}`)
        .setLabel("Terima")
        .setStyle(ButtonStyle.Success)
        .setDisabled(disabled),
      new ButtonBuilder()
        .setCustomId(`fishduel_open_cancel:${duelId}`)
        .setLabel("Batalkan")
        .setStyle(ButtonStyle.Danger)
        .setDisabled(disabled)
    )
  ];
}

function makeOpenFishDuelMessage(pending, components = makeOpenFishDuelRow(pending.id), status = "") {
  const embed = new EmbedBuilder()
    .setColor(0xf39c12)
    .setTitle("Duel Adu Dermawan!")
    .setDescription([
      `${formatDiscordMention(pending.creator.id)} membuka FishDuel untuk siapa saja yang merasa lebih dermawan darinya!`,
      "",
      "Siapa yang bisa membuat tas lawannya penuh lebih dahulu ialah yang lebih dermawan!",
      "",
      pending.betAmount > 0 ? `Taruhan: **${formatGoldAmount(pending.betAmount)}** per pemain` : "Tanpa taruhan gold.",
      status ? `\n${status}` : "",
      "",
      "Tekan **Terima** untuk melawan, atau pembuat duel bisa menekan **Batalkan**."
    ].filter((line) => line !== "").join("\n"));
  const banner = makeFishDuelImage("registration");
  if (banner?.url) {
    embed.setImage(banner.url);
  }
  return makeEmbedPanelMessage(embed, {
    files: banner?.attachment ? [banner.attachment] : [],
    components
  });
}

function makeCompetitionResultRow(logId) {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`fishcomp_history:${logId}`)
        .setLabel("📜 View Full History")
        .setStyle(ButtonStyle.Secondary)
    )
  ];
}

function makeFishRaidResultRow(logId) {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`fishraid_history:${logId}`)
        .setLabel("📜 View Full History")
        .setStyle(ButtonStyle.Secondary)
    )
  ];
}

function getLocalDateKey(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function loadFishRaidState() {
  fs.mkdirSync(runtimeDirectory, { recursive: true });
  if (!fs.existsSync(fishRaidStatePath)) {
    return;
  }
  try {
    const saved = JSON.parse(fs.readFileSync(fishRaidStatePath, "utf8"));
    const guilds = saved && typeof saved === "object" && !Array.isArray(saved) ? saved.guilds || saved : {};
    for (const [guildId, state] of Object.entries(guilds)) {
      if (state && typeof state === "object") {
        dailyFishRaids.set(guildId, state);
      }
    }
  } catch (error) {
    console.error("Could not read fish raid state:", error);
  }
}

function saveFishRaidState() {
  fs.mkdirSync(runtimeDirectory, { recursive: true });
  fs.writeFileSync(fishRaidStatePath, JSON.stringify({ guilds: Object.fromEntries(dailyFishRaids) }, null, 2));
}

function cleanRaidBosses() {
  const bosses = Array.isArray(getSettings().fishRaidBosses) ? getSettings().fishRaidBosses : [];
  const cleaned = bosses.map((boss, index) => {
    const source = boss && typeof boss === "object" ? boss : {};
    const id = String(source.id || `raid_boss_${index + 1}`).trim().toLowerCase().replace(/[^a-z0-9_]/g, "_");
    const name = String(source.name || source.title || id || `Raid Boss ${index + 1}`).trim();
    return {
      id,
      name,
      description: String(source.description || "").trim(),
      quotaKg: Math.max(1, Number(source.quotaKg || source.quota || getSettings().fishRaidDailyQuotaKg || 100)),
      registrationBannerBase64: String(source.registrationBannerBase64 || ""),
      registrationBannerUrl: String(source.registrationBannerUrl || "").trim(),
      registrationBannerRef: source.registrationBannerRef && typeof source.registrationBannerRef === "object" ? source.registrationBannerRef : null,
      runningBannerBase64: String(source.runningBannerBase64 || ""),
      runningBannerUrl: String(source.runningBannerUrl || "").trim(),
      runningBannerRef: source.runningBannerRef && typeof source.runningBannerRef === "object" ? source.runningBannerRef : null,
      resultBannerBase64: String(source.resultBannerBase64 || ""),
      resultBannerUrl: String(source.resultBannerUrl || "").trim(),
      resultBannerRef: source.resultBannerRef && typeof source.resultBannerRef === "object" ? source.resultBannerRef : null,
      fulfilledBannerBase64: String(source.fulfilledBannerBase64 || ""),
      fulfilledBannerUrl: String(source.fulfilledBannerUrl || "").trim(),
      fulfilledBannerRef: source.fulfilledBannerRef && typeof source.fulfilledBannerRef === "object" ? source.fulfilledBannerRef : null,
      failedBannerBase64: String(source.failedBannerBase64 || ""),
      failedBannerUrl: String(source.failedBannerUrl || "").trim(),
      failedBannerRef: source.failedBannerRef && typeof source.failedBannerRef === "object" ? source.failedBannerRef : null
    };
  }).filter((boss) => boss.id && boss.name);

  return cleaned.length ? cleaned : [
    { id: "big_order", name: "Big Fish Order", description: "Pesanan ikan besar hari ini sudah menunggu.", quotaKg: Math.max(1, Number(getSettings().fishRaidDailyQuotaKg || 100)) }
  ];
}

function pickDailyRaidBoss(dateKey, guildId) {
  const bosses = cleanRaidBosses();
  let seed = 0;
  for (const char of `${dateKey}:${guildId}`) {
    seed = (seed * 31 + char.charCodeAt(0)) >>> 0;
  }
  return bosses[seed % bosses.length];
}

function getRaidBossById(bossId) {
  return cleanRaidBosses().find((boss) => boss.id === bossId) || null;
}

function normalizeDailyRaidState(guildId) {
  const dateKey = getLocalDateKey();
  const current = dailyFishRaids.get(guildId);
  if (current?.dateKey === dateKey && current?.boss?.id) {
    current.boss = getRaidBossById(current.boss.id) || current.boss;
    current.quotaKg = Math.max(1, Number(current.quotaKg || current.boss.quotaKg || 100));
    current.filledKg = Math.max(0, Number(current.filledKg || 0));
    current.participants = current.participants && typeof current.participants === "object" && !Array.isArray(current.participants) ? current.participants : {};
    return current;
  }

  const boss = pickDailyRaidBoss(dateKey, guildId);
  const next = {
    dateKey,
    boss,
    quotaKg: boss.quotaKg,
    filledKg: 0,
    participants: {},
    fulfilledAt: "",
    lastRaidEndedAt: 0,
    channelId: ""
  };
  dailyFishRaids.set(guildId, next);
  saveFishRaidState();
  return next;
}

function getDailyRaidResult(state, participant) {
  if (!state.participants[participant.id]) {
    state.participants[participant.id] = {
      id: participant.id,
      username: participant.username,
      globalName: participant.globalName,
      displayName: participant.displayName,
      logName: participant.logName,
      count: 0,
      totalWeight: 0,
      heaviestWeight: 0,
      heaviestName: ""
    };
  }
  return state.participants[participant.id];
}

function addRaidResultToDailyState(raid) {
  const state = normalizeDailyRaidState(raid.guildId);
  for (const result of raid.results.values()) {
    const daily = getDailyRaidResult(state, result);
    daily.username = result.username;
    daily.globalName = result.globalName;
    daily.displayName = result.displayName;
    daily.logName = result.logName;
    daily.count += result.count;
    daily.totalWeight += result.totalWeight;
    if (result.heaviestWeight > daily.heaviestWeight) {
      daily.heaviestWeight = result.heaviestWeight;
      daily.heaviestName = result.heaviestName;
    }
  }
  state.filledKg = Math.min(state.quotaKg, Math.max(0, Number(state.filledKg || 0)) + Math.max(0, Number(raid.raidGainedWeight || 0)));
  if (!state.fulfilledAt && state.filledKg >= state.quotaKg) {
    state.fulfilledAt = new Date().toISOString();
  }
  state.lastRaidEndedAt = Date.now();
  saveFishRaidState();
  return state;
}

function getSortedRaidResults(results) {
  return [...results]
    .sort((a, b) => b.totalWeight - a.totalWeight || b.count - a.count || a.username.localeCompare(b.username));
}

function formatRaidQuotaLine(state) {
  const filled = Math.max(0, Number(state.filledKg || 0));
  const quota = Math.max(1, Number(state.quotaKg || 1));
  return `Quota: **${formatKg(filled)} / ${formatKg(quota)}**\n${makeProgressBar(filled, quota, 18)}`;
}

function getRaidCooldownRemainingMs(guildId) {
  const state = normalizeDailyRaidState(guildId);
  const cooldownMs = Math.max(0, Number(getSettings().fishRaidCooldownMinutes ?? 60)) * 60_000;
  return Math.max(0, Number(state.lastRaidEndedAt || 0) + cooldownMs - Date.now());
}

function getSortedCompetitionResults(competition) {
  if (competition.mode === "raid") {
    return getSortedRaidResults(competition.results.values());
  }
  if (competition.mode === "duel") {
    return [...competition.results.values()]
      .sort((a, b) => Number(b.opponentFilledAt || 0) - Number(a.opponentFilledAt || 0) || b.totalWeight - a.totalWeight || a.username.localeCompare(b.username));
  }
  return [...competition.results.values()]
    .sort((a, b) => b.count - a.count || b.totalWeight - a.totalWeight || a.username.localeCompare(b.username));
}

function formatCompetitionResultLine(result, competition = null) {
  if (competition?.mode === "duel") {
    const filled = Math.max(0, Number(result.bagFilled || 0));
    const capacity = Math.max(1, Number(result.bagSpaceKg || 1));
    return `${result.displayName} ${formatKg(filled)} / ${formatKg(capacity)}\n${makeProgressBar(filled, capacity, 18)}`;
  }
  return `${result.displayName} - ${result.count} ${result.count === 1 ? "ikan" : "Ikan"} - Total ${formatKg(result.totalWeight)}`;
}

function formatCompetitionScoreboard(competition) {
  return getSortedCompetitionResults(competition).map((result) => formatCompetitionResultLine(result, competition)).join("\n");
}

function getCompetitionRewardExp(competition) {
  return Math.round(getCompetitionBaseRewardExp() * getCompetitionParticipantMultiplier(competition) * getEventMultiplier("exp_multiplier", competition.guildId));
}

function getCompetitionRewardGold(competition) {
  return Math.round(getCompetitionBaseRewardGold() * getCompetitionParticipantMultiplier(competition) * getEventMultiplier("gold_multiplier", competition.guildId));
}

function getCompetitionBaseRewardExp() {
  return Math.round(Number(getSettings().fishCompExpReward ?? 50) * Number(getSettings().expMultiplier || 1));
}

function getCompetitionBaseRewardGold() {
  return Math.round(Number(getSettings().fishCompGoldReward ?? 0));
}

function getCompetitionParticipantMultiplier(competition) {
  return Math.max(1, Number(competition?.participants?.size || 0));
}

function getRaidRewardAmount(key, guildId, multiplierType = "") {
  const multiplier = multiplierType ? getEventMultiplier(multiplierType, guildId) : 1;
  return Math.round(Number(getSettings()[key] ?? 0) * multiplier);
}

function getRaidBaseRewardAmount(key) {
  return Math.round(Number(getSettings()[key] ?? 0));
}

async function giveRaidReward(userId, expReward, goldReward) {
  const rewardExp = Math.max(0, Math.round(Number(expReward || 0)));
  const rewardGold = Math.max(0, Math.round(Number(goldReward || 0)));
  if (!userId || (rewardExp <= 0 && rewardGold <= 0)) {
    return { previousLevel: 0, level: 0 };
  }

  let previousLevel = 0;
  let level = 0;
  await withPlayer(userId, async (player) => {
    previousLevel = getLevel(player.exp);
    player.exp += rewardExp;
    player.gold = Math.max(0, Math.floor(Number(player.gold || 0))) + rewardGold;
    level = getLevel(player.exp);
  });
  return { previousLevel, level };
}

function summarizeRaidResults(results, { daily = false } = {}) {
  const sorted = getSortedRaidResults(results);
  if (!sorted.length) {
    return "Tidak ada peserta.";
  }
  const mvp = sorted[0];
  const mostFish = [...sorted].sort((a, b) => b.count - a.count || b.totalWeight - a.totalWeight)[0];
  const heaviestFish = [...sorted].sort((a, b) => b.heaviestWeight - a.heaviestWeight)[0];
  const suffix = daily ? " Hari Ini" : "";
  return [
    `Total Ikan Terberat${suffix}: **${mvp.displayName}** (${formatKg(mvp.totalWeight)})`,
    `Total Ikan Terbanyak${suffix}: **${mostFish.displayName}** (${mostFish.count} ikan)`,
    `Ikan Terberat${suffix}: **${heaviestFish.displayName}** (${heaviestFish.heaviestName || "-"} ${formatKg(heaviestFish.heaviestWeight)})`
  ].join("\n");
}

function summarizeCompetition(competition) {
  const results = [...competition.results.values()];
  if (!results.length) {
    return "Tidak ada peserta.";
  }

  const mostFish = [...results].sort((a, b) => b.count - a.count || b.totalWeight - a.totalWeight)[0];
  const heaviestFish = [...results].sort((a, b) => b.heaviestWeight - a.heaviestWeight)[0];
  const totalWeight = [...results].sort((a, b) => b.totalWeight - a.totalWeight)[0];
  const loser = [...results].sort((a, b) => a.count - b.count || a.totalWeight - b.totalWeight)[0];

  return [
    `Paling Banyak Ikan: **${mostFish.displayName}** (${mostFish.count} ikan)`,
    `Ikan Terberat: **${heaviestFish.displayName}** (${heaviestFish.heaviestName || "-"} ${formatKg(heaviestFish.heaviestWeight)})`,
    `Total Berat Terbesar: **${totalWeight.displayName}** (${formatKg(totalWeight.totalWeight)})`,
    `Paling Sedikit Ikan: **${loser.displayName}** (${loser.count} ikan)`
  ].join("\n");
}

function listCompetitionParticipants(competition, numbered = false) {
  const participants = [...competition.participants.values()].map((participant) => participant.displayName);
  if (!participants.length) {
    return "Tidak ada peserta.";
  }
  return participants.map((participant, index) => (numbered ? `${index + 1}. ${participant}` : participant)).join("\n");
}

function listCompetitionResultParticipants(competition) {
  const results = getSortedCompetitionResults(competition);
  if (!results.length) {
    return "Tidak ada peserta.";
  }
  return results.map((result, index) => `${index + 1}. ${formatCompetitionResultLine(result, competition)}`).join("\n");
}

function getCompetitionLogName(participant) {
  return participant.globalName || participant.username || participant.logName || participant.displayName || participant.id;
}

async function withCompetitionTimeout(promise, label) {
  let timeoutId;
  const timeout = new Promise((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(`${label} timed out after 30 seconds.`)), 30_000);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timeoutId);
  }
}

async function prepareCompetitionParticipant(participant) {
  try {
    const { player } = await withCompetitionTimeout(getPlayer(participant.id), `Loading ${participant.username}`);
    participant.rodId = player.rodId;
    participant.fishBagId = player.fishBagId || "";
    participant.level = getLevel(player.exp);
  } catch (error) {
    console.error(`Could not load competition player ${participant.id}:`, error);
    participant.rodId = "";
    participant.fishBagId = "";
    participant.level = 1;
  }
}

async function revealPendingCompetitionLogs(competition) {
  const visibleLogs = Array.isArray(competition.visibleLogs) ? competition.visibleLogs : [];
  competition.visibleLogs = visibleLogs;

  while (competition.visibleLogs.length < competition.logs.length) {
    competition.visibleLogs.push(competition.logs[competition.visibleLogs.length]);
    if (competition.logMessage) {
      await competition.logMessage.edit(makeCompetitionMessage(competition, "running")).catch(() => {});
    }
    await new Promise((resolve) => setTimeout(resolve, competition.logIntervalMs));
  }
}

async function finishFishRaid(raid, channel) {
  const state = addRaidResultToDailyState(raid);
  const raidWinner = getSortedRaidResults(raid.results.values())[0];
  const dailyResults = getSortedRaidResults(Object.values(state.participants || {}));
  const dailyMvp = dailyResults[0];
  const fulfilled = Boolean(state.fulfilledAt);
  const participantExp = getRaidRewardAmount("fishRaidParticipantExpReward", raid.guildId, "exp_multiplier");
  const participantGold = getRaidRewardAmount("fishRaidParticipantGoldReward", raid.guildId, "gold_multiplier");
  const mvpExp = getRaidRewardAmount("fishRaidMvpExpReward", raid.guildId, "exp_multiplier");
  const mvpGold = getRaidRewardAmount("fishRaidMvpGoldReward", raid.guildId, "gold_multiplier");
  const clearParticipantExp = fulfilled ? getRaidRewardAmount("fishRaidClearParticipantExpReward", raid.guildId, "exp_multiplier") : 0;
  const clearParticipantGold = fulfilled ? getRaidRewardAmount("fishRaidClearParticipantGoldReward", raid.guildId, "gold_multiplier") : 0;
  const clearMvpExp = fulfilled ? getRaidRewardAmount("fishRaidClearMvpExpReward", raid.guildId, "exp_multiplier") : 0;
  const clearMvpGold = fulfilled ? getRaidRewardAmount("fishRaidClearMvpGoldReward", raid.guildId, "gold_multiplier") : 0;
  const participantBaseExp = getRaidBaseRewardAmount("fishRaidParticipantExpReward");
  const participantBaseGold = getRaidBaseRewardAmount("fishRaidParticipantGoldReward");
  const mvpBaseExp = getRaidBaseRewardAmount("fishRaidMvpExpReward");
  const mvpBaseGold = getRaidBaseRewardAmount("fishRaidMvpGoldReward");
  const clearParticipantBaseExp = fulfilled ? getRaidBaseRewardAmount("fishRaidClearParticipantExpReward") : 0;
  const clearParticipantBaseGold = fulfilled ? getRaidBaseRewardAmount("fishRaidClearParticipantGoldReward") : 0;
  const clearMvpBaseExp = fulfilled ? getRaidBaseRewardAmount("fishRaidClearMvpExpReward") : 0;
  const clearMvpBaseGold = fulfilled ? getRaidBaseRewardAmount("fishRaidClearMvpGoldReward") : 0;
  const baseParticipantExp = fulfilled ? clearParticipantExp : participantExp;
  const baseParticipantGold = fulfilled ? clearParticipantGold : participantGold;
  const baseParticipantBaseExp = fulfilled ? clearParticipantBaseExp : participantBaseExp;
  const baseParticipantBaseGold = fulfilled ? clearParticipantBaseGold : participantBaseGold;
  const raidWinnerIsDailyMvp = Boolean(raidWinner?.id && dailyMvp?.id && raidWinner.id === dailyMvp.id);
  const raidWinnerIsFinalDailyMvp = fulfilled && raidWinnerIsDailyMvp;
  const raidMvpTotalExp = baseParticipantExp + mvpExp;
  const raidMvpTotalGold = baseParticipantGold + mvpGold;
  const dailyMvpTotalExp = clearParticipantExp + clearMvpExp;
  const dailyMvpTotalGold = clearParticipantGold + clearMvpGold;
  const combinedMvpTotalExp = baseParticipantExp + mvpExp + clearMvpExp;
  const combinedMvpTotalGold = baseParticipantGold + mvpGold + clearMvpGold;
  const raidMvpBaseTotalExp = baseParticipantBaseExp + mvpBaseExp;
  const raidMvpBaseTotalGold = baseParticipantBaseGold + mvpBaseGold;
  const dailyMvpBaseTotalExp = clearParticipantBaseExp + clearMvpBaseExp;
  const dailyMvpBaseTotalGold = clearParticipantBaseGold + clearMvpBaseGold;
  const combinedMvpBaseTotalExp = baseParticipantBaseExp + mvpBaseExp + clearMvpBaseExp;
  const combinedMvpBaseTotalGold = baseParticipantBaseGold + mvpBaseGold + clearMvpBaseGold;
  const expEventInfo = getEventMultiplierInfo("exp_multiplier", raid.guildId);
  const goldEventInfo = getEventMultiplierInfo("gold_multiplier", raid.guildId);
  const levelUps = [];

  if (fulfilled) {
    for (const result of dailyResults) {
      const reward = await giveRaidReward(result.id, clearParticipantExp, clearParticipantGold);
      if (reward.level > reward.previousLevel) {
        levelUps.push({ id: result.id, level: reward.level });
      }
    }
  } else {
    for (const result of raid.results.values()) {
      const reward = await giveRaidReward(result.id, participantExp, participantGold);
      if (reward.level > reward.previousLevel) {
        levelUps.push({ id: result.id, level: reward.level });
      }
    }
  }
  if (raidWinner?.id) {
    const reward = await giveRaidReward(raidWinner.id, mvpExp, mvpGold);
    if (reward.level > reward.previousLevel) {
      levelUps.push({ id: raidWinner.id, level: reward.level });
    }
  }
  if (fulfilled && dailyMvp?.id) {
    const reward = await giveRaidReward(dailyMvp.id, clearMvpExp, clearMvpGold);
    if (reward.level > reward.previousLevel) {
      levelUps.push({ id: dailyMvp.id, level: reward.level });
    }
  }

  const mvpLines = fulfilled
    ? [
        raidWinnerIsDailyMvp
          ? `# MVP Raid & Harian: ${raidWinner.displayName}`
          : dailyMvp ? `# MVP Harian: ${dailyMvp.displayName}` : "# MVP Harian: -",
        !raidWinnerIsDailyMvp && raidWinner ? `MVP Raid: ${raidWinner.displayName}` : ""
      ].filter(Boolean)
    : [
        raidWinner ? `# MVP Raid: ${raidWinner.displayName}` : "# MVP Raid: -"
      ];
  const rewardLines = [
    `Peserta raid ini: **${formatRewardWithBonus(baseParticipantExp, baseParticipantBaseExp, "EXP")}** dan **${formatRewardWithBonus(baseParticipantGold, baseParticipantBaseGold, "Gold")}**`,
    raidWinnerIsFinalDailyMvp
      ? `MVP raid ini dan harian (**${raidWinner.displayName}**): **${formatRewardWithBonus(combinedMvpTotalExp, combinedMvpBaseTotalExp, "EXP")}** dan **${formatRewardWithBonus(combinedMvpTotalGold, combinedMvpBaseTotalGold, "Gold")}**`
      : raidWinner ? `MVP raid ini (**${raidWinner.displayName}**): **${formatRewardWithBonus(raidMvpTotalExp, raidMvpBaseTotalExp, "EXP")}** dan **${formatRewardWithBonus(raidMvpTotalGold, raidMvpBaseTotalGold, "Gold")}**` : "",
    fulfilled && dailyMvp && !raidWinnerIsDailyMvp
      ? `MVP harian (**${dailyMvp.displayName}**): **${formatRewardWithBonus(dailyMvpTotalExp, dailyMvpBaseTotalExp, "EXP")}** dan **${formatRewardWithBonus(dailyMvpTotalGold, dailyMvpBaseTotalGold, "Gold")}**`
      : "",
    formatBonusNotice(
      "EXP",
      expEventInfo,
      baseParticipantExp + (raidWinnerIsDailyMvp ? combinedMvpTotalExp : raidMvpTotalExp + dailyMvpTotalExp),
      baseParticipantBaseExp + (raidWinnerIsDailyMvp ? combinedMvpBaseTotalExp : raidMvpBaseTotalExp + dailyMvpBaseTotalExp)
    ),
    formatBonusNotice(
      "Gold",
      goldEventInfo,
      baseParticipantGold + (raidWinnerIsDailyMvp ? combinedMvpTotalGold : raidMvpTotalGold + dailyMvpTotalGold),
      baseParticipantBaseGold + (raidWinnerIsDailyMvp ? combinedMvpBaseTotalGold : raidMvpBaseTotalGold + dailyMvpBaseTotalGold)
    )
  ].filter(Boolean);

  const summaryLines = [
    summarizeRaidResults(raid.results.values()),
    fulfilled ? summarizeRaidResults(dailyResults, { daily: true }) : ""
  ].filter(Boolean);

  const embed = new EmbedBuilder()
    .setColor(fulfilled ? 0x2ecc71 : 0x3ba1ff)
    .setTitle(fulfilled ? "Fish Raid Selesai · Quota Terpenuhi" : "Fish Raid Selesai")
    .setDescription(
      [
        `Boss: **${state.boss.name}**`,
        formatRaidQuotaLine(state),
        "",
        "**Ranking Harian**",
        dailyResults.length ? dailyResults.map((result, index) => `${index + 1}. ${formatCompetitionResultLine(result)}`).join("\n") : "Tidak ada peserta.",
        "",
        mvpLines.join("\n"),
        rewardLines.join("\n") || "Tidak ada reward.",
        "",
        summaryLines.join("\n\n")
      ].join("\n")
    );
  const logId = `${raid.guildId}:raid:${Date.now()}`;
  rememberCompetitionHistoryLog(logId, {
    createdAt: Date.now(),
    fileName: "fishraid_log.txt",
    content: buildCompetitionLogFile(raid)
  });
  const banner = makeFishRaidImage(fulfilled ? "fulfilled" : "result", state.boss);
  if (banner?.url) {
    embed.setImage(banner.url);
  }
  await channel.send(makeEmbedPanelMessage(embed, {
    files: banner?.attachment ? [banner.attachment] : [],
    components: makeFishRaidResultRow(logId)
  })).catch(() => {});
  logBotAction("Fish Raid finished", {
    guild: guildLogName(channel, raid.guildId),
    channel: channelLogName(channel),
    extra: `participants=${raid.participants.size} fulfilled=${fulfilled} mvp=${raidWinner?.displayName || "-"}`
  });
  await raid.message?.delete().catch(() => {});
  await raid.pingMessage?.delete().catch(() => {});
  if (raid.logMessage) {
    await raid.logMessage.delete().catch(() => {});
  }
  const highestLevelUps = [...levelUps.reduce((map, entry) => {
    const previous = map.get(entry.id);
    if (!previous || entry.level > previous.level) {
      map.set(entry.id, entry);
    }
    return map;
  }, new Map()).values()];
  for (const levelUp of highestLevelUps) {
    const member = await channel.guild?.members.fetch(levelUp.id).catch(() => null);
    const user = member?.user || await client.users.fetch(levelUp.id).catch(() => null);
    if (user) {
      const levelUpChannel = await resolveParentTextChannel(channel) || channel;
      await levelUpChannel.send({ embeds: [makeLevelUpEmbed(user, levelUp.level, member)] }).catch(() => {});
    }
  }
  fishRaids.delete(raid.guildId);
}

function runCompetitionTurnForParticipant(competition, participant, turn, turnEffect = null) {
  const existingStateEffect = applyExistingCompetitionEvents(competition, participant, turn);
  const existingEffect = turnEffect
    ? {
      canFish: existingStateEffect.canFish !== false && turnEffect.canFish !== false,
      luckModifier: Number(existingStateEffect.luckModifier || 0) + Number(turnEffect.luckModifier || 0),
      fromCurrentTurn: true
    }
    : existingStateEffect;
  const newEffect = existingEffect.fromCurrentTurn ? { canFish: true, luckModifier: 0 } : applyNewCompetitionEvent(competition, participant, turn);
  const canFish = existingEffect.canFish !== false && newEffect.canFish !== false;
  const luckModifier = Number(existingEffect.luckModifier || 0) + Number(newEffect.luckModifier || 0);
  if (!canFish) {
    return;
  }

  const opponent = competition.mode === "duel" ? [...competition.participants.values()].find((entry) => entry.id !== participant.id) : null;
  const context = {
    mode: competition.mode === "duel" ? "duel" : competition.mode === "raid" ? "raid" : "competition",
    target: "self",
    userLevel: Number(participant.level || 1),
    opponentLevel: Number(opponent?.level || 1)
  };
  const baseRod = getRod(participant.rodId);
  const rod = baseRod ? { ...baseRod, luck: Number(baseRod.luck || 0) + luckModifier } : null;
  const accuracy = getEffectiveRodAccuracy(rod, context);
  const result = competition.results.get(participant.id);
  if (!rod || !result || Math.random() * 100 >= accuracy) {
    competition.logs.push(`[${turn}] ${participant.displayName} gagal mendapatkan ikan.`);
    return;
  }

  const catchResult = rollFish(rod, competition.guildId);
  if (!catchResult) {
    competition.logs.push(`[${turn}] ${participant.displayName} gagal mendapatkan ikan.`);
    return;
  }

  result.count += 1;
  result.totalWeight += catchResult.catchWeight;
  if (competition.mode === "duel" && opponent) {
    const opponentResult = competition.results.get(opponent.id);
    if (opponentResult) {
      opponentResult.bagFilled = Math.max(0, Number(opponentResult.bagFilled || 0)) + catchResult.catchWeight;
      result.opponentFilledAt = opponentResult.bagFilled;
      if (!competition.winnerId && opponentResult.bagFilled >= Number(opponentResult.bagSpaceKg || 1)) {
        competition.winnerId = participant.id;
        competition.finishedTurn = turn;
      }
    }
  }
  if (competition.mode === "raid") {
    competition.raidGainedWeight = Math.max(0, Number(competition.raidGainedWeight || 0)) + catchResult.catchWeight;
  }
  if (catchResult.catchWeight > result.heaviestWeight) {
    result.heaviestWeight = catchResult.catchWeight;
    result.heaviestName = catchResult.fish.name;
  }
  if (competition.mode === "duel" && opponent) {
    const opponentResult = competition.results.get(opponent.id);
    competition.logs.push(`[${turn}] ${participant.displayName} memberi ${catchResult.fish.name} ke tas ${opponent.displayName}! (${formatKg(catchResult.catchWeight)} · ${formatKg(opponentResult?.bagFilled || 0)}/${formatKg(opponentResult?.bagSpaceKg || 1)})`);
    return;
  }
  competition.logs.push(`[${turn}] ${participant.displayName} berhasil mendapatkan ${catchResult.fish.name}! (${formatKg(catchResult.catchWeight)})`);
}

async function runCompetition(competition) {
  if (competition.status !== "registration") {
    return;
  }
  if (competition.timeout) {
    clearTimeout(competition.timeout);
    competition.timeout = null;
  }
  competition.status = "running";
  competition.currentTurn = 0;
  competition.visibleLogs = [];
  const channel = await client.channels.fetch(competition.channelId).catch(() => null);
  logBotAction(`${competitionLogName(competition)} started`, {
    guild: guildLogName(channel, competition.guildId),
    channel: channelLogName(channel),
    extra: `participants=${competition.participants.size}`
  });
  await competition.message?.edit(makeCompetitionMessage(
    competition,
    "closed",
    competition.mode === "duel" ? [] : competition.mode === "raid" ? makeFishRaidJoinRow(true) : makeCompetitionJoinRow(true)
  )).catch(() => {});
  for (const participant of competition.participants.values()) {
    await prepareCompetitionParticipant(participant);
  }
  if (!channel?.isTextBased()) {
    throw new Error("Competition channel is no longer available.");
  }
  competition.logMessage = await channel.send(makeCompetitionMessage(competition, "running", []));

  if (competition.mode === "duel") {
    while (!competition.winnerId && competition.status === "running") {
      competition.currentTurn += 1;
      competition.currentTurnEffects = new Map();
      for (const participant of shuffleCompetitionParticipants(competition.participants.values())) {
        const turnEffect = competition.currentTurnEffects.get(participant.id) || null;
        runCompetitionTurnForParticipant(competition, participant, competition.currentTurn, turnEffect);
        await revealPendingCompetitionLogs(competition);
        if (competition.winnerId) {
          break;
        }
      }
    }
    if (competition.status === "cancelled") {
      fishDuels.delete(competition.duelKey);
      return;
    }
  } else {
    for (let turn = 1; turn <= competition.turns; turn += 1) {
      competition.currentTurn = turn;
      competition.currentTurnEffects = new Map();
      for (const participant of shuffleCompetitionParticipants(competition.participants.values())) {
        const turnEffect = competition.currentTurnEffects.get(participant.id) || null;
        runCompetitionTurnForParticipant(competition, participant, turn, turnEffect);
        await revealPendingCompetitionLogs(competition);
      }
    }
  }

  competition.status = "finished";
  if (competition.mode === "raid") {
    await finishFishRaid(competition, channel);
    return;
  }
  if (competition.mode === "duel") {
    await finishFishDuel(competition, channel);
    return;
  }

  const summary = summarizeCompetition(competition);
  const winner = getSortedCompetitionResults(competition)[0];
  const winnerRewardExp = winner ? getCompetitionRewardExp(competition) : 0;
  const winnerRewardGold = winner ? getCompetitionRewardGold(competition) : 0;
  const participantMultiplier = getCompetitionParticipantMultiplier(competition);
  const winnerBaseExp = winner ? Math.round(getCompetitionBaseRewardExp() * participantMultiplier) : 0;
  const winnerBaseGold = winner ? Math.round(getCompetitionBaseRewardGold() * participantMultiplier) : 0;
  const expEventInfo = getEventMultiplierInfo("exp_multiplier", competition.guildId);
  const goldEventInfo = getEventMultiplierInfo("gold_multiplier", competition.guildId);
  let winnerLevel = 0;
  let winnerPreviousLevel = 0;
  if (winner) {
    await withPlayer(winner.id, async (player) => {
      winnerPreviousLevel = getLevel(player.exp);
      player.exp += winnerRewardExp;
      player.gold = Math.max(0, Math.floor(Number(player.gold || 0))) + winnerRewardGold;
      player.fishCompWins = Math.max(0, Math.floor(Number(player.fishCompWins || 0))) + 1;
      winnerLevel = getLevel(player.exp);
    });
    leaderboardCache.loadedAt = 0;
  }
  const embed = new EmbedBuilder()
    .setColor(0x2ecc71)
    .setTitle("Hasil Kompetisi Memancing")
    .setDescription(
      [
        "**Peserta**",
        listCompetitionResultParticipants(competition),
        "",
        winner ? `# MVP: ${winner.displayName}` : "# MVP: -",
        winner ? `Participant multiplier: **x${participantMultiplier}**` : "",
        winner ? `Mendapat hadiah: **${formatRewardWithBonus(winnerRewardExp, winnerBaseExp, "EXP")}** dan **${formatRewardWithBonus(winnerRewardGold, winnerBaseGold, "Gold")}**` : "Mendapat hadiah: **0 EXP** dan **0 Gold**",
        formatBonusNotice("EXP", expEventInfo, winnerRewardExp, winnerBaseExp),
        formatBonusNotice("Gold", goldEventInfo, winnerRewardGold, winnerBaseGold),
        "",
        summary
      ].filter((line) => line !== "").join("\n")
    );
  const logId = `${competition.guildId}:${Date.now()}`;
  rememberCompetitionHistoryLog(logId, {
    createdAt: Date.now(),
    fileName: "match_log.txt",
    content: buildCompetitionLogFile(competition)
  });
  const banner = makeFishCompImage("result");
  if (banner?.url) {
    embed.setImage(banner.url);
  }
  await channel.send(makeEmbedPanelMessage(embed, {
    files: banner?.attachment ? [banner.attachment] : [],
    components: makeCompetitionResultRow(logId)
  })).catch(() => {});
  logBotAction("Fish Comp finished", {
    guild: guildLogName(channel, competition.guildId),
    channel: channelLogName(channel),
    extra: `participants=${competition.participants.size} winner=${winner?.displayName || "-"}`
  });
  await competition.message?.delete().catch(() => {});
  await competition.pingMessage?.delete().catch(() => {});
  if (competition.logMessage) {
    await competition.logMessage.delete().catch(() => {});
  }
  if (winner?.id && winnerLevel > winnerPreviousLevel) {
    const member = await channel.guild?.members.fetch(winner.id).catch(() => null);
    const user = member?.user || await client.users.fetch(winner.id).catch(() => null);
    if (user) {
      const levelUpChannel = await resolveParentTextChannel(channel) || channel;
      await levelUpChannel.send({ embeds: [makeLevelUpEmbed(user, winnerLevel, member)] }).catch(() => {});
    }
  }
  competitions.delete(competition.guildId);
}

async function finishFishDuel(duel, channel) {
  const sorted = getSortedCompetitionResults(duel);
  const winner = duel.winnerId ? duel.results.get(duel.winnerId) : sorted[0] || null;
  const loser = winner ? sorted.find((result) => result.id !== winner.id) || null : null;
  const expReward = Math.round(Number(getSettings().fishDuelExpReward ?? 40) * Number(getSettings().expMultiplier || 1) * getEventMultiplier("exp_multiplier", duel.guildId));
  const baseExpReward = Math.round(Number(getSettings().fishDuelExpReward ?? 40) * Number(getSettings().expMultiplier || 1));
  const expEventInfo = getEventMultiplierInfo("exp_multiplier", duel.guildId);
  const levelUps = [];

  if (winner?.id && expReward > 0) {
    const reward = await giveRaidReward(winner.id, expReward, 0);
    if (reward.level > reward.previousLevel) {
      levelUps.push({ id: winner.id, level: reward.level });
    }
  }

  if (winner?.id && Number(duel.betAmount || 0) > 0) {
    await withPlayer(winner.id, async (player) => {
      player.gold = Math.max(0, Math.floor(Number(player.gold || 0))) + Number(duel.betAmount || 0) * 2;
    });
  }

  const embed = new EmbedBuilder()
    .setColor(0x2ecc71)
    .setTitle("Hasil Duel Adu Dermawan!")
    .setDescription(
      [
        "Terbukti diantara kedunya, siapakah yang paling dermawan",
        "",
        "**Peserta**",
        listCompetitionResultParticipants(duel),
        "",
        winner ? `# Paling Dermawan: ${winner.displayName}` : "# Paling Dermawan: -",
        loser ? `Tas ${loser.displayName}: **${formatKg(loser.bagFilled || 0)} / ${formatKg(loser.bagSpaceKg || 1)}**` : "",
        `Reward: **${formatRewardWithBonus(expReward, baseExpReward, "EXP")}**`,
        Number(duel.betAmount || 0) > 0 && winner ? `Taruhan dimenangkan: **${formatGoldAmount(Number(duel.betAmount || 0) * 2)}**` : "Tanpa taruhan gold.",
        formatBonusNotice("EXP", expEventInfo, expReward, baseExpReward)
      ].filter(Boolean).join("\n")
    );
  const logId = `${duel.guildId}:duel:${Date.now()}`;
  rememberCompetitionHistoryLog(logId, {
    createdAt: Date.now(),
    fileName: "fishduel_log.txt",
    content: buildCompetitionLogFile(duel)
  });
  const banner = makeFishDuelImage("result");
  if (banner?.url) {
    embed.setImage(banner.url);
  }
  await channel.send(makeEmbedPanelMessage(embed, {
    files: banner?.attachment ? [banner.attachment] : [],
    components: makeCompetitionResultRow(logId)
  })).catch(() => {});
  logBotAction("Fish Duel finished", {
    guild: guildLogName(channel, duel.guildId),
    channel: channelLogName(channel),
    extra: `participants=${duel.participants.size} winner=${winner?.displayName || "-"}`
  });
  await duel.message?.delete().catch(() => {});
  if (duel.logMessage) {
    await duel.logMessage.delete().catch(() => {});
  }
  for (const levelUp of levelUps) {
    const member = await channel.guild?.members.fetch(levelUp.id).catch(() => null);
    const user = member?.user || await client.users.fetch(levelUp.id).catch(() => null);
    if (user) {
      const levelUpChannel = await resolveParentTextChannel(channel) || channel;
      await levelUpChannel.send({ embeds: [makeLevelUpEmbed(user, levelUp.level, member)] }).catch(() => {});
    }
  }
  fishDuels.delete(duel.duelKey);
}

function buildCompetitionLogFile(competition) {
  return [
    competition.mode === "duel" ? "TRFishing Fish Duel Match Log" : competition.mode === "raid" ? "TRFishing Fish Raid Match Log" : "TRFishing Competition Match Log",
    `Guild ID: ${competition.guildId}`,
    `Channel ID: ${competition.channelId}`,
    competition.mode === "duel" ? `Rounds: ${competition.currentTurn}` : `Turns: ${competition.turns}`,
    `Participants: ${competition.participants.size}`,
    "",
    "Participants",
    [...competition.participants.values()].map((participant, index) => `${index + 1}. ${getCompetitionLogName(participant)}`).join("\n") || "Tidak ada peserta.",
    "",
    "Battle Log",
    ...formatCompetitionLogFileLines(competition)
  ].join("\n");
}

function rememberCompetitionHistoryLog(logId, record) {
  finishedCompetitionLogs.set(logId, record);
  cleanupFinishedCompetitionLogs();
  saveCompetitionHistoryLogs();
}

async function cancelCompetition(competition, reason) {
  if (competition.timeout) {
    clearTimeout(competition.timeout);
    competition.timeout = null;
  }
  competition.status = "cancelled";
  const channel = competition.channelId ? await client.channels.fetch(competition.channelId).catch(() => null) : null;
  logBotAction(`${competitionLogName(competition)} cancelled`, {
    guild: guildLogName(channel, competition.guildId),
    channel: channelLogName(channel),
    extra: `reason=${reason}`
  });
  await competition.message?.edit(makeSimplePanelMessage("Kompetisi Dibatalkan", reason)).catch(() => {});
  await competition.pingMessage?.delete().catch(() => {});
  if (competition.mode === "raid") {
    fishRaids.delete(competition.guildId);
  } else if (competition.mode === "duel") {
    fishDuels.delete(competition.duelKey);
  } else {
    competitions.delete(competition.guildId);
  }
}

function cleanupFinishedCompetitionLogs() {
  const historyHours = Math.max(0, Number(getSettings().fishCompHistoryLogHours ?? 24));
  const maxAgeMs = historyHours * 60 * 60 * 1000;
  if (maxAgeMs <= 0) {
    if (finishedCompetitionLogs.size) {
      finishedCompetitionLogs.clear();
      saveCompetitionHistoryLogs();
    }
    return;
  }
  const now = Date.now();
  let changed = false;
  for (const [logId, record] of finishedCompetitionLogs.entries()) {
    if (now - Number(record.createdAt || 0) > maxAgeMs) {
      finishedCompetitionLogs.delete(logId);
      changed = true;
    }
  }
  if (changed) {
    saveCompetitionHistoryLogs();
  }
}

function sellFish(player, fishName, guildId = "") {
  const normalizedName = normalizeMessage(fishName);
  const selectedFish = fishName
    ? gameData.fish.find((entry) => normalizeMessage(entry.name) === normalizedName || normalizeMessage(entry.id) === normalizedName)
    : null;

  if (fishName && !selectedFish) {
    return { ok: false, message: { content: "Ikan itu tidak ditemukan." } };
  }

  const fishToSell = selectedFish ? [selectedFish] : gameData.fish;
  const goldBefore = Math.max(0, Math.floor(Number(player.gold || 0)));
  const goldEventInfo = getEventMultiplierInfo("gold_multiplier", guildId);
  let totalGold = 0;
  let totalBaseGold = 0;
  let totalCount = 0;
  const soldLines = [];

  for (const fishEntry of fishToSell) {
    const quantity = player.inventory[fishEntry.id] || 0;
    if (quantity <= 0) {
      continue;
    }

    const baseGold = Math.max(0, Math.round(quantity * Number(fishEntry.gold || 0)));
    const earnedGold = Math.max(0, Math.round(baseGold * goldEventInfo.multiplier));
    totalCount += quantity;
    totalGold += earnedGold;
    totalBaseGold += baseGold;
    soldLines.push(`${fishEntry.name} x${quantity} = ${formatRewardWithBonus(earnedGold, baseGold, "Gold")}`);
    delete player.inventory[fishEntry.id];
  }

  if (totalCount === 0) {
    return {
      ok: false,
      message: { content: selectedFish ? `Kamu tidak punya ${selectedFish.name}.` : "Kamu tidak punya ikan untuk dijual." }
    };
  }

  player.gold = goldBefore + totalGold;
  const remainingFishCount = Object.values(player.inventory || {}).reduce((sum, quantity) => sum + Math.max(0, Math.floor(Number(quantity || 0))), 0);
  const inventoryStatus = selectedFish
    ? `${selectedFish.name} sekarang **0** di inventory kamu. Total ikan tersisa: **${remainingFishCount}**.`
    : remainingFishCount === 0
      ? "Semua ikan di inventory sekarang **0**. Inventory ikan kamu kosong."
      : `Ikan yang dijual sudah **0**. Total ikan tersisa: **${remainingFishCount}**.`;
  const embed = new EmbedBuilder()
    .setColor(0xf1c40f)
    .setTitle("Ikan Berhasil Dijual")
    .setDescription([
      `Kamu menjual **${totalCount}** ikan dan mendapatkan **${formatRewardWithBonus(totalGold, totalBaseGold, "Gold")}**.`,
      formatBonusNotice("Gold", goldEventInfo, totalGold, totalBaseGold)
    ].filter(Boolean).join("\n"))
    .addFields(
      { name: "Gold Sebelum", value: formatGoldAmount(goldBefore), inline: true },
      { name: "Gold Sesudah", value: formatGoldAmount(player.gold), inline: true },
      { name: "Inventory", value: inventoryStatus },
      { name: "Rincian", value: truncateText(soldLines.join("\n"), 1024) }
    );
  const banner = makeSettingsImage("sellFishBanner");
  return {
    ok: true,
    message: makeMessageWithBanner(embed, banner)
  };
}

function buyRod(player, rodId) {
  const rod = gameData.rods.find((entry) => entry.id === rodId);

  if (!rod) {
    return { ok: false, message: "Pancingan itu tidak ditemukan." };
  }

  if (player.ownedRods.includes(rod.id)) {
    const changed = player.rodId !== rod.id;
    player.rodId = rod.id;
    return { ok: changed, message: `Berhasil memakai ${rod.name}.` };
  }

  if (player.gold < Number(rod.price || 0)) {
    return { ok: false, message: `Gold kamu kurang ${Number(rod.price || 0) - player.gold} untuk membeli ${rod.name}.` };
  }

  player.gold -= Number(rod.price || 0);
  player.ownedRods.push(rod.id);
  player.rodId = rod.id;
  return { ok: true, message: `Berhasil membeli dan memakai ${rod.name}.` };
}

function equipOwnedRod(player, rodId) {
  const rod = gameData.rods.find((entry) => entry.id === rodId);
  if (!rod) {
    return { ok: false, message: "Pancingan itu tidak ditemukan." };
  }
  if (!player.ownedRods.includes(rod.id)) {
    return { ok: false, message: "Kamu belum punya pancingan itu." };
  }
  player.rodId = rod.id;
  return { ok: true, message: `Berhasil memakai ${rod.name}.` };
}

function getUserIdentity(userOrId) {
  if (typeof userOrId === "string") {
    return { userId: userOrId, identity: {} };
  }
  return {
    userId: userOrId.id,
    identity: {
      discordUserId: userOrId.id,
      username: userOrId.username,
      globalName: userOrId.globalName,
      displayName: userOrId.displayName,
      avatarUrl: userOrId.displayAvatarURL?.({ size: 128 }) || ""
    }
  };
}

async function withPlayer(userOrId, action) {
  const { userId, identity } = getUserIdentity(userOrId);
  return queuePlayerWork(userId, async () => {
    const { sessionTicket, player } = await getPlayer(userId, identity);
    refreshPlayerLuckiestFish(player);
    const result = await action(player);
    if (result?.save !== false) {
      await savePlayer(sessionTicket, player);
    }
    return result;
  });
}

async function withPlayerReadOnly(userOrId, action) {
  const { userId, identity } = getUserIdentity(userOrId);
  return queuePlayerWork(userId, async () => {
    const { player } = await getPlayer(userId, identity);
    refreshPlayerLuckiestFish(player);
    return action(player);
  });
}

function rememberFishingChannel(player, channel) {
  if (!channel?.id) {
    return;
  }
  player.lastFishingChannelId = channel.id;
  player.lastFishingGuildId = channel.guildId || channel.guild?.id || "";
}

function fishNow(player, guildId = "") {
  const rod = getRod(player.rodId);
  if (!rod || gameData.fish.length === 0) {
    return { ok: false, message: "Fishing data is not ready yet. Check PlayFab item data." };
  }

  const catchResult = rollFish(rod, guildId);
  if (!catchResult) {
    return { ok: false, message: "No fish are configured yet." };
  }

  const { fish: caughtFish, catchWeight } = catchResult;
  const { expGain, expBase, expEventInfo } = addCatch(player, caughtFish, catchWeight, guildId);
  return { ok: true, caughtFish, catchWeight, expGain, expBase, expEventInfo };
}

function makeHelpEmbed(showAdminCommands = false) {
  const embed = new EmbedBuilder()
    .setColor(0x2ecc71)
    .setTitle("TRFishing · Bantuan")
    .setDescription("# TRFishing Help\nSemua command di bawah ini hanya terlihat oleh kamu.\n\n━━━━━━━━━━━━━━━━━━━━")
    .addFields(
      {
        name: "/fishprofile",
        value: "Melihat profil memancing kamu: level, EXP, gold, pancingan, total ikan, ikan terberat, dan progress memancing.",
        inline: false
      },
      {
        name: "/fishshowoff",
        value: "Membuat banner publik untuk pamer profil memancing, avatar Discord, ikan pilihan, dan statistik utama.",
        inline: false
      },
      {
        name: "/fishinventory",
        value: "Melihat daftar ikan yang kamu punya di inventory.",
        inline: false
      },
      {
        name: "/fishstore",
        value: "Melihat daftar pancingan dan fish bag yang tersedia di toko.",
        inline: false
      },
      {
        name: "/fishdex",
        value: "Melihat daftar ikan server. Ikan yang belum pernah kamu tangkap akan tetap tersembunyi.",
        inline: false
      },
      {
        name: "/fishvoice",
        value: "Membuat bot join voice channel kamu dalam keadaan mute dan deafen, lalu mengaktifkan progress voice untuk server.",
        inline: false
      },
      {
        name: "/fishsetpopupchannel channel:<channel>",
        value: "Admin command untuk membuat thread `Fishing!` di channel pilihan dan mengirim semua popup fishing server ke thread itu.",
        inline: false
      },
      {
        name: "/fishserver",
        value: "Melihat status server: fisher terdaftar, total ikan tertangkap, ikan terbesar, buff aktif, dan server birthday.",
        inline: false
      },
      {
        name: "/sellfish",
        value: "Menjual semua ikan yang kamu punya.",
        inline: false
      },
      {
        name: "/sellfish fish:<nama atau id>",
        value: "Menjual satu jenis ikan tertentu, misalnya `fish:ikan_nila` atau `fish:Ikan Nila`.",
        inline: false
      },
      {
        name: "/fishhelp",
        value: "Menampilkan panel bantuan ini.",
        inline: false
      },
      {
        name: "/fishguide",
        value: "Menampilkan panduan bermain TRFishing dalam Bahasa Indonesia.",
        inline: false
      },
      {
        name: "/fishguide info:<level|inventory|store|competition>",
        value: "Melihat panduan detail untuk level, inventory, store, atau competition.",
        inline: false
      },
      {
        name: "/fishcomp regtime:<menit> duration:<turn>",
        value: "Memulai kompetisi memancing. Pemain lain bisa ikut dengan tombol Join, lalu hasilnya berjalan per turn.",
        inline: false
      },
      {
        name: "/fishduel target:<user> bet:<gold opsional>",
        value: "Menantang pemain lain dalam Duel Adu Dermawan. Kedua pemain harus memakai fish bag.",
        inline: false
      },
      {
        name: "/fishraid regtime:<menit>",
        value: "Memulai boss raid harian selama 25 turn. Peserta mengumpulkan total berat ikan untuk memenuhi quota hari itu.",
        inline: false
      },
      {
        name: "/fishleaderboard",
        value: "Melihat leaderboard jumlah ikan, ikan terbesar, luck score ikan tersulit, dan level.",
        inline: false
      }
    );

  if (showAdminCommands) {
    embed.addFields(
      {
        name: "Admin Commands",
        value: "Command di bawah ini hanya muncul untuk admin.",
        inline: false
      },
      {
        name: "/fishsetpopupchannel channel:<channel>",
        value: "Membuat thread `Fishing!` di channel pilihan dan mengirim semua popup fishing server ke thread itu.",
        inline: false
      },
      {
        name: "!fish",
        value: "Test fishing admin yang benar-benar menangkap ikan, memberi EXP, dan menyimpan data.",
        inline: false
      },
      {
        name: "!fishtest",
        value: "Test popup fishing admin tanpa menyimpan ikan, EXP, progress, atau data lain.",
        inline: false
      },
      {
        name: "!fishcompforcestart",
        value: "Memaksa kompetisi yang sedang registrasi agar mulai lebih cepat.",
        inline: false
      },
      {
        name: "!fishraidforcestart",
        value: "Memaksa raid yang sedang registrasi agar mulai lebih cepat.",
        inline: false
      }
    );
  }

  return embed;
}

function makeHelpMessage(showAdminCommands = false) {
  return makeMessageWithBanner(makeHelpEmbed(showAdminCommands), makeSettingsImage("fishHelpBanner"));
}

function makeFishGuideEmbed() {
  const settings = getSettings();
  const cooldownSeconds = Math.round(Number(settings.chatCooldownMs || 20_000) / 1000);
  return new EmbedBuilder()
    .setColor(0x2ecc71)
    .setTitle("TRFishing · Panduan Bermain")
    .setDescription([
      "# Panduan Bermain",
      "Halaman ini hanya terlihat oleh kamu.",
      "",
      "━━━━━━━━━━━━━━━━━━━━",
      "## Mulai Memancing"
    ].join("\n"))
    .addFields(
      {
        name: "Cara Memancing",
        value: `Kirim chat biasa di server untuk menaikkan progress memancing. Setiap chat valid dihitung setelah cooldown sekitar **${cooldownSeconds} detik**.`,
        inline: false
      },
      {
        name: "Progress",
        value: "Progress naik 1 setiap chat valid. Kalau progress sudah mencapai stat **Speed** pancingan kamu, bot akan otomatis mencoba mendapatkan ikan.",
        inline: false
      },
      {
        name: "Gold dan Jual Ikan",
        value: "Ikan yang kamu dapat masuk inventory. Gunakan `/sellfish` untuk menjual semua ikan, atau `/sellfish fish:<nama/id>` untuk menjual satu jenis ikan. Gold dipakai untuk membeli pancingan dan fish bag.",
        inline: false
      },
      {
        name: "Store, Pancingan, dan Fish Bag",
        value: "Gunakan `/fishstore` untuk membeli atau memakai pancingan dan fish bag. **Capacity** fish bag menentukan kapasitas tas saat FishDuel.",
        inline: false
      },
      {
        name: "Kompetisi",
        value: "Gunakan `/fishcomp regtime:<menit> duration:<turn>` untuk membuat kompetisi. Peserta menekan tombol Join, lalu setiap turn semua peserta mencoba memancing memakai stat pancingannya. Ikan kompetisi tidak masuk inventory dan tidak memberi EXP normal.",
        inline: false
      },
      {
        name: "Fish Raid",
        value: "Gunakan `/fishraid regtime:<menit>` untuk membuka boss raid harian 25 turn. Berat ikan peserta mengisi quota bersama, dan result menampilkan ranking harian.",
        inline: false
      },
      {
        name: "FishDuel",
        value: "Gunakan `/fishduel target:<user> bet:<gold opsional>` untuk menantang pemain lain. Target menerima lewat tombol di channel. Yang lebih dulu memenuhi tas lawan menang.",
        inline: false
      },
      {
        name: "Voice Progress",
        value: "Gunakan `/fishvoice` saat kamu sedang berada di voice channel. Bot akan join dalam keadaan mute dan deafen, lalu pemain di voice channel server itu bisa mendapat fishing progress pasif.",
        inline: false
      },
      {
        name: "Detailed Guide",
        value: "Gunakan `/fishguide info:<nama>` untuk membaca panduan detail. Guide yang tersedia: `level`, `inventory`, `store`, `competition`, `fishraid`.",
        inline: false
      },
      {
        name: "Info Lanjutan",
        value: "Gunakan `/fishhelp` untuk melihat semua command yang tersedia.",
        inline: false
      }
    );
}

function makeLevelGuideEmbed() {
  const multiplier = Number(getSettings().levelExpMultiplier || 1);
  const lines = Array.from({ length: 10 }, (_, index) => {
    const level = index + 1;
    return `Level ${level} -> ${level + 1}: **${expForLevel(level)} EXP**`;
  });
  const embed = new EmbedBuilder()
    .setColor(0x3498db)
    .setTitle("TRFishing · Tabel Level")
    .setDescription([
      "# Level Guide",
      `Level EXP Multiplier saat ini: **x${multiplier}**`,
      "",
      "EXP didapat saat kamu berhasil menangkap ikan. Jumlah EXP dari ikan dikalikan dengan EXP Multiplier server dan buff event yang sedang aktif. Level dihitung dari total EXP kamu memakai rumus:",
      "`75 * level^1.7 * Level EXP Multiplier`",
      "",
      "Angka di bawah adalah total EXP yang dibutuhkan untuk naik dari level itu ke level berikutnya.",
      "",
      "━━━━━━━━━━━━━━━━━━━━"
    ].join("\n"));

  for (let index = 0; index < lines.length; index += 5) {
    embed.addFields({
      name: `Level ${index + 1}-${index + 5}`,
      value: lines.slice(index, index + 5).join("\n"),
      inline: false
    });
  }

  return embed;
}

function makeInventoryGuideEmbed() {
  return new EmbedBuilder()
    .setColor(0x3498db)
    .setTitle("TRFishing · Inventory Guide")
    .setDescription([
      "# Inventory Guide",
      "Inventory menyimpan semua ikan yang kamu tangkap dari fishing biasa.",
      "",
      "━━━━━━━━━━━━━━━━━━━━",
      "## Fungsi Inventory",
      "Gunakan `/fishinventory` untuk melihat ikan yang kamu punya, jumlah tiap ikan, rarity, range berat, EXP ikan, dan harga jualnya.",
      "",
      "## Jual Ikan",
      "Gunakan `/sellfish` untuk menjual semua ikan. Kalau hanya mau menjual satu jenis ikan, gunakan `/sellfish fish:<nama/id>`.",
      "",
      "## Gold, Rod, dan Fish Bag",
      "Gold dari hasil jual ikan bisa dipakai di `/fishstore` untuk membeli pancingan dan fish bag. Fish bag dibutuhkan untuk FishDuel."
    ].join("\n"));
}

function makeStoreGuideEmbed() {
  return new EmbedBuilder()
    .setColor(0x3498db)
    .setTitle("TRFishing · Store Guide")
    .setDescription([
      "# Store Guide",
      "Store dipakai untuk membeli dan memakai rod serta fish bag.",
      "",
      "━━━━━━━━━━━━━━━━━━━━",
      "## Kenapa Rod Penting",
      "Rod memengaruhi cara kamu memancing. **Speed** menentukan berapa banyak progress yang dibutuhkan, **Luck** membantu peluang ikan lebih bagus, **Max Kg** menentukan batas berat ikan yang bisa ditangkap, dan **Accuracy** dipakai saat kompetisi.",
      "",
      "## Cara Pakai",
      "Gunakan `/fishstore`, pilih rod atau fish bag dari menu, lalu beli atau gunakan item yang sudah kamu punya."
    ].join("\n"));
}

function makeCompetitionGuideEmbed() {
  return new EmbedBuilder()
    .setColor(0x3498db)
    .setTitle("TRFishing · Competition Guide")
    .setDescription([
      "# Competition Guide",
      "Competition adalah match publik tempat pemain berlomba menangkap ikan dalam beberapa turn.",
      "",
      "━━━━━━━━━━━━━━━━━━━━",
      "## Cara Mulai",
      "Gunakan `/fishcomp regtime:<menit> duration:<turn>`. Pemain lain ikut dengan tombol Join selama masa registrasi.",
      "",
      "## Saat Berjalan",
      "Setiap turn, semua peserta mencoba memancing memakai stat rod mereka. **Accuracy** menentukan peluang berhasil di tiap turn.",
      "",
      "## Hasil",
      "Ikan kompetisi tidak masuk inventory dan tidak memberi EXP normal. Pemenang mendapat hadiah EXP, lalu result menampilkan ringkasan dan tombol `📜 View Full History` untuk mengunduh log lengkap match.",
      "",
      "Kompetisi otomatis batal kalau kurang dari 2 peserta saat registrasi selesai."
    ].join("\n"));
}

function makeFishRaidGuideEmbed() {
  return new EmbedBuilder()
    .setColor(0x3498db)
    .setTitle("TRFishing · Fish Raid Guide")
    .setDescription([
      "# Fish Raid Guide",
      "Fish Raid adalah boss raid harian untuk memenuhi quota berat ikan bersama.",
      "",
      "━━━━━━━━━━━━━━━━━━━━",
      "## Cara Mulai",
      "Gunakan `/fishraid regtime:<menit>`. Raid selalu berjalan 25 turn. Pemain ikut dengan tombol Join selama masa registrasi.",
      "",
      "## Saat Berjalan",
      "Setiap turn, peserta mencoba memancing memakai stat rod mereka. Berat ikan yang tertangkap masuk ke quota harian, bukan inventory.",
      "",
      "## Hasil",
      "Saat raid berjalan, ranking hanya menghitung peserta raid itu. Saat result, ranking menampilkan total kontribusi seluruh hari. Setelah quota terpenuhi, raid hari itu terkunci sampai reset harian berikutnya.",
      "",
      "Hanya ada satu raid berjalan dalam satu server, dan raid berikutnya punya cooldown 1 jam setelah raid selesai."
    ].join("\n"));
}

function makeFishGuideMessage(info = "") {
  const embed = {
    level: makeLevelGuideEmbed,
    inventory: makeInventoryGuideEmbed,
    store: makeStoreGuideEmbed,
    competition: makeCompetitionGuideEmbed,
    fishraid: makeFishRaidGuideEmbed
  }[info]?.() || makeFishGuideEmbed();
  return makeMessageWithBanner(embed, makeSettingsImage("fishGuideBanner"));
}

const leaderboardPages = [
  { id: "fish_count", label: "Fish Count", title: "Jumlah Ikan" },
  { id: "biggest_fish", label: "Biggest Fish", title: "Ikan Terbesar" },
  { id: "fish_luck", label: "Fish Luck", title: "Luck Score Tertinggi" },
  { id: "fishcomp_wins", label: "FishComp Wins", title: "Pemenang FishComp Terbanyak" },
  { id: "level", label: "Level", title: "Level Tertinggi" }
];

function getLeaderboardName(record) {
  if (record.discordUserId) {
    return formatDiscordMention(record.discordUserId);
  }
  return record.displayName || record.username || record.playFabId;
}

function sortLeaderboardRecords(records, page) {
  const valueFor = {
    fish_count: (record) => Number(record.player.totalFishCaught || 0),
    biggest_fish: (record) => Number(record.player.heaviestFish?.weight || 0),
    fish_luck: (record) => Number(record.player.luckiestFish?.score || 0),
    fishcomp_wins: (record) => Number(record.player.fishCompWins || 0),
    level: (record) => getLevel(Number(record.player.exp || 0))
  }[page] || ((record) => Number(record.player.totalFishCaught || 0));
  return [...records].sort((a, b) => valueFor(b) - valueFor(a) || getLeaderboardName(a).localeCompare(getLeaderboardName(b)));
}

function makeLeaderboardLine(record, page, index) {
  const rank = index + 1;
  const name = getLeaderboardName(record);
  if (page === "biggest_fish") {
    const heaviest = record.player.heaviestFish;
    return `${rank}. ${name} - **${formatKg(heaviest?.weight || 0)}** (${heaviest?.name || "-"})`;
  }
  if (page === "fish_luck") {
    const luckiest = record.player.luckiestFish;
    return `${rank}. ${name} - **${Number(luckiest?.score || 0)}** (${luckiest?.name || "-"})`;
  }
  if (page === "level") {
    return `${rank}. ${name} - **Level ${getLevel(Number(record.player.exp || 0))}** (${Number(record.player.exp || 0)} EXP)`;
  }
  if (page === "fishcomp_wins") {
    return `${rank}. ${name} - **${Number(record.player.fishCompWins || 0)} menang**`;
  }
  return `${rank}. ${name} - **${Number(record.player.totalFishCaught || 0)} ikan**`;
}

async function makeLeaderboardMessage(page = "fish_count") {
  const selectedPage = leaderboardPages.some((entry) => entry.id === page) ? page : "fish_count";
  const records = sortLeaderboardRecords(await loadLeaderboardPlayersSafely(), selectedPage).slice(0, 10);
  const pageInfo = leaderboardPages.find((entry) => entry.id === selectedPage);
  const embed = new EmbedBuilder()
    .setColor(0x36c28a)
    .setTitle(`TRFishing Leaderboard · ${pageInfo.title}`)
    .setDescription(records.length ? records.map((record, index) => makeLeaderboardLine(record, selectedPage, index)).join("\n") : "Belum ada data pemain.");
  const select = new StringSelectMenuBuilder()
    .setCustomId("leaderboard_select")
    .setPlaceholder("Pilih halaman leaderboard")
    .addOptions(leaderboardPages.map((entry) => ({
      label: entry.label,
      value: entry.id,
      default: entry.id === selectedPage
    })));
  return makeEmbedPanelMessage(embed, {
    components: [new ActionRowBuilder().addComponents(select)]
  });
}

function makeSlashCommands() {
  return [
    {
      name: "fishprofile",
      description: "Lihat profil memancing kamu secara privat."
    },
    {
      name: "fishshowoff",
      description: "Pamerkan banner profil memancing kamu."
    },
    {
      name: "fishdaily",
      description: "Ambil hadiah harian memancing kamu."
    },
    {
      name: "fishinventory",
      description: "Lihat inventory ikan kamu secara privat."
    },
    {
      name: "sellfish",
      description: "Jual ikan kamu secara privat.",
      options: [
        {
          name: "fish",
          description: "Nama atau ID ikan. Kosongkan untuk jual semua ikan.",
          type: ApplicationCommandOptionType.String,
          required: false
        }
      ]
    },
    {
      name: "fishstore",
      description: "Lihat toko pancingan secara privat."
    },
    {
      name: "fishdex",
      description: "Lihat Fishdex ikan server secara privat."
    },
    {
      name: "fishvoice",
      description: "Minta bot join voice channel kamu untuk mengaktifkan progress voice."
    },
    {
      name: "fishsetpopupchannel",
      description: "Buat thread Fishing! untuk semua popup fishing server ini.",
      options: [
        {
          name: "channel",
          description: "Text channel tempat thread Fishing! akan dibuat.",
          type: ApplicationCommandOptionType.Channel,
          required: true,
          channel_types: [
            ChannelType.GuildText,
            ChannelType.GuildAnnouncement
          ]
        }
      ]
    },
    {
      name: "fishserver",
      description: "Lihat status server TRFishing."
    },
    {
      name: "fishleaderboard",
      description: "Lihat leaderboard TRFishing.",
      options: [
        {
          name: "page",
          description: "Halaman leaderboard yang ingin dilihat.",
          type: ApplicationCommandOptionType.String,
          required: false,
          choices: leaderboardPages.map((entry) => ({ name: entry.label, value: entry.id }))
        }
      ]
    },
    {
      name: "fishhelp",
      description: "Lihat bantuan command TRFishing secara privat."
    },
    {
      name: "fishguide",
      description: "Lihat panduan bermain TRFishing secara privat.",
      options: [
        {
          name: "info",
          description: "Pilih info panduan yang ingin dilihat.",
          type: ApplicationCommandOptionType.String,
          required: false,
          choices: [
            {
              name: "level",
              value: "level"
            },
            {
              name: "inventory",
              value: "inventory"
            },
            {
              name: "store",
              value: "store"
            },
            {
              name: "competition",
              value: "competition"
            },
            {
              name: "fishraid",
              value: "fishraid"
            }
          ]
        }
      ]
    },
    {
      name: "fishcomp",
      description: "Mulai kompetisi memancing di server ini.",
      options: [
        {
          name: "regtime",
          description: "Waktu daftar dalam menit. Default 5.",
          type: ApplicationCommandOptionType.Integer,
          required: false
        },
        {
          name: "duration",
      description: "Durasi kompetisi dalam jumlah turn. Default 15.",
          type: ApplicationCommandOptionType.Integer,
          required: false
        }
      ]
    },
    {
      name: "fishduel",
      description: "Tantang pemain lain dalam Duel Adu Dermawan.",
      options: [
        {
          name: "target",
          description: "Pemain yang ingin kamu tantang.",
          type: ApplicationCommandOptionType.User,
          required: false
        },
        {
          name: "bet",
          description: "Taruhan gold opsional.",
          type: ApplicationCommandOptionType.Integer,
          required: false
        }
      ]
    },
    {
      name: "fishraid",
      description: "Mulai boss raid ikan harian di server ini.",
      options: [
        {
          name: "regtime",
          description: "Waktu daftar dalam menit. Default 5.",
          type: ApplicationCommandOptionType.Integer,
          required: false
        }
      ]
    }
  ];
}

async function registerSlashCommands() {
  const commands = makeSlashCommands();
  const guilds = [...client.guilds.cache.values()];
  if (guilds.length) {
    await client.application.commands.set([]);
  } else {
    await client.application.commands.set(commands);
  }

  for (const guild of guilds) {
    await guild.commands.set(commands);
  }
}

async function handleCommand(message) {
  const [commandName = ""] = message.content.slice(prefix.length).trim().split(/\s+/);
  const command = commandName.toLowerCase();

  if (command === "fishcompforcestart") {
    if (!isAdmin(message.author)) {
      await message.reply("Only admins can force-start a fishing competition.");
      return;
    }
    const competition = competitions.get(message.guildId);
    if (!competition || competition.status !== "registration") {
      return;
    }
    if (competition.participants.size < 2) {
      await message.reply("Butuh minimal 2 peserta untuk memulai kompetisi.");
      return;
    }
    await message.reply("Kompetisi dipaksa mulai sekarang.");
    runCompetition(competition).catch((error) => {
      console.error("Competition force start failed:", error);
      competitions.delete(competition.guildId);
    });
    return;
  }

  if (command === "fishraidforcestart") {
    if (!isAdmin(message.author)) {
      await message.reply("Only admins can force-start a fish raid.");
      return;
    }
    const raid = fishRaids.get(message.guildId);
    if (!raid || raid.status !== "registration") {
      return;
    }
    if (raid.participants.size < 1) {
      await message.reply("Butuh minimal 1 peserta untuk memulai raid.");
      return;
    }
    await message.reply("Raid dipaksa mulai sekarang.");
    runCompetition(raid).catch((error) => {
      console.error("Fish raid force start failed:", error);
      fishRaids.delete(raid.guildId);
    });
    return;
  }

  if (command !== "fish" && command !== "fishtest") {
    return;
  }

  if (command === "fish" && !isActivityAllowed()) {
    await message.reply(activityBlockedMessage());
    return;
  }

  if (!isAdmin(message.author)) {
    await message.reply("Only admins can use this test fishing command.");
    return;
  }

  if (command === "fishtest") {
    await withPlayerReadOnly(message.author, async (player) => {
      const rod = getRod(player.rodId);
      if (!rod || gameData.fish.length === 0) {
        await message.reply("Fishing data is not ready yet. Check PlayFab item data.");
        return;
      }
      const catchResult = rollFish(rod, message.guildId);
      if (!catchResult) {
        await message.reply("No fish are configured yet.");
        return;
      }
      const expReward = calculateCatchExp(catchResult.fish, message.guildId);
      const popupChannel = await fetchFishingMessageChannel(null, message.guildId) || message.channel;
      await popupChannel.send(makeCatchMessage(message.author, catchResult.fish, catchResult.catchWeight, expReward.total, {
        expBase: expReward.base,
        expEventInfo: expReward.eventInfo
      }));
    });
    return;
  }

  await withPlayer(message.author, async (player) => {
    rememberFishingChannel(player, message.channel);
    const previousLevel = getLevel(player.exp);
    const result = fishNow(player, message.guildId);
    if (!result.ok) {
      await message.reply(result.message);
      return { save: false };
    }

    const popupChannel = await fetchFishingMessageChannel(player, message.guildId) || message.channel;
    await popupChannel.send(makeCatchMessage(message.author, result.caughtFish, result.catchWeight, result.expGain, {
      expBase: result.expBase,
      expEventInfo: result.expEventInfo
    }));
    const currentLevel = getLevel(player.exp);
    if (currentLevel > previousLevel) {
      const levelUpChannel = await fetchMainTextChannel(player, message.guildId, message.channel) || popupChannel;
      await levelUpChannel.send({ embeds: [makeLevelUpEmbed(message.author, currentLevel, message.member)] });
    }
  });
}

async function handleFishingProgress(message) {
  if (!isActivityAllowed()) {
    return;
  }
  if (!isPotentialFishingChat(message)) {
    return;
  }

  await withPlayer(message.author, async (player) => {
    if (!isValidFishingChat(message, player)) {
      return { save: false };
    }
    rememberFishingChannel(player, message.channel);

    const rod = getRod(player.rodId);
    if (!rod || gameData.fish.length === 0) {
      await message.channel.send("Fishing data is not ready yet. Check PlayFab item data.");
      return { save: false };
    }

    const previousLevel = getLevel(player.exp);
    const catches = addFishingProgress(player, 1, message.guildId);
    if (!catches.length) {
      return;
    }

    const popupChannel = await fetchFishingMessageChannel(player, message.guildId) || message.channel;
    for (const result of catches) {
      await popupChannel.send(makeCatchMessage(message.author, result.caughtFish, result.catchWeight, result.expGain, {
        expBase: result.expBase,
        expEventInfo: result.expEventInfo
      }));
    }
    const currentLevel = getLevel(player.exp);
    if (currentLevel > previousLevel) {
      const levelUpChannel = await fetchMainTextChannel(player, message.guildId, message.channel) || popupChannel;
      await levelUpChannel.send({ embeds: [makeLevelUpEmbed(message.author, currentLevel, message.member)] });
    }
  });
}

client.once("clientReady", async () => {
  console.log(`Logged in as ${client.user.tag}`);
  try {
    await registerSlashCommands();
    console.log("Registered slash commands.");
  } catch (error) {
    console.error("Could not register slash commands:", error);
  }
  await restoreFishVoiceChannels();
  await ensureFishCompRolesForGuilds();
  startVoiceExpTimer();
  scheduleEnforcedFishingSignal();
});

async function startFishCompFromInteraction(interaction, options = {}) {
  recordGuildActivity(interaction.guildId);
  if (!interaction.guildId) {
    await interaction.reply({ content: "Kompetisi hanya bisa dibuat di server.", flags: MessageFlags.Ephemeral });
    return;
  }
  if (competitions.has(interaction.guildId)) {
    await interaction.reply({ content: "Masih ada kompetisi yang berjalan di server ini.", flags: MessageFlags.Ephemeral });
    return;
  }

  const registrationMinutes = Math.max(1, Math.min(30, Number(options.regtimeMinutes || 5)));
  const turns = Math.max(1, Math.min(50, Number(options.durationTurns || 15)));
  const competition = {
    guildId: interaction.guildId,
    channelId: interaction.channelId,
    creatorId: interaction.user.id,
    startsAt: Date.now() + registrationMinutes * 60_000,
    turns,
    maxParticipants: 25,
    status: "registration",
    participants: new Map(),
    results: new Map(),
    logs: [],
    eventStates: new Map(),
    currentTurnEffects: new Map(),
    currentTurn: 0,
    logIntervalMs: Math.max(0, Number(getSettings().fishCompLogIntervalMs || 2500)),
    message: null,
    pingMessage: null,
    timeout: null
  };
  competitions.set(interaction.guildId, competition);
  await interaction.reply(makeCompetitionMessage(competition, "registration", makeCompetitionJoinRow(false)));
  competition.message = await interaction.fetchReply();
  logBotAction("Fish Comp registration opened", {
    guild: guildLogName(interaction.channel, interaction.guildId),
    channel: channelLogName(interaction.channel),
    extra: `startsInMinutes=${registrationMinutes} turns=${turns}`
  });
  const fishCompRole = interaction.guild ? await ensureFishCompRole(interaction.guild) : null;
  competition.pingMessage = await interaction.channel?.send({
    content: `## Ayo! Kompetisi memancing sudah dimulai!! ${fishCompRole ? fishCompRole.toString() : "@FishComp"}\n-# *buka /fishprofile dan tekan tombol untuk mendapatkan role @FishComp*`,
    allowedMentions: fishCompRole ? { roles: [fishCompRole.id] } : { parse: [] }
  }).catch(() => null);
  competition.timeout = setTimeout(() => {
    if (competition.participants.size < 2) {
      cancelCompetition(competition, competition.participants.size === 0 ? "Tidak ada peserta yang join." : "Butuh minimal 2 peserta untuk memulai kompetisi.");
      return;
    }
    runCompetition(competition).catch((error) => {
      console.error("Competition failed:", error);
      competitions.delete(competition.guildId);
    });
  }, registrationMinutes * 60_000);
}

function buyFishBag(player, fishBagId) {
  const bag = getFishBag(fishBagId);

  if (!bag) {
    return { ok: false, message: "Fish bag itu tidak ditemukan." };
  }

  if (!Array.isArray(player.ownedFishBags)) {
    player.ownedFishBags = [];
  }

  if (player.ownedFishBags.includes(bag.id)) {
    const changed = player.fishBagId !== bag.id;
    player.fishBagId = bag.id;
    return { ok: changed, message: `Berhasil memakai ${bag.name}.` };
  }

  if (player.gold < Number(bag.price || 0)) {
    return { ok: false, message: `Gold kamu kurang ${Number(bag.price || 0) - player.gold} untuk membeli ${bag.name}.` };
  }

  player.gold -= Number(bag.price || 0);
  player.ownedFishBags.push(bag.id);
  player.fishBagId = bag.id;
  return { ok: true, message: `Berhasil membeli dan memakai ${bag.name}.` };
}

function equipOwnedFishBag(player, fishBagId) {
  const bag = getFishBag(fishBagId);
  if (!bag) {
    return { ok: false, message: "Fish bag itu tidak ditemukan." };
  }
  if (!Array.isArray(player.ownedFishBags) || !player.ownedFishBags.includes(bag.id)) {
    return { ok: false, message: "Kamu belum punya fish bag itu." };
  }
  player.fishBagId = bag.id;
  return { ok: true, message: `Berhasil memakai ${bag.name}.` };
}

async function startFishRaidFromInteraction(interaction, options = {}) {
  recordGuildActivity(interaction.guildId);
  if (!interaction.guildId) {
    await interaction.reply({ content: "Raid hanya bisa dibuat di server.", flags: MessageFlags.Ephemeral });
    return;
  }
  const dailyState = normalizeDailyRaidState(interaction.guildId);
  if (dailyState.fulfilledAt) {
    await interaction.reply({ content: "Quota raid hari ini sudah terpenuhi. Raid berikutnya tersedia setelah reset harian.", flags: MessageFlags.Ephemeral });
    return;
  }
  if (fishRaids.has(interaction.guildId)) {
    await interaction.reply({ content: "Masih ada fish raid yang berjalan di server ini.", flags: MessageFlags.Ephemeral });
    return;
  }
  const cooldownRemainingMs = getRaidCooldownRemainingMs(interaction.guildId);
  if (cooldownRemainingMs > 0) {
    await interaction.reply({ content: `Fish raid masih cooldown. Coba lagi dalam ${formatDurationIndonesian(cooldownRemainingMs)}.`, flags: MessageFlags.Ephemeral });
    return;
  }

  const registrationMinutes = Math.max(1, Math.min(30, Number(options.regtimeMinutes || 5)));
  dailyState.channelId = interaction.channelId;
  saveFishRaidState();
  const raid = {
    mode: "raid",
    guildId: interaction.guildId,
    channelId: interaction.channelId,
    creatorId: interaction.user.id,
    startsAt: Date.now() + registrationMinutes * 60_000,
    turns: 25,
    maxParticipants: 25,
    status: "registration",
    participants: new Map(),
    results: new Map(),
    logs: [],
    eventStates: new Map(),
    currentTurnEffects: new Map(),
    currentTurn: 0,
    raidGainedWeight: 0,
    logIntervalMs: Math.max(0, Number(getSettings().fishRaidLogIntervalMs ?? getSettings().fishCompLogIntervalMs ?? 2500)),
    message: null,
    pingMessage: null,
    timeout: null
  };
  fishRaids.set(interaction.guildId, raid);
  await interaction.reply(makeCompetitionMessage(raid, "registration", makeFishRaidJoinRow(false)));
  raid.message = await interaction.fetchReply();
  logBotAction("Fish Raid registration opened", {
    guild: guildLogName(interaction.channel, interaction.guildId),
    channel: channelLogName(interaction.channel),
    extra: `startsInMinutes=${registrationMinutes} turns=${raid.turns} boss=${dailyState.boss.name}`
  });
  const fishCompRole = interaction.guild ? await ensureFishCompRole(interaction.guild) : null;
  raid.pingMessage = await interaction.channel?.send({
    content: `## Fish Raid dibuka! ${fishCompRole ? fishCompRole.toString() : "@FishComp"}\nBoss hari ini: **${dailyState.boss.name}** · Quota **${formatKg(dailyState.quotaKg)}**\n-# *Join raid untuk bantu memenuhi pesanan ikan hari ini.*`,
    allowedMentions: fishCompRole ? { roles: [fishCompRole.id] } : { parse: [] }
  }).catch(() => null);
  raid.timeout = setTimeout(() => {
    if (raid.participants.size < 1) {
      cancelCompetition(raid, "Tidak ada peserta yang join.");
      return;
    }
    runCompetition(raid).catch((error) => {
      console.error("Fish raid failed:", error);
      fishRaids.delete(raid.guildId);
    });
  }, registrationMinutes * 60_000);
}

function makeFishDuelKey(guildId, userIdA, userIdB) {
  return `${guildId}:${[userIdA, userIdB].sort().join(":")}`;
}

function hasActiveFishDuel(guildId, userIdA = "", userIdB = "") {
  const userIds = new Set([userIdA, userIdB].filter(Boolean));
  return [...fishDuels.values()].some((duel) => {
    if (!["registration", "running"].includes(duel.status)) {
      return false;
    }
    if (duel.guildId !== guildId) {
      return false;
    }
    return [duel.creatorId, duel.targetId].some((userId) => userIds.has(userId));
  });
}

function forgetFishDuel(duel) {
  if (!duel) {
    return;
  }
  if (duel.timeout) {
    clearTimeout(duel.timeout);
    duel.timeout = null;
  }
  duel.status = "cancelled";
  fishDuels.delete(duel.duelKey);
}

async function isDiscordMessageStillAvailable(channelId, messageId) {
  if (!channelId || !messageId) {
    return true;
  }
  const channel = await client.channels.fetch(channelId).catch(() => null);
  if (!channel?.messages?.fetch) {
    return true;
  }
  const message = await channel.messages.fetch(messageId).catch(() => null);
  return Boolean(message);
}

async function cleanupDeletedFishDuelMessages(guildId = "") {
  for (const duel of [...fishDuels.values()]) {
    if (guildId && duel.guildId !== guildId) {
      continue;
    }
    const registrationMessageId = duel.message?.id || "";
    const logMessageId = duel.logMessage?.id || "";
    const registrationExists = await isDiscordMessageStillAvailable(duel.channelId, registrationMessageId);
    const logExists = await isDiscordMessageStillAvailable(duel.channelId, logMessageId);
    if (!registrationExists || !logExists) {
      forgetFishDuel(duel);
    }
  }
}

function makeParticipantFromUser(user, member = null) {
  const memberDisplayName = member?.displayName || user.globalName || user.username;
  const globalDisplayName = user.globalName || user.username;
  return {
    id: user.id,
    username: user.username,
    globalName: globalDisplayName,
    displayName: formatDiscordMention(user.id),
    logName: memberDisplayName
  };
}

async function chargeFishDuelBet(duel) {
  const betAmount = Math.max(0, Math.floor(Number(duel.betAmount || 0)));
  if (betAmount <= 0) {
    return { ok: true };
  }

  for (const userId of [duel.creatorId, duel.targetId]) {
    let enoughGold = false;
    await withPlayer(userId, async (player) => {
      enoughGold = Number(player.gold || 0) >= betAmount;
      if (enoughGold) {
        player.gold = Math.max(0, Math.floor(Number(player.gold || 0))) - betAmount;
      }
      return enoughGold ? undefined : { save: false };
    });
    if (!enoughGold) {
      for (const refundUserId of [duel.creatorId, duel.targetId].filter((id) => id !== userId)) {
        await withPlayer(refundUserId, async (player) => {
          player.gold = Math.max(0, Math.floor(Number(player.gold || 0))) + betAmount;
        });
      }
      return { ok: false, message: "Salah satu pemain tidak punya cukup gold untuk taruhan saat duel diterima." };
    }
  }

  return { ok: true };
}

async function startFishDuelFromPending(interaction, pending) {
  const channel = await client.channels.fetch(pending.channelId).catch(() => null);
  if (!channel?.isTextBased?.()) {
    await interaction.reply({ content: "Channel duel sudah tidak tersedia.", flags: MessageFlags.Ephemeral });
    return;
  }

  if (!pending.target?.id) {
    if (!interaction.user || interaction.user.id === pending.creator.id) {
      await interaction.reply({ content: "Hey! Kamu tidak bisa menerima duelmu sendiri!", flags: MessageFlags.Ephemeral });
      return;
    }
    pending.targetId = interaction.user.id;
    pending.target = {
      id: interaction.user.id,
      username: interaction.user.username,
      globalName: interaction.user.globalName,
      displayName: interaction.user.displayName
    };
  }

  const duelKey = makeFishDuelKey(pending.guildId, pending.creator.id, pending.target.id);
  await cleanupDeletedFishDuelMessages(pending.guildId);
  if (hasActiveFishDuel(pending.guildId, pending.creator.id, pending.target.id)) {
    await interaction.reply({ content: "Salah satu pemain masih berada di duel lain.", flags: MessageFlags.Ephemeral });
    return;
  }

  let creatorPlayer = null;
  let targetPlayer = null;
  await withPlayerReadOnly(pending.creator.id, async (player) => { creatorPlayer = player; });
  await withPlayerReadOnly(pending.target.id, async (player) => { targetPlayer = player; });
  if (!hasEquippedFishBag(creatorPlayer) || !hasEquippedFishBag(targetPlayer)) {
    await interaction.reply({ content: "Kedua pemain harus punya fish bag yang sedang dipakai untuk mulai duel.", flags: MessageFlags.Ephemeral });
    return;
  }

  const creatorMember = await channel.guild?.members.fetch(pending.creator.id).catch(() => null);
  const targetMember = await channel.guild?.members.fetch(pending.target.id).catch(() => null);
  const creatorParticipant = makeParticipantFromUser(pending.creator, creatorMember);
  const targetParticipant = makeParticipantFromUser(pending.target, targetMember);
  creatorParticipant.level = getLevel(creatorPlayer.exp);
  targetParticipant.level = getLevel(targetPlayer.exp);
  creatorParticipant.fishBagId = creatorPlayer.fishBagId;
  targetParticipant.fishBagId = targetPlayer.fishBagId;
  const creatorSpace = getEffectiveFishBagSpace(creatorPlayer, { mode: "duel", target: "self", userLevel: creatorParticipant.level, opponentLevel: targetParticipant.level });
  const targetSpace = getEffectiveFishBagSpace(targetPlayer, { mode: "duel", target: "self", userLevel: targetParticipant.level, opponentLevel: creatorParticipant.level });

  const betCharge = await chargeFishDuelBet(pending);
  if (!betCharge.ok) {
    await interaction.reply({ content: betCharge.message, flags: MessageFlags.Ephemeral });
    return;
  }

  const duel = {
    mode: "duel",
    duelKey,
    guildId: pending.guildId,
    channelId: pending.channelId,
    creatorId: pending.creator.id,
    targetId: pending.target.id,
    startsAt: Date.now(),
    maxParticipants: 2,
    status: "registration",
    participants: new Map([[creatorParticipant.id, creatorParticipant], [targetParticipant.id, targetParticipant]]),
    results: new Map([
      [creatorParticipant.id, { ...creatorParticipant, count: 0, totalWeight: 0, heaviestWeight: 0, heaviestName: "", bagFilled: 0, bagSpaceKg: creatorSpace, opponentSpaceKg: targetSpace, opponentFilledAt: 0 }],
      [targetParticipant.id, { ...targetParticipant, count: 0, totalWeight: 0, heaviestWeight: 0, heaviestName: "", bagFilled: 0, bagSpaceKg: targetSpace, opponentSpaceKg: creatorSpace, opponentFilledAt: 0 }]
    ]),
    logs: [],
    eventStates: new Map(),
    currentTurnEffects: new Map(),
    currentTurn: 0,
    winnerId: "",
    betAmount: Math.max(0, Math.floor(Number(pending.betAmount || 0))),
    logIntervalMs: Math.max(0, Number(getSettings().fishDuelLogIntervalMs ?? getSettings().fishCompLogIntervalMs ?? 2500)),
    message: null,
    timeout: null
  };
  fishDuels.set(duelKey, duel);
  duel.message = interaction.message || null;
  await interaction.update(makeCompetitionMessage(duel, "registration", [])).catch(() => {});
  runCompetition(duel).catch((error) => {
    console.error("Fish duel failed:", error);
    fishDuels.delete(duel.duelKey);
  });
}

async function handleRoutineButton(interaction) {
  const [, routineId, buttonId] = interaction.customId.split(":");
  const routine = getRoutineMessages().find((entry) => entry.id === routineId);
  const button = routine?.buttons?.find((entry) => entry.id === buttonId);
  if (!routine || !button) {
    await interaction.reply({ content: "Routine button ini sudah tidak aktif.", flags: MessageFlags.Ephemeral });
    return;
  }

  if (routine.deleteAfterButtonClick) {
    interaction.message?.delete?.().catch(() => {});
  }

  if (["fishcomp", "fishraid", "fishstore", "fishdex", "fishdaily"].includes(button.action) && !isActivityAllowed()) {
    await interaction.reply({ content: activityBlockedMessage(), flags: MessageFlags.Ephemeral });
    return;
  }

  if (button.action === "fishcomp") {
    await startFishCompFromInteraction(interaction, button);
    return;
  }
  if (button.action === "fishraid") {
    await startFishRaidFromInteraction(interaction, button);
    return;
  }
  if (button.action === "fishstore") {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    await withPlayerReadOnly(interaction.user, async (player) => interaction.editReply(makeStoreMessage(player)));
    return;
  }
  if (button.action === "fishdex") {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    await withPlayerReadOnly(interaction.user, async (player) => interaction.editReply(makeFishDexMessage(interaction.user, player, "", interaction.guildId)));
    return;
  }
  if (button.action === "fishdaily") {
    await replyWithFishDaily(interaction);
    return;
  }
  if (button.action === "fishguide") {
    await interaction.reply({ ...makeFishGuideMessage(""), flags: MessageFlags.Ephemeral });
    return;
  }
  if (button.action === "fishprofile") {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const member = interaction.guild?.members?.fetch ? await interaction.guild.members.fetch(interaction.user.id).catch(() => null) : null;
    await withPlayerReadOnly(interaction.user, async (player) => interaction.editReply(makeProfileMessage(interaction.user, player, member, interaction.guildId)));
    return;
  }
  if (button.action === "fishleaderboard") {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    await interaction.editReply(await makeLeaderboardMessage("fish_count"));
    return;
  }

  await interaction.reply({ content: "Action routine ini belum dikenali.", flags: MessageFlags.Ephemeral });
}

client.on("interactionCreate", async (interaction) => {
  try {
    if (interaction.isButton() && interaction.customId.startsWith("routine:")) {
      await handleRoutineButton(interaction);
      return;
    }

    if (interaction.isButton() && (interaction.customId.startsWith("fishduel_accept:") || interaction.customId.startsWith("fishduel_decline:"))) {
      const [action, duelId] = interaction.customId.split(":");
      const pending = getPendingFishDuel(duelId);
      if (!pending) {
        await interaction.reply({ content: "Permintaan duel ini sudah tidak aktif.", flags: MessageFlags.Ephemeral });
        return;
      }
      if (pending.target.id !== interaction.user.id) {
        await interaction.reply({ content: "Permintaan duel ini bukan untuk kamu.", flags: MessageFlags.Ephemeral });
        return;
      }
      deletePendingFishDuel(duelId);
      if (action === "fishduel_decline") {
        await interaction.update({ content: `Duel dari ${pending.creator.username} ditolak.`, components: [] });
        return;
      }
      await startFishDuelFromPending(interaction, pending);
      return;
    }

    if (interaction.isButton() && (interaction.customId.startsWith("fishduel_open_accept:") || interaction.customId.startsWith("fishduel_open_cancel:"))) {
      const isAccept = interaction.customId.startsWith("fishduel_open_accept:");
      const duelId = interaction.customId.slice(isAccept ? "fishduel_open_accept:".length : "fishduel_open_cancel:".length);
      const pending = getPendingFishDuel(duelId);
      if (!pending) {
        await interaction.reply({ content: "Open duel ini sudah tidak aktif.", flags: MessageFlags.Ephemeral });
        return;
      }
      if (!isAccept) {
        if (interaction.user.id !== pending.creator.id && !isAdmin(interaction.user)) {
          await interaction.reply({ content: "Hey! Ini bukan duelmu, kamu tidak bisa membatalkannya", flags: MessageFlags.Ephemeral });
          return;
        }
        deletePendingFishDuel(duelId);
        await interaction.message?.delete?.().catch(() => {});
        await interaction.reply({ content: "Open duel dibatalkan.", flags: MessageFlags.Ephemeral }).catch(() => {});
        return;
      }
      if (interaction.user.id === pending.creator.id) {
        await interaction.reply({ content: "Hey! Kamu tidak bisa menerima duelmu sendiri!", flags: MessageFlags.Ephemeral });
        return;
      }
      if (!isActivityAllowed()) {
        await interaction.reply({ content: activityBlockedMessage(), flags: MessageFlags.Ephemeral });
        return;
      }
      let accepterPlayer = null;
      await withPlayerReadOnly(interaction.user, async (player) => { accepterPlayer = player; });
      if (!hasEquippedFishBag(accepterPlayer)) {
        await interaction.reply({ content: "Kamu belum memakai fish bag. Beli dan equip fish bag dulu lewat `/fishstore`.", flags: MessageFlags.Ephemeral });
        return;
      }
      if (Number(pending.betAmount || 0) > 0 && Number(accepterPlayer.gold || 0) < Number(pending.betAmount || 0)) {
        await interaction.reply({ content: "Gold kamu belum cukup untuk menerima taruhan duel ini.", flags: MessageFlags.Ephemeral });
        return;
      }
      deletePendingFishDuel(duelId);
      await startFishDuelFromPending(interaction, pending);
      return;
    }

    if (interaction.isStringSelectMenu() && interaction.customId === "leaderboard_select") {
      await interaction.deferUpdate();
      await interaction.editReply(await makeLeaderboardMessage(interaction.values[0]));
      return;
    }

    if (interaction.isStringSelectMenu() && interaction.customId.startsWith("fishdex_select:")) {
      const [, ownerId, pageValue] = interaction.customId.split(":");
      if (ownerId && ownerId !== interaction.user.id) {
        await interaction.reply({ content: "Fishdex ini punya pemain lain.", flags: MessageFlags.Ephemeral });
        return;
      }
      await interaction.deferUpdate();
      await withPlayerReadOnly(interaction.user, async (player) => {
        await interaction.editReply(makeFishDexMessage(interaction.user, player, interaction.values[0], interaction.guildId, Number(pageValue || 0)));
      });
      return;
    }

    if (interaction.isButton() && interaction.customId.startsWith("fishdex_page:")) {
      const [, ownerId, pageValue] = interaction.customId.split(":");
      if (ownerId && ownerId !== interaction.user.id) {
        await interaction.reply({ content: "Fishdex ini punya pemain lain.", flags: MessageFlags.Ephemeral });
        return;
      }
      await interaction.deferUpdate();
      await withPlayerReadOnly(interaction.user, async (player) => {
        await interaction.editReply(makeFishDexMessage(interaction.user, player, "", interaction.guildId, Number(pageValue || 0)));
      });
      return;
    }

    if (interaction.isButton() && interaction.customId.startsWith("fishdex_showcase:")) {
      const [, ownerId, pageValue, selectedFishId] = interaction.customId.split(":");
      if (ownerId && ownerId !== interaction.user.id) {
        await interaction.reply({ content: "Fishdex ini punya pemain lain.", flags: MessageFlags.Ephemeral });
        return;
      }

      await interaction.deferUpdate();
      const member = interaction.guild?.members?.fetch
        ? await interaction.guild.members.fetch(interaction.user.id).catch(() => null)
        : null;
      await withPlayer(interaction.user, async (player) => {
        const selectedFish = getAvailableFish(interaction.guildId).find((fishEntry) => fishEntry.id === selectedFishId);
        if (!selectedFish || !getFishDexEntry(player, selectedFish).caught) {
          await interaction.editReply(makeFishDexMessage(interaction.user, player, selectedFishId, interaction.guildId, Number(pageValue || 0)));
          return { save: false };
        }
        player.showcasedFishId = selectedFish.id;
        await interaction.editReply(makeFishDexMessage(interaction.user, player, selectedFish.id, interaction.guildId, Number(pageValue || 0)));
        const showoffMessage = await interaction.channel?.send(await makeFishShowoffMessage(interaction.user, player, member, interaction.guildId)).catch((error) => {
          console.error("Could not send fishdex showcase showoff message:", error);
          return null;
        });
        scheduleMessageDelete(showoffMessage);
        return undefined;
      });
      return;
    }

    if (interaction.isStringSelectMenu() && interaction.customId.startsWith("rod_select:")) {
      const selectedRodId = interaction.values[0];
      await interaction.deferUpdate();
      await withPlayerReadOnly(interaction.user, async (player) => {
        await interaction.editReply(makeStoreMessage(player, selectedRodId));
      });
      return;
    }

    if (interaction.isStringSelectMenu() && interaction.customId === "profile_rod_select") {
      const selectedRodId = interaction.values[0];
      await interaction.deferUpdate();
      const member = interaction.guild?.members?.fetch
        ? await interaction.guild.members.fetch(interaction.user.id).catch(() => null)
        : null;
      await withPlayer(interaction.user, async (player) => {
        const result = equipOwnedRod(player, selectedRodId);
        await interaction.editReply(makeProfileMessage(interaction.user, player, member, interaction.guildId));
        return result.ok ? undefined : { save: false };
      });
      return;
    }

    if (interaction.isStringSelectMenu() && interaction.customId === "profile_fishbag_select") {
      const selectedFishBagId = interaction.values[0];
      await interaction.deferUpdate();
      const member = interaction.guild?.members?.fetch
        ? await interaction.guild.members.fetch(interaction.user.id).catch(() => null)
        : null;
      await withPlayer(interaction.user, async (player) => {
        const result = equipOwnedFishBag(player, selectedFishBagId);
        await interaction.editReply(makeProfileMessage(interaction.user, player, member, interaction.guildId));
        return result.ok ? undefined : { save: false };
      });
      return;
    }

    if (interaction.isButton() && interaction.customId.startsWith("rod_buy:")) {
      if (!isActivityAllowed()) {
        await interaction.reply({ content: activityBlockedMessage(), flags: MessageFlags.Ephemeral });
        return;
      }
      const selectedRodId = interaction.customId.split(":")[1] || "";
      await interaction.deferUpdate();
      await withPlayer(interaction.user, async (player) => {
        const result = buyRod(player, selectedRodId);
        await interaction.editReply(makeStoreMessage(player, selectedRodId, result.message));
        return result.ok ? undefined : { save: false };
      });
      return;
    }

    if (interaction.isStringSelectMenu() && interaction.customId.startsWith("fishbag_select:")) {
      const selectedFishBagId = interaction.values[0];
      await interaction.deferUpdate();
      await withPlayerReadOnly(interaction.user, async (player) => {
        await interaction.editReply(makeStoreMessage(player, null, "", selectedFishBagId));
      });
      return;
    }

    if (interaction.isButton() && interaction.customId.startsWith("fishbag_buy:")) {
      if (!isActivityAllowed()) {
        await interaction.reply({ content: activityBlockedMessage(), flags: MessageFlags.Ephemeral });
        return;
      }
      const selectedFishBagId = interaction.customId.split(":")[1] || "";
      await interaction.deferUpdate();
      await withPlayer(interaction.user, async (player) => {
        const result = buyFishBag(player, selectedFishBagId);
        await interaction.editReply(makeStoreMessage(player, null, result.message, selectedFishBagId));
        return result.ok ? undefined : { save: false };
      });
      return;
    }

    if (interaction.isButton() && (interaction.customId === "catch_showcase" || interaction.customId.startsWith("catch_showcase:"))) {
      const ownerId = interaction.customId.startsWith("catch_showcase:")
        ? interaction.customId.slice("catch_showcase:".length)
        : "";
      if (ownerId && ownerId !== "unknown" && ownerId !== interaction.user.id) {
        await interaction.reply({ content: "Hey, bukan ikan kamu, enak aja kamu pamer pamer 😤💢", flags: MessageFlags.Ephemeral });
        return;
      }
      await handleCatchShowcase(interaction);
      return;
    }

    if (interaction.isButton() && interaction.customId.startsWith("fishcomp_history:")) {
      cleanupFinishedCompetitionLogs();
      const logId = interaction.customId.slice("fishcomp_history:".length);
      const log = finishedCompetitionLogs.get(logId);
      if (!log) {
        await interaction.reply({ content: "History log ini sudah tidak tersedia. Log disimpan sementara setelah kompetisi selesai.", flags: MessageFlags.Ephemeral });
        return;
      }
      await interaction.reply({
        files: [
          new AttachmentBuilder(Buffer.from(log.content, "utf8"), { name: log.fileName || "match_log.txt" })
        ],
        flags: MessageFlags.Ephemeral
      });
      return;
    }

    if (interaction.isButton() && interaction.customId.startsWith("fishraid_history:")) {
      cleanupFinishedCompetitionLogs();
      const logId = interaction.customId.slice("fishraid_history:".length);
      const log = finishedCompetitionLogs.get(logId);
      if (!log) {
        await interaction.reply({ content: "History log raid ini sudah tidak tersedia. Log disimpan sementara setelah raid selesai.", flags: MessageFlags.Ephemeral });
        return;
      }
      await interaction.reply({
        files: [
          new AttachmentBuilder(Buffer.from(log.content, "utf8"), { name: log.fileName || "fishraid_log.txt" })
        ],
        flags: MessageFlags.Ephemeral
      });
      return;
    }

    if (interaction.isButton() && interaction.customId === "fishcomp_join") {
      if (!isActivityAllowed()) {
        await interaction.reply({ content: activityBlockedMessage(), flags: MessageFlags.Ephemeral });
        return;
      }
      const competition = competitions.get(interaction.guildId);
      if (!competition || competition.status !== "registration") {
        await interaction.reply({ content: "Registrasi sudah ditutup.", flags: MessageFlags.Ephemeral });
        return;
      }

      const memberDisplayName = interaction.member?.displayName || interaction.user.globalName || interaction.user.username;
      const globalDisplayName = interaction.user.globalName || interaction.user.username;
      competition.participants.set(interaction.user.id, {
        id: interaction.user.id,
        username: interaction.user.username,
        globalName: globalDisplayName,
        displayName: formatDiscordMention(interaction.user.id),
        logName: memberDisplayName
      });
      competition.results.set(interaction.user.id, {
        id: interaction.user.id,
        username: interaction.user.username,
        globalName: globalDisplayName,
        displayName: formatDiscordMention(interaction.user.id),
        logName: memberDisplayName,
        count: 0,
        totalWeight: 0,
        heaviestWeight: 0,
        heaviestName: ""
      });
      await interaction.update(makeCompetitionMessage(competition, "registration", makeCompetitionJoinRow(false)));
      return;
    }

    if (interaction.isButton() && interaction.customId === "fishcomp_leave") {
      const competition = competitions.get(interaction.guildId);
      if (!competition || competition.status !== "registration") {
        await interaction.reply({ content: "Registrasi sudah ditutup.", flags: MessageFlags.Ephemeral });
        return;
      }
      if (!competition.participants.has(interaction.user.id)) {
        await interaction.reply({ content: "Kamu belum join kompetisi ini.", flags: MessageFlags.Ephemeral });
        return;
      }

      competition.participants.delete(interaction.user.id);
      competition.results.delete(interaction.user.id);
      await interaction.update(makeCompetitionMessage(competition, "registration", makeCompetitionJoinRow(false)));
      return;
    }

    if (interaction.isButton() && interaction.customId === "fishcomp_cancel") {
      const competition = competitions.get(interaction.guildId);
      if (!competition || competition.status !== "registration") {
        await interaction.reply({ content: "Kompetisi ini sudah tidak bisa dibatalkan.", flags: MessageFlags.Ephemeral });
        return;
      }
      if (interaction.user.id !== competition.creatorId && !isAdmin(interaction.user)) {
        await interaction.reply({ content: "Hanya pembuat kompetisi atau admin yang bisa membatalkan kompetisi ini.", flags: MessageFlags.Ephemeral });
        return;
      }

      await interaction.deferUpdate();
      await cancelCompetition(competition, "Kompetisi dibatalkan.");
      return;
    }

    if (interaction.isButton() && interaction.customId === "fishraid_join") {
      if (!isActivityAllowed()) {
        await interaction.reply({ content: activityBlockedMessage(), flags: MessageFlags.Ephemeral });
        return;
      }
      const raid = fishRaids.get(interaction.guildId);
      if (!raid || raid.status !== "registration") {
        await interaction.reply({ content: "Registrasi raid sudah ditutup.", flags: MessageFlags.Ephemeral });
        return;
      }

      const memberDisplayName = interaction.member?.displayName || interaction.user.globalName || interaction.user.username;
      const globalDisplayName = interaction.user.globalName || interaction.user.username;
      raid.participants.set(interaction.user.id, {
        id: interaction.user.id,
        username: interaction.user.username,
        globalName: globalDisplayName,
        displayName: formatDiscordMention(interaction.user.id),
        logName: memberDisplayName
      });
      raid.results.set(interaction.user.id, {
        id: interaction.user.id,
        username: interaction.user.username,
        globalName: globalDisplayName,
        displayName: formatDiscordMention(interaction.user.id),
        logName: memberDisplayName,
        count: 0,
        totalWeight: 0,
        heaviestWeight: 0,
        heaviestName: ""
      });
      await interaction.update(makeCompetitionMessage(raid, "registration", makeFishRaidJoinRow(false)));
      return;
    }

    if (interaction.isButton() && interaction.customId === "fishraid_cancel") {
      const raid = fishRaids.get(interaction.guildId);
      if (!raid || raid.status !== "registration") {
        await interaction.reply({ content: "Raid ini sudah tidak bisa dibatalkan.", flags: MessageFlags.Ephemeral });
        return;
      }
      if (interaction.user.id !== raid.creatorId && !isAdmin(interaction.user)) {
        await interaction.reply({ content: "Hanya pembuat raid atau admin yang bisa membatalkan raid ini.", flags: MessageFlags.Ephemeral });
        return;
      }

      await interaction.deferUpdate();
      await cancelCompetition(raid, "Raid dibatalkan.");
      return;
    }

    if (interaction.isButton() && interaction.customId === "fishcomp_role_toggle") {
      if (!interaction.guild || !interaction.member) {
        await interaction.reply({ content: "Role FishComp hanya bisa dipakai di server.", flags: MessageFlags.Ephemeral });
        return;
      }

      await interaction.deferUpdate();
      const role = await ensureFishCompRole(interaction.guild);
      const member = await interaction.guild.members.fetch(interaction.user.id).catch(() => null);
      if (!role || !member) {
        await interaction.editReply(makeSimplePanelMessage(
          "Role FishComp Belum Siap",
          "Aku belum bisa menyiapkan role FishComp. Pastikan bot punya permission Manage Roles."
        ));
        return;
      }

      const hadRole = member.roles.cache.has(role.id);
      if (hadRole) {
        await member.roles.remove(role, "TRFishing FishComp opt-out");
      } else {
        await member.roles.add(role, "TRFishing FishComp opt-in");
      }
      const hasRole = !hadRole;

      await withPlayerReadOnly(interaction.user, async (player) => {
        await interaction.editReply(makeProfileMessage(interaction.user, player, member, interaction.guildId, hasRole));
      });
      return;
    }

    if (!interaction.isChatInputCommand()) {
      return;
    }

    if (["sellfish", "fishstore", "fishdex", "fishvoice", "fishshowoff", "fishdaily", "fishcomp", "fishduel", "fishraid"].includes(interaction.commandName) && !isActivityAllowed()) {
      await interaction.reply({ content: activityBlockedMessage(), flags: MessageFlags.Ephemeral });
      return;
    }

    if (interaction.commandName === "fishprofile") {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const member = interaction.guild?.members?.fetch
        ? await interaction.guild.members.fetch(interaction.user.id).catch(() => null)
        : null;
      await withPlayerReadOnly(interaction.user, async (player) => {
        await interaction.editReply(makeProfileMessage(interaction.user, player, member, interaction.guildId));
      });
      return;
    }

    if (interaction.commandName === "fishshowoff") {
      await interaction.deferReply();
      const member = interaction.guild?.members?.fetch
        ? await interaction.guild.members.fetch(interaction.user.id).catch(() => null)
        : null;
      await withPlayerReadOnly(interaction.user, async (player) => {
        const selectedFish = getFishShowoffFish(player, interaction.guildId);
        const showoffMessage = await interaction.editReply(await makeFishShowoffMessage(interaction.user, player, member, interaction.guildId));
        scheduleMessageDelete(showoffMessage);
      });
      return;
    }

    if (interaction.commandName === "fishdaily") {
      await replyWithFishDaily(interaction);
      return;
    }

    if (interaction.commandName === "fishinventory") {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      await withPlayerReadOnly(interaction.user, async (player) => {
        await interaction.editReply({ embeds: [makeInventoryEmbed(interaction.user, player, interaction.guildId)] });
      });
      return;
    }

    if (interaction.commandName === "sellfish") {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      await withPlayer(interaction.user, async (player) => {
        const result = sellFish(player, interaction.options.getString("fish") || "", interaction.guildId);
        await interaction.editReply(result.message);
        return result.ok ? undefined : { save: false };
      });
      return;
    }

    if (interaction.commandName === "fishstore") {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      await withPlayerReadOnly(interaction.user, async (player) => {
        await interaction.editReply(makeStoreMessage(player));
      });
      return;
    }

    if (interaction.commandName === "fishdex") {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      await withPlayerReadOnly(interaction.user, async (player) => {
        await interaction.editReply(makeFishDexMessage(interaction.user, player, "", interaction.guildId));
      });
      return;
    }

    if (interaction.commandName === "fishvoice") {
      if (!interaction.guildId || !interaction.guild) {
        await interaction.reply({ content: "Command ini hanya bisa dipakai di server.", flags: MessageFlags.Ephemeral });
        return;
      }

      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const member = await interaction.guild.members.fetch(interaction.user.id);
      const channel = member.voice.channel;
      if (!channel?.isVoiceBased?.()) {
        await interaction.editReply("Masuk ke voice channel dulu, lalu pakai `/fishvoice` lagi.");
        return;
      }
      if (channel.joinable === false) {
        await interaction.editReply("Aku belum punya izin untuk join voice channel itu.");
        return;
      }

      await joinFishVoiceChannel(channel);
      await reconcileGuildVoiceSessions(interaction.guild);
      await interaction.editReply(`Aku sudah join **${channel.name}** dalam keadaan mute dan deafen. Voice progress aktif untuk server ini.`);
      return;
    }

    if (interaction.commandName === "fishsetpopupchannel") {
      if (!interaction.guildId || !interaction.guild) {
        await interaction.reply({ content: "Command ini hanya bisa dipakai di server.", flags: MessageFlags.Ephemeral });
        return;
      }
      if (!isAdmin(interaction.user)) {
        await interaction.reply({ content: "Only admins can set the fishing popup channel.", flags: MessageFlags.Ephemeral });
        return;
      }

      const channel = interaction.options.getChannel("channel");
      if (!channel?.isTextBased?.() || channel.guildId !== interaction.guildId) {
        await interaction.reply({ content: "Pilih text channel dari server ini.", flags: MessageFlags.Ephemeral });
        return;
      }

      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const thread = await createFishingPopupThread(channel).catch((error) => {
        console.error("Could not create fishing popup thread:", error);
        return null;
      });
      if (!thread?.id) {
        await interaction.editReply("Aku belum bisa membuat thread `Fishing!` di channel itu. Pastikan bot punya permission Create Public Threads.");
        return;
      }

      defaultFishingChannels.set(interaction.guildId, thread.id);
      saveDefaultFishingChannels();
      await interaction.editReply(`Fishing popup channel diset ke ${thread}. Semua popup fishing server ini akan dikirim ke thread itu.`);
      return;
    }

    if (interaction.commandName === "fishserver") {
      if (!interaction.guild) {
        await interaction.reply({ content: "Command ini hanya bisa dipakai di server.", flags: MessageFlags.Ephemeral });
        return;
      }
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      await interaction.editReply(await makeServerStatusMessage(interaction.guild));
      return;
    }

    if (interaction.commandName === "fishleaderboard") {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      await interaction.editReply(await makeLeaderboardMessage(interaction.options.getString("page") || "fish_count"));
      return;
    }

    if (interaction.commandName === "fishhelp") {
      await interaction.reply({
        ...makeHelpMessage(isAdmin(interaction.user)),
        flags: MessageFlags.Ephemeral
      });
      return;
    }

    if (interaction.commandName === "fishguide") {
      const info = interaction.options.getString("info") || "";
      await interaction.reply({
        ...makeFishGuideMessage(info),
        flags: MessageFlags.Ephemeral
      });
      return;
    }

    if (interaction.commandName === "fishcomp") {
      recordGuildActivity(interaction.guildId);
      if (!interaction.guildId) {
        await interaction.reply({ content: "Kompetisi hanya bisa dibuat di server.", flags: MessageFlags.Ephemeral });
        return;
      }
      if (competitions.has(interaction.guildId)) {
        await interaction.reply({ content: "Masih ada kompetisi yang berjalan di server ini.", flags: MessageFlags.Ephemeral });
        return;
      }

      const registrationMinutes = Math.max(1, Math.min(30, interaction.options.getInteger("regtime") || 5));
      const turns = Math.max(1, Math.min(50, interaction.options.getInteger("duration") || 15));
      const competition = {
        guildId: interaction.guildId,
        channelId: interaction.channelId,
        creatorId: interaction.user.id,
        startsAt: Date.now() + registrationMinutes * 60_000,
        turns,
        maxParticipants: 25,
        status: "registration",
        participants: new Map(),
        results: new Map(),
        logs: [],
        eventStates: new Map(),
        currentTurnEffects: new Map(),
        currentTurn: 0,
        logIntervalMs: Math.max(0, Number(getSettings().fishCompLogIntervalMs || 2500)),
        message: null,
        pingMessage: null,
        timeout: null
      };
      competitions.set(interaction.guildId, competition);
      await interaction.reply(makeCompetitionMessage(competition, "registration", makeCompetitionJoinRow(false)));
      competition.message = await interaction.fetchReply();
      logBotAction("Fish Comp registration opened", {
        guild: guildLogName(interaction.channel, interaction.guildId),
        channel: channelLogName(interaction.channel),
        extra: `startsInMinutes=${registrationMinutes} turns=${turns}`
      });
      const fishCompRole = interaction.guild ? await ensureFishCompRole(interaction.guild) : null;
      competition.pingMessage = await interaction.channel?.send({
        content: `## Ayo! Kompetisi memancing sudah dimulai!! ${fishCompRole ? fishCompRole.toString() : "@FishComp"}\n-# *buka /fishprofile dan tekan tombol untuk mendapatkan role @FishComp*`,
        allowedMentions: fishCompRole ? { roles: [fishCompRole.id] } : { parse: [] }
      }).catch(() => null);
      competition.timeout = setTimeout(() => {
        if (competition.participants.size < 2) {
          cancelCompetition(competition, competition.participants.size === 0 ? "Tidak ada peserta yang join." : "Butuh minimal 2 peserta untuk memulai kompetisi.");
          return;
        }
        runCompetition(competition).catch((error) => {
          console.error("Competition failed:", error);
          competitions.delete(competition.guildId);
        });
      }, registrationMinutes * 60_000);
      return;
    }

    if (interaction.commandName === "fishduel") {
      recordGuildActivity(interaction.guildId);
      if (!interaction.guildId || !interaction.guild) {
        await interaction.reply({ content: "FishDuel hanya bisa dibuat di server.", flags: MessageFlags.Ephemeral });
        return;
      }
      const targetUser = interaction.options.getUser("target");
      const betAmount = Math.max(0, Math.floor(Number(interaction.options.getInteger("bet") || 0)));
      if (targetUser?.bot) {
        await interaction.reply({ content: "Pilih pemain server yang bukan bot.", flags: MessageFlags.Ephemeral });
        return;
      }
      if (targetUser?.id === interaction.user.id) {
        await interaction.reply({ content: "Kamu tidak bisa duel melawan diri sendiri.", flags: MessageFlags.Ephemeral });
        return;
      }
      await cleanupDeletedFishDuelMessages(interaction.guildId);
      if (hasActiveFishDuel(interaction.guildId, interaction.user.id, targetUser?.id || "")) {
        await interaction.reply({ content: "Salah satu pemain masih berada di duel lain.", flags: MessageFlags.Ephemeral });
        return;
      }

      let challengerPlayer = null;
      let targetPlayer = null;
      await withPlayerReadOnly(interaction.user, async (player) => { challengerPlayer = player; });
      if (targetUser) {
        await withPlayerReadOnly(targetUser.id, async (player) => { targetPlayer = player; });
      }
      if (!hasEquippedFishBag(challengerPlayer)) {
        await interaction.reply({ content: "Kamu belum memakai fish bag. Beli dan equip fish bag dulu lewat `/fishstore`.", flags: MessageFlags.Ephemeral });
        return;
      }
      if (targetUser && !hasEquippedFishBag(targetPlayer)) {
        await interaction.reply({ content: "Target belum memakai fish bag, jadi belum bisa menerima duel.", flags: MessageFlags.Ephemeral });
        return;
      }
      if (betAmount > 0 && Number(challengerPlayer.gold || 0) < betAmount) {
        await interaction.reply({ content: "Gold kamu belum cukup untuk jumlah taruhan itu.", flags: MessageFlags.Ephemeral });
        return;
      }
      if (targetUser && betAmount > 0 && Number(targetPlayer.gold || 0) < betAmount) {
        await interaction.reply({ content: "Kedua pemain harus punya cukup gold untuk jumlah taruhan itu.", flags: MessageFlags.Ephemeral });
        return;
      }

      const duelId = `${Date.now()}_${interaction.user.id}_${targetUser?.id || "open"}`;
      const pending = {
        id: duelId,
        guildId: interaction.guildId,
        channelId: interaction.channelId,
        creatorId: interaction.user.id,
        targetId: targetUser?.id || "",
        creator: {
          id: interaction.user.id,
          username: interaction.user.username,
          globalName: interaction.user.globalName,
          displayName: interaction.user.displayName
        },
        target: targetUser ? {
          id: targetUser.id,
          username: targetUser.username,
          globalName: targetUser.globalName,
          displayName: targetUser.displayName
        } : null,
        betAmount,
        createdAt: Date.now()
      };
      setPendingFishDuel(duelId, pending);
      if (!targetUser) {
        await interaction.reply(makeOpenFishDuelMessage(pending));
        const replyMessage = await interaction.fetchReply().catch(() => null);
        if (replyMessage?.id) {
          pending.messageId = replyMessage.id;
          setPendingFishDuel(duelId, pending);
        }
        return;
      }
      const prompt = [
        `${formatDiscordMention(interaction.user.id)} menantang ${formatDiscordMention(targetUser.id)} untuk duel adu dermawan! Akankah diterima atau ${formatDiscordMention(targetUser.id)} hanya pecundang yang tidak dermawan?`,
        "",
        `Apakah ingin menerima duel dari ${interaction.user.username}?`,
        "",
        "**Duel Adu Dermawan!**",
        "Siapa yang bisa membuat tas lawannya penuh lebih dahulu ialah yang lebih dermawan!",
        betAmount > 0 ? `Taruhan: **${formatGoldAmount(betAmount)}** per pemain` : "Tanpa taruhan gold."
      ].join("\n");
      await interaction.reply({
        content: prompt,
        components: makeFishDuelAcceptRow(duelId),
        allowedMentions: { users: [interaction.user.id, targetUser.id] }
      });
      const replyMessage = await interaction.fetchReply().catch(() => null);
      if (replyMessage?.id) {
        pending.messageId = replyMessage.id;
        setPendingFishDuel(duelId, pending);
      }
      return;
    }

    if (interaction.commandName === "fishraid") {
      recordGuildActivity(interaction.guildId);
      if (!interaction.guildId) {
        await interaction.reply({ content: "Raid hanya bisa dibuat di server.", flags: MessageFlags.Ephemeral });
        return;
      }
      const dailyState = normalizeDailyRaidState(interaction.guildId);
      if (dailyState.fulfilledAt) {
        await interaction.reply({ content: "Quota raid hari ini sudah terpenuhi. Raid berikutnya tersedia setelah reset harian.", flags: MessageFlags.Ephemeral });
        return;
      }
      if (fishRaids.has(interaction.guildId)) {
        await interaction.reply({ content: "Masih ada fish raid yang berjalan di server ini.", flags: MessageFlags.Ephemeral });
        return;
      }
      const cooldownRemainingMs = getRaidCooldownRemainingMs(interaction.guildId);
      if (cooldownRemainingMs > 0) {
        await interaction.reply({ content: `Fish raid masih cooldown. Coba lagi dalam ${formatDurationIndonesian(cooldownRemainingMs)}.`, flags: MessageFlags.Ephemeral });
        return;
      }

      const registrationMinutes = Math.max(1, Math.min(30, interaction.options.getInteger("regtime") || 5));
      const turns = 25;
      dailyState.channelId = interaction.channelId;
      saveFishRaidState();
      const raid = {
        mode: "raid",
        guildId: interaction.guildId,
        channelId: interaction.channelId,
        creatorId: interaction.user.id,
        startsAt: Date.now() + registrationMinutes * 60_000,
        turns,
        maxParticipants: 25,
        status: "registration",
        participants: new Map(),
        results: new Map(),
        logs: [],
        eventStates: new Map(),
        currentTurnEffects: new Map(),
        currentTurn: 0,
        raidGainedWeight: 0,
        logIntervalMs: Math.max(0, Number(getSettings().fishRaidLogIntervalMs ?? getSettings().fishCompLogIntervalMs ?? 2500)),
        message: null,
        pingMessage: null,
        timeout: null
      };
      fishRaids.set(interaction.guildId, raid);
      await interaction.reply(makeCompetitionMessage(raid, "registration", makeFishRaidJoinRow(false)));
      raid.message = await interaction.fetchReply();
      logBotAction("Fish Raid registration opened", {
        guild: guildLogName(interaction.channel, interaction.guildId),
        channel: channelLogName(interaction.channel),
        extra: `startsInMinutes=${registrationMinutes} turns=${turns} boss=${dailyState.boss.name}`
      });
      const fishCompRole = interaction.guild ? await ensureFishCompRole(interaction.guild) : null;
      raid.pingMessage = await interaction.channel?.send({
        content: `## Fish Raid dibuka! ${fishCompRole ? fishCompRole.toString() : "@FishComp"}\nBoss hari ini: **${dailyState.boss.name}** · Quota **${formatKg(dailyState.quotaKg)}**\n-# *Join raid untuk bantu memenuhi pesanan ikan hari ini.*`,
        allowedMentions: fishCompRole ? { roles: [fishCompRole.id] } : { parse: [] }
      }).catch(() => null);
      raid.timeout = setTimeout(() => {
        if (raid.participants.size < 1) {
          cancelCompetition(raid, "Tidak ada peserta yang join.");
          return;
        }
        runCompetition(raid).catch((error) => {
          console.error("Fish raid failed:", error);
          fishRaids.delete(raid.guildId);
        });
      }, registrationMinutes * 60_000);
    }
  } catch (error) {
    console.error("Interaction handling failed:", error);
    if (interaction.isRepliable() && !interaction.replied && !interaction.deferred) {
      await interaction.reply({
        content: `Something went wrong: ${error.message}`,
        flags: MessageFlags.Ephemeral
      }).catch(() => {});
    } else if (interaction.isRepliable()) {
      await interaction.editReply(`Something went wrong: ${error.message}`).catch(() => {});
    }
  }
});

client.on("voiceStateUpdate", async (oldState, newState) => {
  try {
    const member = newState.member || oldState.member;
    if (!member || member.user.bot) {
      return;
    }

    if (isCountedVoiceState(newState)) {
      startVoiceSession(member, newState.channelId);
      return;
    }

    if (isCountedVoiceState(oldState)) {
      await stopVoiceSession(oldState.guild.id, oldState.id);
    }
  } catch (error) {
    console.error("Voice state handling failed:", error);
  }
});

client.on("messageDelete", (message) => {
  const messageId = message?.id || "";
  if (!messageId) {
    return;
  }
  deletePendingFishDuelByMessageId(messageId);
  for (const duel of [...fishDuels.values()]) {
    if (duel.message?.id === messageId || duel.logMessage?.id === messageId) {
      forgetFishDuel(duel);
    }
  }
});

client.on("messageCreate", async (message) => {
  try {
    if (message.author.bot) {
      return;
    }

    if (message.content.startsWith(prefix)) {
      await handleCommand(message);
      return;
    }

    await handleFishingProgress(message);
  } catch (error) {
    console.error("Message handling failed:", error);
    if (message.content.startsWith(prefix)) {
      await message.reply(`Something went wrong: ${error.message}`);
    }
  }
});

async function start() {
  if (!token) {
    console.error("Missing DISCORD_TOKEN. Copy .env.example to .env and add your bot token.");
    process.exit(1);
  }

  await refreshGameData("bot startup");
  loadAnnouncementState();
  loadCompetitionHistoryLogs();
  loadFishRaidState();
  loadFishVoiceChannels();
  loadDefaultFishingChannels();
  watchManagerConfigSignal();
  watchEnforcedFishingSignal();
  watchGiveMoneySignal();
  watchFishRaidSignal();
  scheduleFishRaidMidnightReset();
  scheduleRoutineMessages();
  setInterval(() => {
    refreshGameData("automatic config refresh interval")
      .then(() => Promise.all([announceEventUpdates(), processRoutineMessages()]))
      .catch((error) => console.error("Could not refresh PlayFab config:", error));
  }, configRefreshMs);

  await client.login(token);
  loadPendingMessageDeletes();
  loadPendingFishDuels();
  await processFishRaidMidnightReset().catch((error) => console.error("Could not process fish raid midnight catch-up:", error));
  await announceEventUpdates().catch((error) => console.error("Could not announce event updates:", error));
  await processRoutineMessages().catch((error) => console.error("Could not process routine messages:", error));
}

start().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
