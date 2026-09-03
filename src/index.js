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
  AttachmentBuilder,
  GatewayIntentBits,
  MessageFlags,
  Partials,
  EmbedBuilder,
  PermissionFlagsBits,
  StringSelectMenuBuilder
} = require("discord.js");
const {
  entersState,
  getVoiceConnection,
  joinVoiceChannel,
  VoiceConnectionStatus
} = require("@discordjs/voice");
const { adminListPlayers, adminSaveGameData, getGameData, getPlayer, savePlayer } = require("./playfab");
const { makeIconAttachment, parseDataImage } = require("./imageUtils");

const token = process.env.DISCORD_TOKEN;
const prefix = process.env.PREFIX || "!";
const minMessageLength = 4;
const configRefreshMs = Number(process.env.CONFIG_REFRESH_MS || 300_000);
const runtimeDirectory = path.join(__dirname, "..", ".runtime");
const configSignalPath = path.join(runtimeDirectory, "config-refresh.json");
const enforcedFishingSignalPath = path.join(runtimeDirectory, "enforced-fishing.json");
const giveMoneySignalPath = path.join(runtimeDirectory, "give-money.json");
const fishVoiceChannelsPath = path.join(runtimeDirectory, "fish-voice-channels.json");
const defaultFishingChannelsPath = path.join(runtimeDirectory, "default-fishing-channels.json");
const fishRaidStatePath = path.join(runtimeDirectory, "fish-raid-state.json");
const fishRaidSignalPath = path.join(runtimeDirectory, "fish-raid-signal.json");
const processStartedAt = Date.now();
const voiceTickMs = 60_000;

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
  },
  activeEvent: null,
  events: []
};
const playerQueues = new Map();
const announcedEvents = new Set();
const announcedEndedEvents = new Set();
const competitions = new Map();
const fishRaids = new Map();
const dailyFishRaids = new Map();
const finishedCompetitionLogs = new Map();
const fishVoiceChannels = new Map();
const defaultFishingChannels = new Map();
const activeVoiceSessions = new Map();
let voiceTickTimer = null;
let enforcedFishingTimer = null;
let giveMoneyTimer = null;
let fishRaidSignalTimer = null;
let fishRaidMidnightTimer = null;
const processedEnforcedFishingIds = new Set();
const processedGiveMoneyIds = new Set();
const processedFishRaidSignalIds = new Set();

async function refreshGameData() {
  gameData = await getGameData();
  if (client.isReady()) {
    await hydrateActiveEventGuilds();
  }
  console.log(`Loaded ${gameData.fish.length} fish, ${gameData.rods.length} rods, and ${gameData.adminDiscordIds.length} admin IDs from PlayFab.`);
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
    await channel.send({ embeds: [makeLevelUpEmbed(user, currentLevel, member)] }).catch((error) => {
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
  if (!embeds.length) {
    await interaction.reply({ content: "Popup tangkapan ini tidak bisa dipamerkan.", flags: MessageFlags.Ephemeral });
    return;
  }

  const files = [...interaction.message.attachments.values()].map((attachment) => ({
    attachment: attachment.url,
    name: attachment.name || undefined
  }));

  await targetChannel.send({
    content: `${formatDiscordMention(interaction.user.id)} meminta izin untuk pamer nih bos!`,
    embeds,
    files,
    allowedMentions: { users: [interaction.user.id] }
  });
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

function formatFishLuckScore(luckScale) {
  return Math.max(0, Math.round((1 - Number(luckScale || 0)) * 5000));
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
  const luckScore = formatFishLuckScore(caughtFish.luckScale);
  player.inventory[caughtFish.id] = (player.inventory[caughtFish.id] || 0) + 1;
  player.totalFishCaught = Math.max(0, Number(player.totalFishCaught || 0)) + 1;
  if (!player.heaviestFish || Number(catchWeight || 0) > Number(player.heaviestFish.weight || 0)) {
    player.heaviestFish = {
      fishId: caughtFish.id,
      name: caughtFish.name,
      weight: Number(catchWeight || 0)
    };
  }
  if (!player.luckiestFish || luckScore > Number(player.luckiestFish.score || 0)) {
    player.luckiestFish = {
      fishId: caughtFish.id,
      name: caughtFish.name,
      luckScale: Number(caughtFish.luckScale || 0),
      score: luckScore
    };
  }
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

function makeFishCompRoleRow(member = null) {
  if (!member?.guild) {
    return [];
  }
  const role = findFishCompRole(member.guild);
  const hasRole = role ? member.roles.cache.has(role.id) : false;
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId("fishcomp_role_toggle")
        .setLabel(hasRole ? "Remove FishComp" : "Get @FishComp")
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

function makeProfileComponents(player, member = null) {
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
  components.push(...makeFishCompRoleRow(member));
  return components;
}

function makeProfileMessage(user, player, member = null) {
  const profile = makeProfileEmbed(user, player);
  return {
    content: "",
    embeds: [profile.embed],
    files: profile.files,
    components: makeProfileComponents(player, member)
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
  const luckScore = formatFishLuckScore(caughtFish.luckScale);
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
  return {
    ...getUserMentionForMessage(user, options),
    embeds: [catchEmbed.embed],
    files: catchEmbed.files,
    components: [makeCatchShareRow(user)]
  };
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

async function loadAdminPlayersSafely(search = "") {
  try {
    return await adminListPlayers(search);
  } catch (error) {
    console.error("Could not load admin player list:", error);
    return [];
  }
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

  const channel = await client.channels.fetch(event.announcementChannelId).catch(() => null);
  if (channel?.guildId) {
    event.guildId = channel.guildId;
  }
}

async function announceActiveEvent() {
  for (const event of getEvents().filter(isEventRunning)) {
    await hydrateEventGuild(event);
    if (!event?.announcementChannelId || !event.deployedAt || event.isAnnounced || announcedEvents.has(event.id)) {
      continue;
    }

    const channel = await client.channels.fetch(event.announcementChannelId).catch(() => null);
    if (!channel?.isTextBased()) {
      continue;
    }

    if (!event.guildId && channel.guildId) {
      event.guildId = channel.guildId;
    }

    const eventMessage = makeEventEmbed(event);
    await channel.send({ embeds: [eventMessage.embed], files: eventMessage.files });
    announcedEvents.add(event.id);
    await markEventAnnounced(event.id, event.guildId || channel.guildId || "");
  }
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
    if (endedAt < processStartedAt || announcedEndedEvents.has(event.id)) {
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
    await channel.send({ embeds: [eventMessage.embed], files: eventMessage.files });
    announcedEndedEvents.add(event.id);
  }
}

async function announceEventUpdates() {
  await announceActiveEvent();
  await announceEndedEvents();
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
    refreshGameData()
      .then(() => announceEventUpdates())
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

    const user = await client.users.fetch(String(entry.discordUserId || "")).catch(() => null);
    const mention = user || `<@${entry.discordUserId}>`;
    await channel.send(makeCatchMessage(mention, entry.fish, entry.catchWeight, entry.expGain, {
      enforced: true,
      expBase: entry.expBase,
      expEventInfo: entry.expEventInfo
    })).catch((error) => {
      console.error("Could not post enforced fishing catch:", error);
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

function makeInventoryEmbed(user, player) {
  const lines = gameData.fish
    .map((fishEntry) => [fishEntry, player.inventory[fishEntry.id] || 0])
    .filter(([, quantity]) => quantity > 0)
    .map(([fishEntry, quantity]) => formatFishLine(fishEntry, quantity));

  return new EmbedBuilder()
    .setColor(0x3498db)
    .setTitle(`${user.username}'s Fish Inventory`)
    .setDescription(lines.length ? lines.join("\n") : "Your inventory is empty.");
}

function makeStoreEmbed(player, status = "") {
  const statusLine = status ? `\n\n${status}` : "";
  const storeImageUrl = getPublicImageUrl(getSettings().rodStoreImageUrl);
  return new EmbedBuilder()
    .setColor(0xf1c40f)
    .setTitle("Toko Pancingan")
    .setDescription(`Gold kamu: **${player.gold}**\nPancingan sekarang: **${getRod(player.rodId)?.name || "Belum ada"}**${statusLine}`)
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
  const rows = Math.max(1, Math.ceil(gameData.rods.length / columns));
  const height = 24 + rows * cardHeight + (rows - 1) * gap + 24;
  const cards = gameData.rods.map((rod, index) => {
    const x = 24 + (index % columns) * (cardWidth + gap);
    const y = 24 + Math.floor(index / columns) * (cardHeight + gap);
    const owned = player.ownedRods.includes(rod.id);
    const equipped = player.rodId === rod.id;
    const status = equipped ? "Equipped" : owned ? "Owned" : `${rod.price} gold`;
    const icon = makeIconAttachment(rod, "rod");
    const image = icon
      ? `<image href="${escapeXml(icon.url)}" x="${x + 46}" y="${y + 16}" width="72" height="72" preserveAspectRatio="xMidYMid meet" />`
      : `<rect x="${x + 46}" y="${y + 16}" width="72" height="72" rx="10" fill="#30323a" /><text x="${x + 82}" y="${y + 59}" text-anchor="middle" font-size="18" font-weight="700" fill="#f1c40f">ROD</text>`;
    return `
      <rect x="${x}" y="${y}" width="${cardWidth}" height="${cardHeight}" rx="8" fill="#272933" stroke="#444755" />
      ${image}
      <text x="${x + 12}" y="${y + 108}" font-size="16" font-weight="700" fill="#ffffff">${escapeXml(truncateText(rod.name, 18))}</text>
      <text x="${x + 12}" y="${y + 128}" font-size="12" fill="#f1c40f">${escapeXml(rod.rarity || "Common")}</text>
      <text x="${x + 12}" y="${y + 145}" font-size="13" fill="#c9cad3">SPD ${rod.speed} · LUCK ${rod.luck}</text>
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
  return gameData.rods.slice(0, 25).map((rod) => {
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

function makeStoreComponents(player, selectedRodId = null) {
  const selectedRod = gameData.rods.find((rod) => rod.id === selectedRodId) || gameData.rods[0];
  const owned = selectedRod ? player.ownedRods.includes(selectedRod.id) : false;
  const equipped = selectedRod ? player.rodId === selectedRod.id : false;
  const select = new StringSelectMenuBuilder()
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

  return [
    new ActionRowBuilder().addComponents(select),
    new ActionRowBuilder().addComponents(button)
  ];
}

function makeStoreMessage(player, selectedRodId = null, status = "") {
  const imageAttachment = makeRodStoreImageAttachment(player);
  return {
    embeds: [makeStoreEmbed(player, status)],
    files: imageAttachment ? [imageAttachment] : [],
    components: makeStoreComponents(player, selectedRodId)
  };
}

function makeCompetitionEmbed(competition, status = "registration") {
  const startsAt = Math.floor(competition.startsAt / 1000);
  const isRaid = competition.mode === "raid";
  const raidState = isRaid ? normalizeDailyRaidState(competition.guildId) : null;
  const embed = new EmbedBuilder()
    .setColor(isRaid ? 0x3ba1ff : 0xe67e22)
    .setTitle(isRaid ? "Fish Raid" : "Kompetisi Memancing");

  if (status === "closed") {
    embed.setDescription(
      [
        "Registrasi sudah ditutup.",
        isRaid ? "Raid sedang disiapkan." : "Kompetisi sedang disiapkan."
      ].join("\n")
    );
    return embed;
  }

  if (status === "complete") {
    embed.setColor(0x2ecc71);
    embed.setDescription(
      [
        isRaid ? "Raid sudah selesai." : "Kompetisi sudah selesai.",
        isRaid ? "Hasil raid sudah keluar." : "Hasil kompetisi sudah keluar."
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
      ...raidIntro,
      `Dimulai: <t:${startsAt}:R> · <t:${startsAt}:T>`,
      `Durasi: **${competition.turns} turn**`,
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
        ...(isRaid ? [`Boss: **${raidState.boss.name}**`, formatRaidQuotaLine({ ...raidState, filledKg: Math.min(raidState.quotaKg, Number(raidState.filledKg || 0) + Number(competition.raidGainedWeight || 0)) }), ""] : []),
        scoreboard || "Belum ada hasil.",
        "",
        isRaid ? "Raid sedang berjalan." : "Kompetisi sedang berjalan.",
        `Turn: **${competition.currentTurn}/${competition.turns}**`,
        "",
        recentLogs
      ].join("\n")
    );
  }
  if (status !== "complete") {
    const banner = isRaid ? makeFishRaidImage(status, raidState.boss) : makeFishCompImage(status);
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
    : competition.mode === "raid" ? makeFishRaidImage(status, normalizeDailyRaidState(competition.guildId).boss) : makeFishCompImage(status);
  return {
    embeds: [embed],
    files: banner?.attachment ? [banner.attachment] : [],
    components
  };
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
  const settingsKey = mode === "raid" ? "fishRaidEvents" : "fishCompEvents";
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
  return [...competition.results.values()]
    .sort((a, b) => b.count - a.count || b.totalWeight - a.totalWeight || a.username.localeCompare(b.username));
}

function formatCompetitionResultLine(result) {
  return `${result.displayName} - ${result.count} ${result.count === 1 ? "ikan" : "Ikan"} - Total ${formatKg(result.totalWeight)}`;
}

function formatCompetitionScoreboard(competition) {
  return getSortedCompetitionResults(competition).map(formatCompetitionResultLine).join("\n");
}

function getCompetitionRewardExp(competition) {
  return Math.round(getCompetitionBaseRewardExp() * getEventMultiplier("exp_multiplier", competition.guildId));
}

function getCompetitionRewardGold(competition) {
  return Math.round(getCompetitionBaseRewardGold() * getEventMultiplier("gold_multiplier", competition.guildId));
}

function getCompetitionBaseRewardExp() {
  return Math.round(Number(getSettings().fishCompExpReward ?? 50) * Number(getSettings().expMultiplier || 1));
}

function getCompetitionBaseRewardGold() {
  return Math.round(Number(getSettings().fishCompGoldReward ?? 0));
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
  return results.map((result, index) => `${index + 1}. ${formatCompetitionResultLine(result)}`).join("\n");
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
  } catch (error) {
    console.error(`Could not load competition player ${participant.id}:`, error);
    participant.rodId = "";
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
    raidWinnerIsDailyMvp
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
  finishedCompetitionLogs.set(logId, {
    createdAt: Date.now(),
    fileName: "fishraid_log.txt",
    content: buildCompetitionLogFile(raid)
  });
  const banner = makeFishRaidImage(fulfilled ? "fulfilled" : "result", state.boss);
  if (banner?.url) {
    embed.setImage(banner.url);
  }
  await channel.send({
    embeds: [embed],
    files: banner?.attachment ? [banner.attachment] : [],
    components: makeFishRaidResultRow(logId)
  }).catch(() => {});
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
      await channel.send({ embeds: [makeLevelUpEmbed(user, levelUp.level, member)] }).catch(() => {});
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

  const baseRod = getRod(participant.rodId);
  const rod = baseRod ? { ...baseRod, luck: Number(baseRod.luck || 0) + luckModifier } : null;
  const accuracy = Math.max(0, Math.min(100, Number(rod?.accuracy ?? 50)));
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
  if (competition.mode === "raid") {
    competition.raidGainedWeight = Math.max(0, Number(competition.raidGainedWeight || 0)) + catchResult.catchWeight;
  }
  if (catchResult.catchWeight > result.heaviestWeight) {
    result.heaviestWeight = catchResult.catchWeight;
    result.heaviestName = catchResult.fish.name;
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
  await competition.message.edit(makeCompetitionMessage(
    competition,
    "closed",
    competition.mode === "raid" ? makeFishRaidJoinRow(true) : makeCompetitionJoinRow(true)
  )).catch(() => {});
  for (const participant of competition.participants.values()) {
    await prepareCompetitionParticipant(participant);
  }
  const channel = await client.channels.fetch(competition.channelId).catch(() => null);
  if (!channel?.isTextBased()) {
    throw new Error("Competition channel is no longer available.");
  }
  competition.logMessage = await channel.send(makeCompetitionMessage(competition, "running", []));

  for (let turn = 1; turn <= competition.turns; turn += 1) {
    competition.currentTurn = turn;
    competition.currentTurnEffects = new Map();
    for (const participant of shuffleCompetitionParticipants(competition.participants.values())) {
      const turnEffect = competition.currentTurnEffects.get(participant.id) || null;
      runCompetitionTurnForParticipant(competition, participant, turn, turnEffect);
      await revealPendingCompetitionLogs(competition);
    }
  }

  competition.status = "finished";
  if (competition.mode === "raid") {
    await finishFishRaid(competition, channel);
    return;
  }

  const summary = summarizeCompetition(competition);
  const winner = getSortedCompetitionResults(competition)[0];
  const winnerRewardExp = winner ? getCompetitionRewardExp(competition) : 0;
  const winnerRewardGold = winner ? getCompetitionRewardGold(competition) : 0;
  const winnerBaseExp = winner ? getCompetitionBaseRewardExp() : 0;
  const winnerBaseGold = winner ? getCompetitionBaseRewardGold() : 0;
  const expEventInfo = getEventMultiplierInfo("exp_multiplier", competition.guildId);
  const goldEventInfo = getEventMultiplierInfo("gold_multiplier", competition.guildId);
  let winnerLevel = 0;
  let winnerPreviousLevel = 0;
  if (winner) {
    await withPlayer(winner.id, async (player) => {
      winnerPreviousLevel = getLevel(player.exp);
      player.exp += winnerRewardExp;
      player.gold = Math.max(0, Math.floor(Number(player.gold || 0))) + winnerRewardGold;
      winnerLevel = getLevel(player.exp);
    });
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
        winner ? `Mendapat hadiah: **${formatRewardWithBonus(winnerRewardExp, winnerBaseExp, "EXP")}** dan **${formatRewardWithBonus(winnerRewardGold, winnerBaseGold, "Gold")}**` : "Mendapat hadiah: **0 EXP** dan **0 Gold**",
        formatBonusNotice("EXP", expEventInfo, winnerRewardExp, winnerBaseExp),
        formatBonusNotice("Gold", goldEventInfo, winnerRewardGold, winnerBaseGold),
        "",
        summary
      ].filter((line) => line !== "").join("\n")
    );
  const logId = `${competition.guildId}:${Date.now()}`;
  finishedCompetitionLogs.set(logId, {
    createdAt: Date.now(),
    fileName: "match_log.txt",
    content: buildCompetitionLogFile(competition)
  });
  const banner = makeFishCompImage("result");
  if (banner?.url) {
    embed.setImage(banner.url);
  }
  await channel.send({
    embeds: [embed],
    files: banner?.attachment ? [banner.attachment] : [],
    components: makeCompetitionResultRow(logId)
  }).catch(() => {});
  await competition.message?.delete().catch(() => {});
  await competition.pingMessage?.delete().catch(() => {});
  if (competition.logMessage) {
    await competition.logMessage.delete().catch(() => {});
  }
  if (winner?.id && winnerLevel > winnerPreviousLevel) {
    const member = await channel.guild?.members.fetch(winner.id).catch(() => null);
    const user = member?.user || await client.users.fetch(winner.id).catch(() => null);
    if (user) {
      await channel.send({ embeds: [makeLevelUpEmbed(user, winnerLevel, member)] }).catch(() => {});
    }
  }
  competitions.delete(competition.guildId);
}

function buildCompetitionLogFile(competition) {
  return [
    competition.mode === "raid" ? "TRFishing Fish Raid Match Log" : "TRFishing Competition Match Log",
    `Guild ID: ${competition.guildId}`,
    `Channel ID: ${competition.channelId}`,
    `Turns: ${competition.turns}`,
    `Participants: ${competition.participants.size}`,
    "",
    "Participants",
    [...competition.participants.values()].map((participant, index) => `${index + 1}. ${getCompetitionLogName(participant)}`).join("\n") || "Tidak ada peserta.",
    "",
    "Battle Log",
    ...formatCompetitionLogFileLines(competition)
  ].join("\n");
}

async function cancelCompetition(competition, reason) {
  if (competition.timeout) {
    clearTimeout(competition.timeout);
    competition.timeout = null;
  }
  competition.status = "cancelled";
  await competition.message?.edit({
    embeds: [
      new EmbedBuilder()
        .setColor(0xe74c3c)
        .setTitle("Kompetisi Dibatalkan")
        .setDescription(reason)
    ],
    components: [],
    files: []
  }).catch(() => {});
  await competition.pingMessage?.delete().catch(() => {});
  if (competition.mode === "raid") {
    fishRaids.delete(competition.guildId);
  } else {
    competitions.delete(competition.guildId);
  }
}

function cleanupFinishedCompetitionLogs() {
  const maxAgeMs = 24 * 60 * 60 * 1000;
  const now = Date.now();
  for (const [logId, record] of finishedCompetitionLogs.entries()) {
    if (now - Number(record.createdAt || 0) > maxAgeMs) {
      finishedCompetitionLogs.delete(logId);
    }
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
        name: "/fishinventory",
        value: "Melihat daftar ikan yang kamu punya di inventory.",
        inline: false
      },
      {
        name: "/fishstore",
        value: "Melihat daftar pancingan yang tersedia di toko.",
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
        value: "Ikan yang kamu dapat masuk inventory. Gunakan `/sellfish` untuk menjual semua ikan, atau `/sellfish fish:<nama/id>` untuk menjual satu jenis ikan. Gold dipakai untuk membeli pancingan.",
        inline: false
      },
      {
        name: "Store dan Pancingan",
        value: "Gunakan `/fishstore` untuk membeli atau memakai pancingan. **Speed** menentukan jumlah chat yang dibutuhkan, **Luck** membantu peluang ikan lebih bagus, **Max Kg** membatasi berat ikan yang bisa ditangkap, dan **Accuracy** dipakai untuk peluang berhasil di kompetisi.",
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
        name: "Voice Progress",
        value: "Gunakan `/fishvoice` saat kamu sedang berada di voice channel. Bot akan join dalam keadaan mute dan deafen, lalu pemain di voice channel server itu bisa mendapat fishing progress pasif.",
        inline: false
      },
      {
        name: "Detailed Guide",
        value: "Gunakan `/fishguide info:<nama>` untuk membaca panduan detail. Guide yang tersedia: `level`, `inventory`, `store`, `competition`.",
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
      "## Gold dan Rod",
      "Gold dari hasil jual ikan bisa dipakai di `/fishstore` untuk membeli pancingan. Pancingan yang lebih baik membantu kamu mendapat ikan lebih bagus."
    ].join("\n"));
}

function makeStoreGuideEmbed() {
  return new EmbedBuilder()
    .setColor(0x3498db)
    .setTitle("TRFishing · Store Guide")
    .setDescription([
      "# Store Guide",
      "Store dipakai untuk membeli dan memakai rod.",
      "",
      "━━━━━━━━━━━━━━━━━━━━",
      "## Kenapa Rod Penting",
      "Rod memengaruhi cara kamu memancing. **Speed** menentukan berapa banyak progress yang dibutuhkan, **Luck** membantu peluang ikan lebih bagus, **Max Kg** menentukan batas berat ikan yang bisa ditangkap, dan **Accuracy** dipakai saat kompetisi.",
      "",
      "## Cara Pakai",
      "Gunakan `/fishstore`, pilih rod dari menu, lalu beli atau gunakan rod yang sudah kamu punya."
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
  return `${rank}. ${name} - **${Number(record.player.totalFishCaught || 0)} ikan**`;
}

async function makeLeaderboardMessage(page = "fish_count") {
  const selectedPage = leaderboardPages.some((entry) => entry.id === page) ? page : "fish_count";
  const records = sortLeaderboardRecords(await loadAdminPlayersSafely(), selectedPage).slice(0, 10);
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
  return {
    embeds: [embed],
    components: [new ActionRowBuilder().addComponents(select)]
  };
}

function makeSlashCommands() {
  return [
    {
      name: "fishprofile",
      description: "Lihat profil memancing kamu secara privat."
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
      await popupChannel.send({ embeds: [makeLevelUpEmbed(message.author, currentLevel, message.member)] });
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
      await popupChannel.send({ embeds: [makeLevelUpEmbed(message.author, currentLevel, message.member)] });
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

client.on("interactionCreate", async (interaction) => {
  try {
    if (interaction.isStringSelectMenu() && interaction.customId === "leaderboard_select") {
      await interaction.deferUpdate();
      await interaction.editReply(await makeLeaderboardMessage(interaction.values[0]));
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
        await interaction.editReply(makeProfileMessage(interaction.user, player, member));
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
        await interaction.editReply({
          content: "Aku belum bisa menyiapkan role FishComp. Pastikan bot punya permission Manage Roles.",
          embeds: [],
          files: [],
          components: []
        });
        return;
      }

      if (member.roles.cache.has(role.id)) {
        await member.roles.remove(role, "TRFishing FishComp opt-out");
      } else {
        await member.roles.add(role, "TRFishing FishComp opt-in");
      }

      await withPlayerReadOnly(interaction.user, async (player) => {
        await interaction.editReply(makeProfileMessage(interaction.user, player, member));
      });
      return;
    }

    if (!interaction.isChatInputCommand()) {
      return;
    }

    if (["sellfish", "fishstore", "fishvoice", "fishcomp", "fishraid"].includes(interaction.commandName) && !isActivityAllowed()) {
      await interaction.reply({ content: activityBlockedMessage(), flags: MessageFlags.Ephemeral });
      return;
    }

    if (interaction.commandName === "fishprofile") {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const member = interaction.guild?.members?.fetch
        ? await interaction.guild.members.fetch(interaction.user.id).catch(() => null)
        : null;
      await withPlayerReadOnly(interaction.user, async (player) => {
        await interaction.editReply(makeProfileMessage(interaction.user, player, member));
      });
      return;
    }

    if (interaction.commandName === "fishinventory") {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      await withPlayerReadOnly(interaction.user, async (player) => {
        await interaction.editReply({ embeds: [makeInventoryEmbed(interaction.user, player)] });
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

    if (interaction.commandName === "fishraid") {
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

  await refreshGameData();
  loadFishRaidState();
  loadFishVoiceChannels();
  loadDefaultFishingChannels();
  watchManagerConfigSignal();
  watchEnforcedFishingSignal();
  watchGiveMoneySignal();
  watchFishRaidSignal();
  scheduleFishRaidMidnightReset();
  setInterval(() => {
    refreshGameData()
      .then(() => announceEventUpdates())
      .catch((error) => console.error("Could not refresh PlayFab config:", error));
  }, configRefreshMs);

  await client.login(token);
  await processFishRaidMidnightReset().catch((error) => console.error("Could not process fish raid midnight catch-up:", error));
  await announceEventUpdates().catch((error) => console.error("Could not announce event updates:", error));
}

start().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
