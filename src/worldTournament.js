const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  ContainerBuilder,
  EmbedBuilder,
  MessageFlags,
  SeparatorBuilder,
  TextDisplayBuilder
} = require("discord.js");

const WORLD_STATUS_ACTIVE = new Set(["registration", "running", "rewards"]);

function numberOr(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function integerOr(value, fallback = 0) {
  return Math.floor(numberOr(value, fallback));
}

function clampInteger(value, min, max, fallback) {
  return Math.max(min, Math.min(max, integerOr(value, fallback)));
}

function cleanText(value, fallback = "") {
  const text = String(value ?? "").trim();
  return text || fallback;
}

function escapeText(value) {
  return cleanText(value, "-").replace(/[\\*_~`|]/g, "").slice(0, 160);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function shuffle(items) {
  const result = [...items];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const target = Math.floor(Math.random() * (index + 1));
    [result[index], result[target]] = [result[target], result[index]];
  }
  return result;
}

function formatKg(value) {
  const number = Math.max(0, Number(value || 0));
  return `${number.toLocaleString("id-ID", { maximumFractionDigits: 2 })} kg`;
}

function formatDuration(ms) {
  const totalMinutes = Math.max(0, Math.ceil(Number(ms || 0) / 60_000));
  if (totalMinutes < 60) return `${totalMinutes} menit`;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return minutes ? `${hours} jam ${minutes} menit` : `${hours} jam`;
}

function groupDisplayName(group) {
  const parsed = /^r(\d+)g(\d+)$/i.exec(String(group?.id || ""));
  const round = integerOr(group?.round, parsed ? parsed[1] : 0);
  const index = integerOr(group?.index, parsed ? Number(parsed[2]) - 1 : -1) + 1;
  return round > 0 && index > 0 ? `Round ${round} Group ${index}` : cleanText(group?.id, "Group");
}

function visibleBattleLog(log) {
  return cleanText(log).replace(/\s+\[Server: [^\]]+\]$/, "");
}

function formatReward(reward = {}) {
  const exp = Math.max(0, integerOr(reward.exp, 0));
  const gold = Math.max(0, integerOr(reward.gold, 0));
  if (!exp && !gold) return "No reward";
  return `+${exp} EXP · +${gold} Gold`;
}

function mapToObject(map) {
  return Object.fromEntries(map instanceof Map ? map.entries() : Object.entries(map || {}));
}

function objectToMap(value) {
  return new Map(Object.entries(value && typeof value === "object" ? value : {}));
}

function makeId(prefix) {
  return `${prefix}_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`;
}

function groupSizes(count, targetSize) {
  const total = Math.max(0, integerOr(count, 0));
  const target = Math.max(2, integerOr(targetSize, 5));
  if (total <= target) return total ? [total] : [];

  const fullGroups = Math.floor(total / target);
  const remainder = total % target;
  const sizes = Array.from({ length: fullGroups }, () => target);
  if (remainder === 3 || remainder === 4) {
    sizes.push(remainder);
  } else if (remainder > 0) {
    for (let index = 0; index < remainder; index += 1) {
      sizes[index % sizes.length] += 1;
    }
  }
  return sizes;
}

function makeGroups(participantIds, targetSize, roundNumber, settings) {
  const shuffled = shuffle(participantIds);
  const sizes = groupSizes(shuffled.length, targetSize);
  let offset = 0;
  const groups = sizes.map((size, index) => {
    const group = {
      id: `r${roundNumber}g${index + 1}`,
      round: roundNumber,
      index,
      participantIds: shuffled.slice(offset, offset + size),
      status: "pending",
      isFinal: sizes.length === 1,
      turns: sizes.length === 1 ? settings.finalTurns : settings.standardTurns,
      currentTurn: 0,
      currentOrder: [],
      currentOrderIndex: 0,
      eventStates: {},
      currentTurnEffects: {},
      results: {},
      logs: [],
      qualifierIds: [],
      finishedAt: ""
    };
    offset += size;
    return group;
  });

  const expectedIds = new Set(participantIds);
  const assignedIds = groups.flatMap((group) => group.participantIds);
  const assignedUniqueIds = new Set(assignedIds);
  const hasCompleteAssignment = participantIds.length === expectedIds.size
    && assignedIds.length === participantIds.length
    && assignedUniqueIds.size === expectedIds.size
    && assignedIds.every((id) => expectedIds.has(id));
  if (!hasCompleteAssignment) {
    throw new Error(`World Fish Competition group assignment is invalid for round ${roundNumber}: every participant must appear exactly once.`);
  }
  return groups;
}

function createResult(participant) {
  return {
    id: participant.id,
    displayName: participant.displayName,
    guildName: participant.guildName,
    guildId: participant.guildId,
    count: 0,
    totalWeight: 0,
    heaviestWeight: 0,
    heaviestName: ""
  };
}

function sortedResults(results) {
  return [...results].sort((left, right) => (
    Number(right.count || 0) - Number(left.count || 0)
    || Number(right.totalWeight || 0) - Number(left.totalWeight || 0)
    || Number(right.heaviestWeight || 0) - Number(left.heaviestWeight || 0)
    || String(left.displayName || "").localeCompare(String(right.displayName || ""))
    || String(left.id || "").localeCompare(String(right.id || ""))
  ));
}

function participantServerGroups(participants) {
  const grouped = new Map();
  for (const participant of Object.values(participants || {})) {
    const key = cleanText(participant.guildId, "unknown");
    if (!grouped.has(key)) {
      grouped.set(key, { guildId: key, guildName: cleanText(participant.guildName, "Unknown Server"), participants: [] });
    }
    grouped.get(key).participants.push(participant);
  }
  return [...grouped.values()].sort((left, right) => (
    right.participants.length - left.participants.length
    || left.guildName.localeCompare(right.guildName)
  ));
}

function normalizeParticipant(raw) {
  return {
    id: cleanText(raw?.id),
    username: cleanText(raw?.username, "Unknown User"),
    displayName: cleanText(raw?.displayName || raw?.globalName || raw?.username, "Unknown User"),
    globalName: cleanText(raw?.globalName || raw?.displayName || raw?.username, "Unknown User"),
    guildId: cleanText(raw?.guildId),
    guildName: cleanText(raw?.guildName, "Unknown Server"),
    joinedAt: cleanText(raw?.joinedAt, new Date().toISOString()),
    totalFish: Math.max(0, integerOr(raw?.totalFish, 0)),
    totalWeight: Math.max(0, numberOr(raw?.totalWeight, 0)),
    heaviestWeight: Math.max(0, numberOr(raw?.heaviestWeight, 0)),
    heaviestName: cleanText(raw?.heaviestName),
    roundReached: Math.max(0, integerOr(raw?.roundReached, 0)),
    placement: Math.max(0, integerOr(raw?.placement, 0)),
    rodId: cleanText(raw?.rodId),
    level: Math.max(1, integerOr(raw?.level, 1))
  };
}

function normalizeSettings(settings = {}) {
  return {
    registrationMinutes: clampInteger(settings.worldFishCompRegistrationMinutes, 1, 10_080, 300),
    reminderMinutes: clampInteger(settings.worldFishCompReminderMinutes, 0, 1_440, 60),
    minParticipants: clampInteger(settings.worldFishCompMinParticipants, 3, 100, 3),
    maxParticipants: clampInteger(settings.worldFishCompMaxParticipants, 3, 100, 100),
    groupSize: clampInteger(settings.worldFishCompGroupSize, 2, 25, 5),
    standardTurns: clampInteger(settings.worldFishCompStandardTurns, 1, 100, 15),
    finalTurns: clampInteger(settings.worldFishCompFinalTurns, 1, 200, 25),
    logIntervalMs: clampInteger(settings.worldFishCompLogIntervalMs, 0, 60_000, 1_000),
    groupDelayMs: clampInteger(settings.worldFishCompGroupDelayMs, 0, 300_000, 3_000),
    publicPlacementCount: clampInteger(settings.worldFishCompPublicPlacementCount, 1, 10, 3),
    historyLogHours: clampInteger(settings.worldFishCompHistoryLogHours, 0, 720, 168),
    participantExpReward: Math.max(0, integerOr(settings.worldFishCompParticipantExpReward, 25)),
    participantGoldReward: Math.max(0, integerOr(settings.worldFishCompParticipantGoldReward, 0)),
    firstExpReward: Math.max(0, integerOr(settings.worldFishCompFirstExpReward, 250)),
    firstGoldReward: Math.max(0, integerOr(settings.worldFishCompFirstGoldReward, 0)),
    secondExpReward: Math.max(0, integerOr(settings.worldFishCompSecondExpReward, 150)),
    secondGoldReward: Math.max(0, integerOr(settings.worldFishCompSecondGoldReward, 0)),
    thirdExpReward: Math.max(0, integerOr(settings.worldFishCompThirdExpReward, 100)),
    thirdGoldReward: Math.max(0, integerOr(settings.worldFishCompThirdGoldReward, 0)),
    championServerExpReward: Math.max(0, integerOr(settings.worldFishCompChampionServerExpReward, 50)),
    championServerGoldReward: Math.max(0, integerOr(settings.worldFishCompChampionServerGoldReward, 0))
  };
}

function snapshotBannerSettings(settings = {}) {
  return [
    "worldFishCompRegistrationBannerBase64",
    "worldFishCompRegistrationBannerUrl",
    "worldFishCompRunningBannerBase64",
    "worldFishCompRunningBannerUrl",
    "worldFishCompResultBannerBase64",
    "worldFishCompResultBannerUrl"
  ].reduce((snapshot, key) => {
    snapshot[key] = cleanText(settings[key]);
    return snapshot;
  }, {});
}

function buildParticipantText(state) {
  const lines = [
    "TRFishing World Fish Competition Participants",
    `Tournament ID: ${state.id}`,
    `Participants: ${Object.keys(state.participants || {}).length}`,
    ""
  ];
  for (const server of participantServerGroups(state.participants)) {
    lines.push(`${server.guildName} (${server.participants.length} Participant${server.participants.length === 1 ? "" : "s"})`);
    for (const participant of server.participants.sort((left, right) => left.displayName.localeCompare(right.displayName))) {
      lines.push(`- ${participant.displayName}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

function buildTeamsText(state) {
  const lines = [
    "TRFishing World Fish Competition Teams",
    `Tournament ID: ${state.id}`,
    ""
  ];
  const rounds = new Map();
  for (const round of state.roundHistory || []) {
    rounds.set(round.round, { round: round.round, groups: [...(round.groups || [])] });
  }
  for (const group of state.groups || []) {
    const round = rounds.get(group.round) || { round: group.round, groups: [] };
    if (!round.groups.some((entry) => entry.id === group.id)) round.groups.push(group);
    rounds.set(group.round, round);
  }
  for (const round of [...rounds.values()].sort((left, right) => left.round - right.round)) {
    lines.push(`Round ${round.round}`);
    for (const group of round.groups) {
      lines.push(`${groupDisplayName(group)}${group.isFinal ? " (Final)" : ""}`);
      for (const id of group.participantIds || []) {
        const participant = state.participants?.[id];
        if (participant) lines.push(`- ${participant.displayName} — ${participant.guildName}`);
      }
      lines.push("");
    }
  }
  return lines.join("\n");
}

function accumulatedRanking(state) {
  return Object.values(state.participants || {}).sort((left, right) => (
    Number(right.totalFish || 0) - Number(left.totalFish || 0)
    || Number(right.totalWeight || 0) - Number(left.totalWeight || 0)
    || Number(right.heaviestWeight || 0) - Number(left.heaviestWeight || 0)
    || String(left.displayName || "").localeCompare(String(right.displayName || ""))
  ));
}

function buildHistoryText(state) {
  const placement = Object.values(state.participants || {})
    .filter((participant) => participant.placement > 0)
    .sort((left, right) => left.placement - right.placement);
  const publicPlacement = placement.slice(0, state.publicPlacementCount);
  const total = accumulatedRanking(state);
  const lines = [
    "TRFishing World Fish Competition Tournament Log",
    `Tournament ID: ${state.id}`,
    `Started: ${state.createdAt}`,
    `Registration ended: ${state.registrationEndsAt}`,
    `Participants: ${Object.keys(state.participants || {}).length}`,
    `Champion Server: ${state.championServerName || "-"}`,
    `Participant Reward: ${formatReward({ exp: state.participantExpReward, gold: state.participantGoldReward })}`,
    `Champion Server Bonus: ${formatReward({ exp: state.championServerExpReward, gold: state.championServerGoldReward })} for participants representing that server`,
    "",
    `Tournament Placement (Top ${state.publicPlacementCount})`,
    ...publicPlacement.map((participant) => `${participant.placement}. ${participant.displayName} — ${participant.guildName} — ${participant.totalFish} fish — Reward: ${formatReward(state.rewardLedger?.[participant.id])}`),
    "",
    "Complete Accumulated Fish Ranking",
    ...total.map((participant, index) => `${index + 1}. ${participant.displayName} — ${participant.guildName} — ${participant.totalFish} fish — ${formatKg(participant.totalWeight)} — Placement ${participant.placement || "-"} — Reward: ${formatReward(state.rewardLedger?.[participant.id])}`),
    "",
    "Round and Group Results"
  ];

  for (const round of state.roundHistory || []) {
    lines.push(`\nRound ${round.round}`);
    for (const group of round.groups || []) {
      lines.push(`\n${groupDisplayName(group)}${group.isFinal ? " (Final)" : ""}`);
      for (const result of group.results || []) {
        lines.push(`- ${result.displayName} — ${result.guildName} — ${result.count} fish — ${formatKg(result.totalWeight)}${result.qualifier ? " — Qualified" : ""}`);
      }
      if (group.logs?.length) {
        lines.push("Battle Log");
        lines.push(...group.logs.map(visibleBattleLog));
      }
    }
  }
  return lines.join("\n");
}

function createWorldTournamentService(deps) {
  const statePath = deps.statePath || path.join(__dirname, "..", ".runtime", "world-fish-tournament.json");
  let state = null;
  let registrationTimer = null;
  let reminderTimer = null;
  let runnerPromise = null;
  let syncPromise = Promise.resolve();

  function writeState() {
    if (!state) return;
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    const temporaryPath = `${statePath}.tmp`;
    fs.writeFileSync(temporaryPath, JSON.stringify(state, null, 2));
    try {
      fs.renameSync(temporaryPath, statePath);
    } catch (error) {
      // Windows does not replace an existing file during rename. Remove only
      // this exact state file, then complete the replacement.
      if (!['EPERM', 'EEXIST', 'EXDEV'].includes(error.code)) throw error;
      fs.rmSync(statePath, { force: true });
      fs.renameSync(temporaryPath, statePath);
    }
  }

  function readState() {
    try {
      const sourcePath = fs.existsSync(statePath) ? statePath : `${statePath}.tmp`;
      if (!fs.existsSync(sourcePath)) return null;
      const saved = JSON.parse(fs.readFileSync(sourcePath, "utf8"));
      return saved && typeof saved === "object" ? saved : null;
    } catch (error) {
      deps.log?.(`Could not load World Fish Competition state: ${error.message}`);
      return null;
    }
  }

  function active() {
    return state && WORLD_STATUS_ACTIVE.has(state.status) ? state : null;
  }

  function clearTimers() {
    if (registrationTimer) clearTimeout(registrationTimer);
    if (reminderTimer) clearTimeout(reminderTimer);
    registrationTimer = null;
    reminderTimer = null;
  }

  function makeButtons(status) {
    if (status === "cancelled") return [];
    if (status === "registration") {
      return [new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`fishworldcomp_join:${state.id}`).setLabel("Join World Competition").setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId(`fishworldcomp_leave:${state.id}`).setLabel("Leave").setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId(`fishworldcomp_participants:${state.id}`).setLabel("View Participants").setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId(`fishworldcomp_cancel:${state.id}`).setLabel("Cancel Registration").setStyle(ButtonStyle.Danger)
      )];
    }
    if (status === "running") {
      return [new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`fishworldcomp_participants:${state.id}`).setLabel("View Participants").setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId(`fishworldcomp_teams:${state.id}`).setLabel("View Teams").setStyle(ButtonStyle.Primary)
      )];
    }
    return [new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`fishworldcomp_history:${state.id}`).setLabel("View Full Tournament Log").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(`fishworldcomp_participants:${state.id}`).setLabel("View Participants").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId(`fishworldcomp_teams:${state.id}`).setLabel("View Teams").setStyle(ButtonStyle.Primary)
    )];
  }

  function serverSummary() {
    const servers = participantServerGroups(state.participants);
    if (!servers.length) return "Belum ada peserta.";
    const lines = servers.map((server, index) => `${index + 1}. ${escapeText(server.guildName)} (${server.participants.length} Participant${server.participants.length === 1 ? "" : "s"})`);
    if (lines.join("\n").length > 3_000) {
      return `${lines.slice(0, 55).join("\n")}\n...lihat daftar lengkap dengan tombol View Participants.`;
    }
    return lines.join("\n");
  }

  function currentGroup() {
    if (!state?.groups?.length) return null;
    const index = Math.min(Math.max(integerOr(state.currentGroupIndex, 0), 0), state.groups.length - 1);
    return state.groups[index] || null;
  }

  function runningDescription() {
    const group = currentGroup();
    const recentLogs = group?.logs?.slice(-12).map((log) => escapeText(visibleBattleLog(log))).join("\n") || "Menunggu hasil...";
    const scoreLines = group
      ? sortedResults(Object.values(group.results || {})).map((result) => `${escapeText(result.displayName)} — ${escapeText(result.guildName)} — ${result.count} fish — ${formatKg(result.totalWeight)}`).join("\n")
      : "Belum ada hasil.";
    return [
      `Round **${state.currentRound}** · Group **${groupDisplayName(group)}** · **${Math.min(state.currentGroupIndex + 1, state.groups.length)}/${state.groups.length}**`,
      group?.isFinal ? `**Final Group · ${group?.turns || state.finalTurns} turns**` : `Group match · ${group?.turns || state.standardTurns} turns`,
      `Peserta global: **${Object.keys(state.participants || {}).length}**`,
      "",
      `**${groupDisplayName(group)} Scoreboard**`,
      scoreLines || "Belum ada hasil.",
      "",
      "**Live Battle Log**",
      recentLogs
    ].join("\n").slice(0, 3_900);
  }

  function resultDescription() {
    const placement = Object.values(state.participants || {})
      .filter((participant) => participant.placement > 0)
      .sort((left, right) => left.placement - right.placement)
      .slice(0, state.publicPlacementCount);
    const total = accumulatedRanking(state).slice(0, state.publicPlacementCount);
    return [
      "World Fish Competition sudah selesai.",
      "",
      "**Tournament Placement**",
      placement.length ? placement.map((participant) => `${participant.placement}. ${escapeText(participant.displayName)} — ${escapeText(participant.guildName)} — Reward: ${formatReward(state.rewardLedger?.[participant.id])}`).join("\n") : "Tidak ada peserta.",
      "",
      "**Top Accumulated Fish Ranking**",
      total.length ? total.map((participant, index) => `${index + 1}. ${escapeText(participant.displayName)} — ${escapeText(participant.guildName)} — ${participant.totalFish} fish — Reward: ${formatReward(state.rewardLedger?.[participant.id])}`).join("\n") : "Tidak ada peserta.",
      "",
      `Champion Server: **${escapeText(state.championServerName, "-")}**`,
      `Participant reward: **${formatReward({ exp: state.participantExpReward, gold: state.participantGoldReward })}** · Champion Server bonus: **${formatReward({ exp: state.championServerExpReward, gold: state.championServerGoldReward })}**`,
      "Daftar lengkap dan log semua group tersedia melalui tombol di bawah."
    ].join("\n");
  }

  function makePayload(status = state.status) {
    const embed = new EmbedBuilder()
      .setColor(status === "registration" ? 0xe67e22 : status === "running" ? 0x3498db : status === "finished" ? 0x2ecc71 : 0xe74c3c)
      .setTitle("World Fish Competition");

    if (status === "registration") {
      embed.setDescription([
        "Kompetisi memancing lintas server sedang membuka registrasi.",
        `Registrasi ditutup: <t:${Math.floor(state.registrationEndsAt / 1000)}:R> · <t:${Math.floor(state.registrationEndsAt / 1000)}:F>`,
        `Peserta: **${Object.keys(state.participants || {}).length}/${state.maxParticipants}**`,
        `Group target: **${state.groupSize} peserta** · Normal round: **${state.standardTurns} turns** · Final: **${state.finalTurns} turns**`,
        "",
        "**Server Representasi**",
        serverSummary(),
        "",
        "Gunakan tombol **View Participants** untuk mengunduh daftar lengkap peserta dan server yang mereka wakili."
      ].join("\n"));
    } else if (status === "running") {
      embed.setDescription(runningDescription());
    } else if (status === "finished") {
      embed.setDescription(resultDescription());
    } else {
      embed.setDescription(state.cancelReason || "World Fish Competition dibatalkan.");
    }

    const banner = deps.makeWorldFishCompImage?.(status === "finished" ? "result" : status === "running" ? "running" : "registration", state.bannerSettings);
    if (banner?.url) embed.setImage(banner.url);
    return {
      embeds: [embed],
      files: banner?.attachment ? [banner.attachment] : [],
      components: makeButtons(status === "registration" ? "registration" : status === "running" ? "running" : status === "cancelled" ? "cancelled" : "finished")
    };
  }

  function makeReminderPayload() {
    const container = new ContainerBuilder()
      .setAccentColor(0xe67e22)
      .addTextDisplayComponents(new TextDisplayBuilder().setContent([
        "## 🌍 World Fish Competition",
        "Registrasi masih dibuka.",
        `Peserta: **${Object.keys(state.participants || {}).length}/${state.maxParticipants}**`,
        `Sisa waktu: **${formatDuration(state.registrationEndsAt - Date.now())}**`,
        "Klik tombol di bawah untuk langsung bergabung dari pesan reminder ini."
      ].join("\n")))
      .addSeparatorComponents(new SeparatorBuilder())
      .addActionRowComponents(makeButtons("registration"));
    return {
      flags: MessageFlags.IsComponentsV2 || 32768,
      components: [container],
      allowedMentions: { parse: [] }
    };
  }

  async function fetchMessage(record) {
    if (!record?.channelId || !record?.messageId) return null;
    const channel = await deps.client.channels.fetch(record.channelId).catch(() => null);
    const message = channel?.messages?.fetch ? await channel.messages.fetch(record.messageId).catch(() => null) : null;
    return message;
  }

  async function deleteMessageRecord(record) {
    const message = await fetchMessage(record);
    await Promise.resolve(message?.delete?.()).catch(() => {});
  }

  async function deleteReminderForGuild(guildId) {
    const reminder = state.reminders?.[guildId];
    if (reminder) await deleteMessageRecord(reminder);
    if (state.reminders) delete state.reminders[guildId];
  }

  async function deleteAllReminders() {
    for (const guildId of Object.keys(state?.reminders || {})) {
      await deleteReminderForGuild(guildId);
    }
    if (state?.reminders) state.reminders = {};
    writeState();
  }

  function messagePhase(status) {
    if (status === "registration") return "registration";
    if (status === "running") return "running";
    if (status === "finished") return "finished";
    return "cancelled";
  }

  async function syncMessages(reason = "update") {
    if (!deps.client.isReady?.()) return;
    const phase = messagePhase(state.status);
    const payload = makePayload(phase);
    const guildIds = deps.getBotGuildIds();
    for (const guildId of guildIds) {
      const record = state.messages?.[guildId] || { guildId };
      const shouldReplace = Boolean(record.messageId && (record.phase ? record.phase !== phase : phase !== "registration"));
      if (shouldReplace) {
        await deleteMessageRecord(record);
        await deleteReminderForGuild(guildId);
      }
      let message = shouldReplace ? null : await fetchMessage(record);
      if (!message) {
        if (record.messageId && !shouldReplace) await deleteReminderForGuild(guildId);
        const channel = await deps.fetchGuildBroadcastChannel(guildId).catch(() => null);
        if (!channel?.send) continue;
        message = await channel.send(payload).catch((error) => {
          deps.log?.(`Could not send World Fish Competition message to ${guildId}: ${error.message}`);
          return null;
        });
        if (!message) continue;
        state.messages[guildId] = { guildId, phase, channelId: message.channelId, messageId: message.id };
      } else {
        await message.edit(payload).catch((error) => deps.log?.(`Could not update World Fish Competition message in ${guildId}: ${error.message}`));
        state.messages[guildId] = { guildId, phase, channelId: message.channelId, messageId: message.id };
      }
    }
    writeState();
    deps.log?.(`World Fish Competition messages synchronized | reason=${reason}`);
  }

  function queueSync(reason = "update") {
    syncPromise = syncPromise.catch(() => {}).then(() => syncMessages(reason));
    return syncPromise;
  }

  async function sendReminder() {
    if (!active() || state.status !== "registration" || state.reminderMinutes <= 0) return;
    for (const guildId of deps.getBotGuildIds()) {
      const record = state.messages?.[guildId];
      const channel = record?.channelId ? await deps.client.channels.fetch(record.channelId).catch(() => null) : await deps.fetchGuildBroadcastChannel(guildId).catch(() => null);
      const parent = await fetchMessage(record);
      if (!channel?.send && !parent?.reply) continue;
      await deleteReminderForGuild(guildId);
      const reminder = parent?.reply
        ? await parent.reply(makeReminderPayload()).catch(() => null)
        : await channel.send(makeReminderPayload()).catch(() => null);
      if (reminder) state.reminders[guildId] = { guildId, channelId: reminder.channelId, messageId: reminder.id };
    }
    writeState();
  }

  function scheduleTimers() {
    clearTimers();
    if (!state || state.status !== "registration") return;
    const remaining = Math.max(0, state.registrationEndsAt - Date.now());
    registrationTimer = setTimeout(() => {
      finishRegistration().catch((error) => deps.log?.(`World Fish Competition registration failed: ${error.message}`));
    }, Math.min(remaining || 1, 2_147_000_000));
    if (state.reminderMinutes > 0) {
      const scheduleReminder = () => {
        if (!active() || state.status !== "registration") return;
        if (Date.now() >= state.registrationEndsAt) return;
        reminderTimer = setTimeout(async () => {
          await sendReminder().catch((error) => deps.log?.(`World Fish Competition reminder failed: ${error.message}`));
          scheduleReminder();
        }, Math.min(state.reminderMinutes * 60_000, Math.max(1_000, state.registrationEndsAt - Date.now())));
      };
      scheduleReminder();
    }
  }

  function snapshotFishPool() {
    return (deps.getGlobalFishPool?.() || []).map((fish) => ({
      id: cleanText(fish.id),
      name: cleanText(fish.name, cleanText(fish.id, "Fish")),
      baseWeight: numberOr(fish.baseWeight, 0),
      minWeight: numberOr(fish.minWeight, 0),
      maxWeight: numberOr(fish.maxWeight, 0),
      luckScale: numberOr(fish.luckScale, 0),
      description: cleanText(fish.description),
      rarity: cleanText(fish.rarity, "Common")
    })).filter((fish) => fish.id && fish.baseWeight > 0);
  }

  function snapshotRules(settings) {
    return {
      fishCompEvents: clone(Array.isArray(settings.fishCompEvents) ? settings.fishCompEvents : [])
    };
  }

  async function start(options = {}) {
    if (active()) throw new Error("A World Fish Competition is already active.");
    const override = options.settings && typeof options.settings === "object" ? options.settings : options;
    const rawSettings = { ...deps.getSettings(), ...override };
    const settings = normalizeSettings(rawSettings);
    if (settings.maxParticipants < settings.minParticipants) settings.maxParticipants = settings.minParticipants;
    state = {
      id: makeId("worldfishcomp"),
      status: "registration",
      createdAt: new Date().toISOString(),
      registrationEndsAt: Date.now() + settings.registrationMinutes * 60_000,
      ...settings,
      participants: {},
      messages: {},
      reminders: {},
      groups: [],
      roundHistory: [],
      currentRound: 0,
      currentGroupIndex: 0,
      currentGroupAction: 0,
      fishPool: [],
      bannerSettings: snapshotBannerSettings(rawSettings),
      settingsSnapshot: {},
      logs: [],
      championServerId: "",
      championServerName: "",
      rewardLedger: {},
      cancelReason: ""
    };
    writeState();
    await queueSync("registration opened");
    scheduleTimers();
    deps.log?.(`World Fish Competition registration opened | tournament=${state.id} | minutes=${settings.registrationMinutes}`);
    return { id: state.id, registrationEndsAt: state.registrationEndsAt, settings };
  }

  async function cancelRegistration(reason = "World Fish Competition dibatalkan oleh admin.") {
    if (!state || state.status !== "registration") throw new Error("World Fish Competition is not in registration.");
    clearTimers();
    state.status = "cancelled";
    state.cancelReason = reason;
    writeState();
    await queueSync("registration cancelled");
    await deleteAllReminders();
    return state;
  }

  async function prepareParticipants() {
    const participants = Object.values(state.participants || {});
    let cursor = 0;
    const worker = async () => {
      while (cursor < participants.length) {
        const participant = participants[cursor++];
        await deps.prepareCompetitionParticipant(participant).catch((error) => deps.log?.(`Could not prepare World Fish Competition participant ${participant.id}: ${error.message}`));
      }
    };
    await Promise.all(Array.from({ length: Math.min(8, participants.length) }, () => worker()));
  }

  function hydrateRuntimeGroup(group) {
    const participants = new Map((group.participantIds || []).map((id) => [id, state.participants[id]]).filter(([, participant]) => participant));
    const results = Object.keys(group.results || {}).length
      ? objectToMap(group.results)
      : new Map([...participants.values()].map((participant) => [participant.id, createResult(participant)]));
    return {
      ...group,
      mode: "competition",
      guildId: "",
      participants,
      results,
      logs: Array.isArray(group.logs) ? group.logs : [],
      eventStates: objectToMap(group.eventStates),
      currentTurnEffects: objectToMap(group.currentTurnEffects),
      fishPoolOverride: state.fishPool,
      settingsSnapshot: state.settingsSnapshot
    };
  }

  function saveRuntimeGroup(group, runtime) {
    group.status = runtime.status || group.status;
    group.currentTurn = runtime.currentTurn;
    group.currentOrder = runtime.currentOrder || [];
    group.currentOrderIndex = runtime.currentOrderIndex || 0;
    group.eventStates = mapToObject(runtime.eventStates);
    group.currentTurnEffects = mapToObject(runtime.currentTurnEffects);
    group.results = mapToObject(runtime.results);
    group.logs = runtime.logs || [];
  }

  function updateAccumulatedScore(participantId, before, after) {
    const participant = state.participants[participantId];
    if (!participant) return;
    const fishDelta = Math.max(0, Number(after.count || 0) - Number(before.count || 0));
    const weightDelta = Math.max(0, Number(after.totalWeight || 0) - Number(before.totalWeight || 0));
    participant.totalFish += fishDelta;
    participant.totalWeight += weightDelta;
    if (Number(after.heaviestWeight || 0) > Number(participant.heaviestWeight || 0)) {
      participant.heaviestWeight = Number(after.heaviestWeight || 0);
      participant.heaviestName = after.heaviestName || "";
    }
  }

  async function runGroup(group) {
    const runtime = hydrateRuntimeGroup(group);
    runtime.status = "running";
    group.status = "running";
    writeState();
    await queueSync(`group ${group.id} started`);

    while (runtime.currentTurn < runtime.turns) {
      if (!runtime.currentOrder.length || runtime.currentOrderIndex >= runtime.currentOrder.length) {
        runtime.currentTurn += 1;
        runtime.currentOrder = shuffle(runtime.participantIds);
        runtime.currentOrderIndex = 0;
        runtime.currentTurnEffects = new Map();
      }

      const participantId = runtime.currentOrder[runtime.currentOrderIndex];
      const participant = runtime.participants.get(participantId);
      if (!participant) {
        runtime.currentOrderIndex += 1;
        continue;
      }
      const before = clone(runtime.results.get(participantId) || createResult(participant));
      const logStart = runtime.logs.length;
      deps.runCompetitionTurnForParticipant(runtime, participant, runtime.currentTurn);
      const after = runtime.results.get(participantId) || before;
      updateAccumulatedScore(participantId, before, after);
      runtime.currentOrderIndex += 1;
      saveRuntimeGroup(group, runtime);
      state.currentGroupAction += 1;
      writeState();
      await queueSync(`group ${group.id} action ${state.currentGroupAction}`);
      if (runtime.logs.length > logStart && runtime.currentTurn < runtime.turns) {
        await sleep(state.logIntervalMs);
      }
    }

    runtime.status = "finished";
    const finalResults = sortedResults([...runtime.results.values()]);
    const qualifierCount = runtime.isFinal ? 0 : Math.max(1, Math.floor(finalResults.length / 2));
    runtime.qualifierIds = runtime.isFinal ? [] : finalResults.slice(0, qualifierCount).map((result) => result.id);
    group.qualifierIds = runtime.qualifierIds;
    group.status = "finished";
    group.finishedAt = new Date().toISOString();
    saveRuntimeGroup(group, runtime);
    for (const result of finalResults) {
      result.qualifier = group.qualifierIds.includes(result.id);
    }
    const historyGroup = {
      id: group.id,
      round: group.round,
      index: group.index,
      isFinal: group.isFinal,
      turns: group.turns,
      participantIds: [...group.participantIds],
      results: finalResults.map((result) => ({ ...result, qualifier: group.qualifierIds.includes(result.id) })),
      logs: [...runtime.logs]
    };
    let round = state.roundHistory.find((entry) => entry.round === group.round);
    if (!round) {
      round = { round: group.round, groups: [] };
      state.roundHistory.push(round);
    }
    round.groups = [...round.groups.filter((entry) => entry.id !== group.id), historyGroup];
    writeState();
    await queueSync(`group ${group.id} finished`);
  }

  function assignPlacements() {
    const finalGroups = state.roundHistory
      .flatMap((round) => round.groups || [])
      .filter((group) => group.isFinal);
    const finalResults = finalGroups.flatMap((group) => group.results || []);
    const remaining = Object.values(state.participants || {}).filter((participant) => !finalResults.some((result) => result.id === participant.id));
    const ordered = [
      ...sortedResults(finalResults).map((result) => state.participants[result.id]).filter(Boolean),
      ...remaining.sort((left, right) => (
        Number(right.roundReached || 0) - Number(left.roundReached || 0)
        || Number(right.totalFish || 0) - Number(left.totalFish || 0)
        || Number(right.totalWeight || 0) - Number(left.totalWeight || 0)
        || left.displayName.localeCompare(right.displayName)
      ))
    ];
    ordered.forEach((participant, index) => {
      participant.placement = index + 1;
    });
    const champion = ordered[0];
    state.championServerId = champion?.guildId || "";
    state.championServerName = champion?.guildName || "";
  }

  function rewardForPlacement(placement) {
    if (placement === 1) return { exp: state.firstExpReward, gold: state.firstGoldReward };
    if (placement === 2) return { exp: state.secondExpReward, gold: state.secondGoldReward };
    if (placement === 3) return { exp: state.thirdExpReward, gold: state.thirdGoldReward };
    return { exp: 0, gold: 0 };
  }

  async function payParticipant(participant, reward, reason) {
    if (!participant?.id || state.rewardLedger[participant.id]?.paid) return;
    const totalExp = Math.max(0, integerOr(reward.exp, 0));
    const totalGold = Math.max(0, integerOr(reward.gold, 0));
    let alreadyApplied = false;
    await deps.withPlayer(participant.id, async (player) => {
      if (!Array.isArray(player.worldFishCompRewardIds)) player.worldFishCompRewardIds = [];
      if (player.worldFishCompRewardIds.includes(state.id)) {
        alreadyApplied = true;
        return { save: false };
      }
      player.worldFishCompRewardIds.push(state.id);
      player.exp += totalExp;
      player.gold = Math.max(0, integerOr(player.gold, 0)) + totalGold;
      return undefined;
    });
    state.rewardLedger[participant.id] = {
      paid: true,
      alreadyApplied,
      exp: totalExp,
      gold: totalGold,
      reason,
      paidAt: new Date().toISOString()
    };
    writeState();
  }

  async function distributeRewards() {
    state.status = "rewards";
    writeState();
    const championServerId = state.championServerId;
    for (const participant of Object.values(state.participants || {})) {
      const placementReward = rewardForPlacement(participant.placement);
      const reward = {
        exp: state.participantExpReward + placementReward.exp + (participant.guildId === championServerId ? state.championServerExpReward : 0),
        gold: state.participantGoldReward + placementReward.gold + (participant.guildId === championServerId ? state.championServerGoldReward : 0)
      };
      await payParticipant(participant, reward, participant.placement <= state.publicPlacementCount ? `placement_${participant.placement}` : "participant");
    }
  }

  async function finishTournament() {
    assignPlacements();
    await distributeRewards();
    state.status = "finished";
    state.finishedAt = new Date().toISOString();
    state.historyLogId = `${state.id}:world:${Date.now()}`;
    deps.rememberCompetitionHistoryLog(state.historyLogId, {
      createdAt: Date.now(),
      fileName: "world_fish_competition_log.txt",
      retentionHours: state.historyLogHours,
      content: buildHistoryText(state)
    });
    writeState();
    await queueSync("tournament finished");
    clearTimers();
    deps.log?.(`World Fish Competition finished | tournament=${state.id} | champion=${Object.values(state.participants).find((participant) => participant.placement === 1)?.displayName || "-"}`);
  }

  async function continueTournament() {
    if (!active() || state.status !== "running" || runnerPromise) return;
    runnerPromise = (async () => {
      while (state.status === "running") {
        if (state.currentGroupIndex >= state.groups.length) {
          const qualifiers = state.groups.flatMap((group) => group.qualifierIds || []);
          if (qualifiers.length <= 1 || state.groups.some((group) => group.isFinal && group.status === "finished")) {
            await finishTournament();
            break;
          }
          state.currentRound += 1;
          state.currentGroupIndex = 0;
          state.currentGroupAction = 0;
          state.groups = makeGroups(qualifiers, state.groupSize, state.currentRound, state);
          for (const group of state.groups) {
            for (const id of group.participantIds) state.participants[id].roundReached = state.currentRound;
          }
          writeState();
          await queueSync(`round ${state.currentRound} started`);
          continue;
        }

        const group = state.groups[state.currentGroupIndex];
        if (group.status !== "finished") await runGroup(group);
        state.currentGroupIndex += 1;
        state.currentGroupAction = 0;
        writeState();
        await queueSync(`moving after ${group.id}`);
        if (state.status === "running") await sleep(state.groupDelayMs);
      }
    })().catch(async (error) => {
      deps.log?.(`World Fish Competition stopped with recoverable error: ${error.stack || error.message}`);
      if (state) {
        state.lastError = error.message;
        writeState();
      }
    }).finally(() => {
      runnerPromise = null;
    });
    return runnerPromise;
  }

  async function finishRegistration() {
    if (!state || state.status !== "registration") return;
    clearTimers();
    const participantCount = Object.keys(state.participants || {}).length;
    if (participantCount < state.minParticipants) {
      await cancelRegistration(`Registrasi World Fish Competition ditutup karena hanya ada **${participantCount}** peserta. Minimal peserta: **${state.minParticipants}**.`);
      return;
    }
    state.fishPool = snapshotFishPool();
    state.settingsSnapshot = snapshotRules(deps.getSettings());
    if (!state.fishPool.length) {
      await cancelRegistration("World Fish Competition dibatalkan karena global fish pool belum tersedia.");
      return;
    }
    await deleteAllReminders();
    state.status = "running";
    await prepareParticipants();
    const ids = Object.keys(state.participants || {});
    state.currentRound = 1;
    state.currentGroupIndex = 0;
    let initialGroups;
    try {
      initialGroups = makeGroups(ids, state.groupSize, state.currentRound, state);
    } catch (error) {
      state.status = "registration";
      await cancelRegistration("World Fish Competition dibatalkan karena peserta tidak dapat dibagi ke group secara aman.");
      throw error;
    }
    state.groups = initialGroups;
    for (const group of state.groups) {
      for (const id of group.participantIds) state.participants[id].roundReached = state.currentRound;
    }
    writeState();
    await queueSync("registration closed; tournament started");
    await continueTournament();
  }

  async function handleButton(interaction) {
    const customId = String(interaction.customId || "");
    if (!customId.startsWith("fishworldcomp_")) return false;
    const [action, tournamentId] = customId.split(":");
    if (!state || state.id !== tournamentId) {
      await interaction.reply({ content: "Turnamen World Fish Competition ini sudah tidak aktif.", flags: MessageFlags.Ephemeral });
      return true;
    }

    if (action === "fishworldcomp_participants") {
      await interaction.reply({ files: [new AttachmentBuilder(Buffer.from(buildParticipantText(state), "utf8"), { name: "world_fish_participants.txt" })], flags: MessageFlags.Ephemeral });
      return true;
    }
    if (action === "fishworldcomp_teams") {
      if (!state.groups?.length) {
        await interaction.reply({ content: "Team belum dibuat. Tunggu registrasi selesai.", flags: MessageFlags.Ephemeral });
        return true;
      }
      await interaction.reply({ files: [new AttachmentBuilder(Buffer.from(buildTeamsText(state), "utf8"), { name: "world_fish_teams.txt" })], flags: MessageFlags.Ephemeral });
      return true;
    }
    if (action === "fishworldcomp_history") {
      if (state.status !== "finished" || !state.historyLogId) {
        await interaction.reply({ content: "Log final belum tersedia.", flags: MessageFlags.Ephemeral });
        return true;
      }
      const log = deps.getCompetitionHistoryLog(state.historyLogId);
      if (!log) {
        await interaction.reply({ content: "Log final sudah tidak tersedia.", flags: MessageFlags.Ephemeral });
        return true;
      }
      await interaction.reply({ files: [new AttachmentBuilder(Buffer.from(log.content, "utf8"), { name: log.fileName || "world_fish_competition_log.txt" })], flags: MessageFlags.Ephemeral });
      return true;
    }

    if (action === "fishworldcomp_cancel") {
      if (state.status !== "registration") {
        await interaction.reply({ content: "Turnamen sudah dimulai dan tidak bisa dibatalkan.", flags: MessageFlags.Ephemeral });
        return true;
      }
      if (!deps.isAdmin(interaction.user)) {
        await interaction.reply({ content: "Hanya admin yang bisa membatalkan registrasi World Fish Competition.", flags: MessageFlags.Ephemeral });
        return true;
      }
      await interaction.deferUpdate();
      await cancelRegistration("World Fish Competition dibatalkan oleh admin.");
      return true;
    }

    if (state.status !== "registration") {
      await interaction.reply({ content: "Registrasi sudah ditutup.", flags: MessageFlags.Ephemeral });
      return true;
    }
    if (!interaction.guildId) {
      await interaction.reply({ content: "World Fish Competition hanya bisa diikuti dari server Discord.", flags: MessageFlags.Ephemeral });
      return true;
    }
    if (action === "fishworldcomp_join") {
      if (interaction.user.bot) {
        await interaction.reply({ content: "Bot tidak bisa ikut kompetisi.", flags: MessageFlags.Ephemeral });
        return true;
      }
      const existing = state.participants[interaction.user.id];
      if (existing) {
        await interaction.reply({ content: existing.guildId === interaction.guildId ? "Kamu sudah join dari server ini." : `Kamu sudah mewakili server **${existing.guildName}**. Satu user hanya boleh mewakili satu server.`, flags: MessageFlags.Ephemeral });
        return true;
      }
      if (Object.keys(state.participants).length >= state.maxParticipants) {
        await interaction.reply({ content: "Jumlah peserta sudah mencapai batas maksimum.", flags: MessageFlags.Ephemeral });
        return true;
      }
      const globalName = cleanText(interaction.user.globalName || interaction.user.username, "Unknown User");
      state.participants[interaction.user.id] = normalizeParticipant({
        id: interaction.user.id,
        username: interaction.user.username,
        globalName,
        displayName: globalName,
        guildId: interaction.guildId,
        guildName: interaction.guild?.name || interaction.guildId
      });
      writeState();
      await interaction.deferUpdate();
      await queueSync("participant joined");
      return true;
    }
    if (action === "fishworldcomp_leave") {
      if (!state.participants[interaction.user.id]) {
        await interaction.reply({ content: "Kamu belum join kompetisi ini.", flags: MessageFlags.Ephemeral });
        return true;
      }
      delete state.participants[interaction.user.id];
      writeState();
      await interaction.deferUpdate();
      await queueSync("participant left");
      return true;
    }

    await interaction.reply({ content: "Tombol World Fish Competition tidak dikenali.", flags: MessageFlags.Ephemeral });
    return true;
  }

  async function handleAdminCommand(command, message) {
    if (!["fishworldcompforcestart", "fishworldcompcancel"].includes(command)) return false;
    if (!deps.isAdmin(message.author)) {
      await message.reply("Only admins can manage the World Fish Competition.");
      return true;
    }
    if (command === "fishworldcompcancel") {
      if (!state || state.status !== "registration") {
        await message.reply("Tidak ada registrasi World Fish Competition yang bisa dibatalkan.");
        return true;
      }
      await cancelRegistration("World Fish Competition dibatalkan oleh admin.");
      await message.reply("Registrasi World Fish Competition dibatalkan.");
      return true;
    }
    if (!state || state.status !== "registration") {
      await message.reply("Tidak ada World Fish Competition yang sedang registrasi.");
      return true;
    }
    if (Object.keys(state.participants).length < state.minParticipants) {
      await message.reply(`Butuh minimal ${state.minParticipants} peserta untuk mulai.`);
      return true;
    }
    await message.reply("World Fish Competition dipaksa mulai sekarang.");
    await finishRegistration();
    return true;
  }

  async function processSignal(request) {
    const action = cleanText(request?.action);
    if (action === "start") return start({ settings: request.settings || {} });
    if (action === "cancel") return cancelRegistration("World Fish Competition dibatalkan dari Manager.");
    if (action === "force_start") return finishRegistration();
    return null;
  }

  async function recover() {
    state = readState();
    if (!state) return;
    state.participants = Object.fromEntries(Object.entries(state.participants || {}).map(([id, participant]) => [id, normalizeParticipant({ ...participant, id })]));
    if (state.status === "registration") {
      scheduleTimers();
      if (Date.now() >= state.registrationEndsAt) await finishRegistration();
      else await queueSync("registration recovered");
      return;
    }
    if (state.status === "running") {
      await queueSync("running tournament recovered");
      await continueTournament();
    } else if (state.status === "rewards") {
      // Reward distribution is intentionally resumable. The persisted reward
      // ledger and per-player tournament id make retries idempotent.
      await finishTournament();
    } else if (state.status === "finished") {
      await queueSync("finished tournament recovered");
    }
  }

  function getStatus() {
    if (!state) return { active: false };
    return {
      active: WORLD_STATUS_ACTIVE.has(state.status),
      id: state.id,
      status: state.status,
      participants: Object.keys(state.participants || {}).length,
      registrationEndsAt: state.registrationEndsAt || 0,
      currentRound: state.currentRound || 0,
      currentGroupIndex: state.currentGroupIndex || 0
    };
  }

  return {
    start,
    recover,
    handleButton,
    handleAdminCommand,
    processSignal,
    getStatus,
    getState: () => state
  };
}

module.exports = {
  createWorldTournamentService,
  normalizeSettings,
  makeGroups
};
