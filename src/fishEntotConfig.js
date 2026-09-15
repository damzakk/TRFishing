const defaultFishEntotEvents = [
  {
    id: "gold_gain",
    name: "Fish Pays You",
    enabled: true,
    positive: true,
    weight: 1,
    outcome: "gold_gain",
    reward: { minPercent: 1, maxPercent: 40, minAmount: 0, maxAmount: 0, progressTarget: 0, minCatches: 1, maxCatches: 1 },
    messages: ["{user} adalah pengentot yang handal, {fish} senang dan membayar {gold}."]
  },
  {
    id: "gold_loss",
    name: "Fish Demands Compensation",
    enabled: true,
    positive: false,
    weight: 1,
    outcome: "gold_loss",
    reward: { minPercent: 1, maxPercent: 30, minAmount: 0, maxAmount: 0, progressTarget: 0, minCatches: 1, maxCatches: 1 },
    messages: ["{user} adalah pengentot yang payah, {fish} meminta {gold} ganti rugi."]
  },
  {
    id: "fish_gain",
    name: "Fish Has Children",
    enabled: true,
    positive: true,
    weight: 1,
    outcome: "fish_gain",
    reward: { minPercent: 0, maxPercent: 0, minAmount: 1, maxAmount: 1, progressTarget: 0, minCatches: 1, maxCatches: 1 },
    messages: ["{user} menghamili {fish}, {user} mendapatkan {fishCount} anak."]
  },
  {
    id: "fish_loss",
    name: "Fish Escape",
    enabled: true,
    positive: false,
    weight: 1,
    outcome: "fish_loss",
    reward: { minPercent: 0, maxPercent: 0, minAmount: 1, maxAmount: 3, progressTarget: 0, minCatches: 1, maxCatches: 1 },
    messages: ["{user} gagal menjadi seorang pengentot, {fishCount} ikan pergi meninggalkan inventory."]
  },
  {
    id: "progress_reset",
    name: "Fishing Progress Lost",
    enabled: true,
    positive: false,
    weight: 1,
    outcome: "progress_reset",
    reward: { minPercent: 0, maxPercent: 0, minAmount: 0, maxAmount: 0, progressTarget: 0, minCatches: 1, maxCatches: 1 },
    messages: ["Pengentotan yang tidak nikmat ini membuat {user} kehilangan progres memancingnya."]
  },
  {
    id: "fish_catch",
    name: "Fishing Inspiration",
    enabled: true,
    positive: true,
    weight: 1,
    outcome: "fish_catch",
    reward: { minPercent: 0, maxPercent: 0, minAmount: 0, maxAmount: 0, progressTarget: 0, minCatches: 1, maxCatches: 1 },
    messages: ["Pengentotan yang nikmat memberi semangat untuk {user} memancing."]
  }
];

const defaultFishEntotSettings = {
  fishEntotEvents: defaultFishEntotEvents,
  fishEntotCooldownMinutes: 30,
  fishEntotMessageTtlMinutes: 15,
  fishEntotPityEnabled: true,
  fishEntotPityThreshold: 3
};

function finiteNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function cleanFishEntotEvents(events, fallbackEvents = defaultFishEntotEvents) {
  const sourceEvents = Array.isArray(events) ? events : fallbackEvents;
  const usedIds = new Set();
  return sourceEvents.map((event, index) => {
    const source = event && typeof event === "object" ? event : {};
    const rawId = String(source.id || `fishentot_event_${index + 1}`).trim().toLowerCase().replace(/[^a-z0-9_-]/g, "_");
    let id = rawId || `fishentot_event_${index + 1}`;
    while (usedIds.has(id)) id = `${rawId || "fishentot_event"}_${index + 1}`;
    usedIds.add(id);

    const requestedOutcome = String(source.outcome || source.type || "gold_gain").trim();
    const outcome = new Set(["gold_gain", "gold_loss", "fish_gain", "fish_loss", "progress_reset", "fish_catch"]).has(requestedOutcome)
      ? requestedOutcome
      : "gold_gain";
    const sourceReward = source.reward && typeof source.reward === "object" ? source.reward : source;
    const rawMessages = Array.isArray(source.messages)
      ? source.messages
      : Array.isArray(source.messageTemplates)
        ? source.messageTemplates
        : [source.message || source.text || ""];
    const messages = rawMessages
      .map((message) => String(typeof message === "object" ? message.text || message.message || "" : message || "").trim())
      .filter(Boolean)
      .slice(0, 100);
    const minPercent = Math.min(100, Math.max(0, finiteNumber(sourceReward.minPercent ?? sourceReward.percentMin, 0)));
    const maxPercent = Math.min(100, Math.max(minPercent, finiteNumber(sourceReward.maxPercent ?? sourceReward.percentMax, minPercent)));
    const minAmount = Math.max(0, Math.floor(finiteNumber(sourceReward.minAmount ?? sourceReward.amountMin, 0)));
    const maxAmount = Math.max(minAmount, Math.floor(finiteNumber(sourceReward.maxAmount ?? sourceReward.amountMax, minAmount)));
    const minCatches = Math.max(1, Math.floor(finiteNumber(sourceReward.minCatches ?? sourceReward.catchMin, 1)));
    const maxCatches = Math.max(minCatches, Math.floor(finiteNumber(sourceReward.maxCatches ?? sourceReward.catchMax, minCatches)));

    return {
      id,
      name: String(source.name || source.title || id).trim(),
      enabled: source.enabled !== false,
      positive: source.positive === true,
      weight: Math.max(0, finiteNumber(source.weight ?? source.chance, 1)),
      outcome,
      reward: {
        minPercent,
        maxPercent,
        minAmount,
        maxAmount,
        progressTarget: Math.max(0, finiteNumber(sourceReward.progressTarget ?? sourceReward.progress, 0)),
        minCatches,
        maxCatches
      },
      messages
    };
  }).filter((event) => event.id && event.name && event.messages.length);
}

module.exports = {
  defaultFishEntotEvents,
  defaultFishEntotSettings,
  cleanFishEntotEvents
};
