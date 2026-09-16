const NO_MUTATION_ID = "";

// Mutation IDs and safe defaults live in code, while all balance/display values
// are copied into the manager-editable settings object at runtime.
const defaultMutationDefinitions = [
  { id: "stone", name: "Stone", chance: 2.4, goldMultiplier: 1.15, expMultiplier: 1.1, sizeMultiplier: 1.35, color: 0x8d99ae, visual: "stone" },
  { id: "gold", name: "Gold", chance: 2.0, goldMultiplier: 2, expMultiplier: 1.25, sizeMultiplier: 1.1, color: 0xffd700, visual: "gold" },
  { id: "freezing", name: "Freezing", chance: 1.7, goldMultiplier: 1.5, expMultiplier: 1.35, sizeMultiplier: 0.9, color: 0x74d7ff, visual: "freezing" },
  { id: "ghost", name: "Ghost", chance: 1.45, goldMultiplier: 2.25, expMultiplier: 1.5, sizeMultiplier: 1, color: 0xc7b8ff, visual: "ghost" },
  { id: "radioactive", name: "Radioactive", chance: 1.2, goldMultiplier: 3, expMultiplier: 1.75, sizeMultiplier: 1.1, color: 0x7dff68, visual: "radioactive" },
  { id: "lightning", name: "Lightning", chance: 1, goldMultiplier: 2.75, expMultiplier: 2, sizeMultiplier: 0.95, color: 0xfff36b, visual: "lightning" },
  { id: "midnight", name: "Midnight", chance: 0.85, goldMultiplier: 3.5, expMultiplier: 2, sizeMultiplier: 1.05, color: 0x313b8f, visual: "midnight" },
  { id: "fairy_dust", name: "Fairy Dust", chance: 0.75, goldMultiplier: 4, expMultiplier: 2.25, sizeMultiplier: 0.95, color: 0xff9fea, visual: "fairy_dust" },
  { id: "gemstone", name: "Gemstone", chance: 0.65, goldMultiplier: 5, expMultiplier: 2.5, sizeMultiplier: 1.2, color: 0x7be7ff, visual: "gemstone" },
  { id: "corrupt", name: "Corrupt", chance: 0.55, goldMultiplier: 6, expMultiplier: 3, sizeMultiplier: 0.8, color: 0x8f45bd, visual: "corrupt" },
  { id: "galaxy", name: "Galaxy", chance: 0.45, goldMultiplier: 8, expMultiplier: 3.5, sizeMultiplier: 1.25, color: 0x8a63ff, visual: "galaxy" },
  { id: "bloodmoon", name: "Bloodmoon", chance: 0.35, goldMultiplier: 10, expMultiplier: 4, sizeMultiplier: 1.5, color: 0xd93654, visual: "bloodmoon" },
  { id: "minty", name: "Minty", chance: 0.3, goldMultiplier: 1.25, expMultiplier: 1.15, sizeMultiplier: 1, color: 0x8fffd2, visual: "minty" },
  { id: "jawa", name: "Jawa", chance: 0.2, goldMultiplier: 15, expMultiplier: 5, sizeMultiplier: 1.35, color: 0xff8a3d, visual: "jawa" }
];

const mutationById = new Map(defaultMutationDefinitions.map((mutation) => [mutation.id, mutation]));
const mutationVisualPresets = ["none", ...new Set(defaultMutationDefinitions.map((mutation) => mutation.visual))];
const mutationMotionPresets = ["static", "float", "orbit", "sweep", "pulse", "bounce", "spiral", "shake", "twinkle", "zoom"];
const defaultOverlaySettings = {
  id: "overlay_1",
  name: "Overlay 1",
  base64: "",
  url: "",
  ref: null,
  urlNeedsRehost: false,
  scale: 0.35,
  x: 75,
  y: 25,
  opacity: 1,
  motion: "static",
  motionSpeed: 1,
  enabled: true
};

function cleanNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function cleanColor(value, fallback = 0xffffff) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.max(0, Math.min(0xffffff, Math.floor(value)));
  }
  const text = String(value ?? "").trim().replace(/^#/, "").replace(/^0x/i, "");
  const parsed = Number.parseInt(text, 16);
  return Number.isFinite(parsed) ? Math.max(0, Math.min(0xffffff, parsed)) : fallback;
}

function normalizeMutationId(value) {
  return String(value || "").trim().toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^_+|_+$/g, "");
}

function normalizeOverlayId(value, fallback) {
  const normalized = String(value || "").trim().toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^_+|_+$/g, "");
  return normalized || fallback;
}

function normalizeMutationOverlay(rawOverlay, fallback = defaultOverlaySettings, index = 0) {
  const source = rawOverlay && typeof rawOverlay === "object" ? rawOverlay : {};
  const fallbackId = fallback.id || "overlay_" + (index + 1);
  const motion = String(source.motion ?? source.customOverlayMotion ?? fallback.motion ?? "static");
  return {
    id: normalizeOverlayId(source.id, fallbackId),
    name: String(source.name ?? fallback.name ?? "Overlay " + (index + 1)).trim() || fallback.name || "Overlay " + (index + 1),
    base64: String(source.base64 ?? source.customOverlayBase64 ?? fallback.base64 ?? ""),
    url: String(source.url ?? source.customOverlayUrl ?? fallback.url ?? "").trim(),
    ref: source.ref && typeof source.ref === "object"
      ? source.ref
      : source.customOverlayRef && typeof source.customOverlayRef === "object"
        ? source.customOverlayRef
        : fallback.ref || null,
    urlNeedsRehost: source.urlNeedsRehost === true || source.customOverlayUrlNeedsRehost === true,
    scale: Math.max(0.05, Math.min(2, cleanNumber(source.scale ?? source.customOverlayScale ?? fallback.scale, 0.35))),
    x: Math.max(0, Math.min(100, cleanNumber(source.x ?? source.customOverlayX ?? fallback.x, 75))),
    y: Math.max(0, Math.min(100, cleanNumber(source.y ?? source.customOverlayY ?? fallback.y, 25))),
    opacity: Math.max(0, Math.min(1, cleanNumber(source.opacity ?? source.customOverlayOpacity ?? fallback.opacity, 1))),
    motion: mutationMotionPresets.includes(motion) ? motion : String(fallback.motion || "static"),
    motionSpeed: Math.max(0.1, Math.min(5, cleanNumber(source.motionSpeed ?? source.customOverlayMotionSpeed ?? fallback.motionSpeed, 1))),
    enabled: source.enabled !== false
  };
}

function normalizeMutationDefinition(rawMutation, fallback) {
  const source = rawMutation && typeof rawMutation === "object" ? rawMutation : {};
  const sourceVisual = String(source.visual ?? fallback.visual ?? "none").trim().toLowerCase();
  const legacyOverlayPresent = Boolean(source.customOverlayBase64 || source.customOverlayUrl || source.customOverlayRef);
  const rawOverlays = Array.isArray(source.customOverlays)
    ? source.customOverlays
    : legacyOverlayPresent
      ? [{
        id: "overlay_1",
        name: "Overlay 1",
        customOverlayBase64: source.customOverlayBase64,
        customOverlayUrl: source.customOverlayUrl,
        customOverlayRef: source.customOverlayRef,
        customOverlayUrlNeedsRehost: source.customOverlayUrlNeedsRehost,
        customOverlayScale: source.customOverlayScale,
        customOverlayX: source.customOverlayX,
        customOverlayY: source.customOverlayY,
        customOverlayOpacity: source.customOverlayOpacity,
        customOverlayMotion: source.customOverlayMotion,
        customOverlayMotionSpeed: source.customOverlayMotionSpeed
      }]
      : [];
  const overlays = [];
  const usedIds = new Set();
  for (let index = 0; index < rawOverlays.length; index += 1) {
    const overlay = normalizeMutationOverlay(rawOverlays[index], {
      ...defaultOverlaySettings,
      id: "overlay_" + (index + 1),
      name: "Overlay " + (index + 1)
    }, index);
    let id = overlay.id;
    let suffix = 2;
    while (usedIds.has(id)) id = overlay.id + "_" + suffix++;
    usedIds.add(id);
    overlays.push({ ...overlay, id });
  }
  return {
    id: fallback.id,
    name: String(source.name ?? fallback.name).trim() || fallback.name,
    chance: Math.max(0, cleanNumber(source.chance ?? fallback.chance, fallback.chance)),
    goldMultiplier: Math.max(0, cleanNumber(source.goldMultiplier ?? fallback.goldMultiplier, fallback.goldMultiplier)),
    expMultiplier: Math.max(0, cleanNumber(source.expMultiplier ?? fallback.expMultiplier, fallback.expMultiplier)),
    sizeMultiplier: Math.max(0.01, cleanNumber(source.sizeMultiplier ?? fallback.sizeMultiplier, fallback.sizeMultiplier)),
    color: cleanColor(source.color ?? fallback.color, fallback.color),
    visual: sourceVisual === "custom"
      ? "none"
      : mutationVisualPresets.includes(sourceVisual)
        ? sourceVisual
        : mutationVisualPresets.includes(String(fallback.visual || ""))
          ? String(fallback.visual)
          : "none",
    enabled: source.enabled !== false,
    customOverlays: overlays
  };
}

function normalizeMutationSettings(rawMutations) {
  if (rawMutations === undefined || rawMutations === null) {
    return defaultMutationDefinitions.map((fallback) => normalizeMutationDefinition(fallback, fallback));
  }
  const source = Array.isArray(rawMutations)
    ? rawMutations
    : rawMutations && typeof rawMutations === "object"
      ? Object.entries(rawMutations).map(([id, mutation]) => ({
        ...(mutation && typeof mutation === "object" ? mutation : {}),
        id: mutation?.id || id
      }))
      : [];
  const normalized = [];
  const seen = new Set();
  for (const mutation of source) {
    const id = normalizeMutationId(mutation?.id);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const fallback = mutationById.get(id) || {
      id,
      name: id.replace(/_/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase()),
      chance: 0,
      goldMultiplier: 1,
      expMultiplier: 1,
      sizeMultiplier: 1,
      color: 0xffffff,
      visual: "none",
      customOverlays: []
    };
    normalized.push(normalizeMutationDefinition({ ...mutation, id }, fallback));
  }
  return normalized;
}

function getMutationDefinition(mutationId, rawMutations = null) {
  const normalizedId = normalizeMutationId(mutationId);
  if (!normalizedId) return null;
  const definitions = normalizeMutationSettings(rawMutations);
  return definitions.find((mutation) => mutation.id === normalizedId) || null;
}

function getMutationDefinitions(rawMutations = null) {
  return normalizeMutationSettings(rawMutations).map((mutation) => ({ ...mutation }));
}

function getMutationChoices(rawMutations = null) {
  return [
    { id: NO_MUTATION_ID, name: "No Mutation" },
    ...getMutationDefinitions(rawMutations).filter((mutation) => mutation.enabled).map((mutation) => ({ id: mutation.id, name: mutation.name }))
  ];
}

function rollMutation(randomValue = Math.random(), rawMutations = null, chanceOptions = {}) {
  const globalMultiplier = Math.max(0, cleanNumber(chanceOptions.globalMultiplier, 1));
  const specificMultipliers = chanceOptions.specificMultipliers && typeof chanceOptions.specificMultipliers === "object"
    ? chanceOptions.specificMultipliers
    : {};
  const definitions = getMutationDefinitions(rawMutations)
    .filter((mutation) => mutation.enabled)
    .map((mutation) => ({
      ...mutation,
      chance: Math.max(0, Number(mutation.chance || 0))
        * globalMultiplier
        * Math.max(0, cleanNumber(specificMultipliers[mutation.id], 1))
    }));
  const totalChance = definitions.reduce((sum, mutation) => sum + mutation.chance, 0);
  if (totalChance <= 0) {
    return null;
  }

  let cursor = Math.max(0, Math.min(0.999999999, Number(randomValue) || 0)) * 100;
  for (const mutation of definitions) {
    cursor -= mutation.chance;
    if (cursor < 0) {
      return mutation;
    }
  }
  return null;
}

function resolveMutationCatch(fish, baseWeight, mutationId = NO_MUTATION_ID, rawMutations = null) {
  const mutation = getMutationDefinition(mutationId, rawMutations);
  const rawWeight = Math.max(0.01, cleanNumber(baseWeight, 0.01));
  const sizeMultiplier = mutation ? Math.max(0.01, cleanNumber(mutation.sizeMultiplier, 1)) : 1;
  const goldMultiplier = mutation ? Math.max(0, cleanNumber(mutation.goldMultiplier, 1)) : 1;
  const expMultiplier = mutation ? Math.max(0, cleanNumber(mutation.expMultiplier, 1)) : 1;

  return {
    mutationId: mutation?.id || NO_MUTATION_ID,
    mutation: mutation ? { ...mutation } : null,
    baseWeight: rawWeight,
    catchWeight: rawWeight * sizeMultiplier,
    baseGold: Math.max(0, Math.round(cleanNumber(fish?.gold, 0))),
    sellGold: Math.max(0, Math.round(cleanNumber(fish?.gold, 0) * goldMultiplier)),
    baseExp: Math.max(0, Math.round(cleanNumber(fish?.exp, 0))),
    goldMultiplier,
    expMultiplier,
    sizeMultiplier
  };
}

function normalizeMutationInventory(rawInventory) {
  const source = rawInventory && typeof rawInventory === "object" && !Array.isArray(rawInventory) ? rawInventory : {};
  const normalized = {};
  for (const [fishId, mutations] of Object.entries(source)) {
    if (!mutations || typeof mutations !== "object" || Array.isArray(mutations)) continue;
    const entries = {};
    for (const [mutationId, quantity] of Object.entries(mutations)) {
      const normalizedId = normalizeMutationId(mutationId);
      const count = Math.max(0, Math.floor(cleanNumber(quantity, 0)));
      if (normalizedId && count > 0) entries[normalizedId] = count;
    }
    if (Object.keys(entries).length) normalized[String(fishId)] = entries;
  }
  return normalized;
}

function normalizeMutationDexEntries(rawMutations) {
  const source = rawMutations && typeof rawMutations === "object" && !Array.isArray(rawMutations) ? rawMutations : {};
  const mutations = {};
  for (const [mutationId, entry] of Object.entries(source)) {
    const normalizedId = normalizeMutationId(mutationId);
    if (!normalizedId) continue;
    const value = entry && typeof entry === "object" ? entry : { count: entry };
    const count = Math.max(0, Math.floor(cleanNumber(value.count, 0)));
    const heaviestWeight = Math.max(0, cleanNumber(value.heaviestWeight, 0));
    if (count > 0 || heaviestWeight > 0) {
      mutations[normalizedId] = { count, heaviestWeight };
    }
  }
  return mutations;
}

function normalizeFishDex(rawFishDex) {
  const source = rawFishDex && typeof rawFishDex === "object" && !Array.isArray(rawFishDex) ? rawFishDex : {};
  const normalized = {};
  for (const [fishId, entry] of Object.entries(source)) {
    const value = entry && typeof entry === "object" ? entry : { count: entry };
    const count = Math.max(0, Math.floor(cleanNumber(value.count, 0)));
    const heaviestWeight = Math.max(0, cleanNumber(value.heaviestWeight, 0));
    const mutations = normalizeMutationDexEntries(value.mutations);
    const lastMutationId = normalizeMutationId(value.lastMutationId);
    if (count > 0 || heaviestWeight > 0 || Object.keys(mutations).length) {
      normalized[String(fishId)] = {
        count,
        heaviestWeight,
        mutations,
        ...(lastMutationId ? { lastMutationId } : {})
      };
    }
  }
  return normalized;
}

function ensurePlayerMutationData(player) {
  player.mutationInventory = normalizeMutationInventory(player?.mutationInventory);
  player.fishDex = normalizeFishDex(player?.fishDex);
  return player;
}

function recordCatch(player, fish, catchWeight, mutationId = NO_MUTATION_ID) {
  ensurePlayerMutationData(player);
  const normalizedMutationId = normalizeMutationId(mutationId);
  const fishId = String(fish?.id || "").trim();
  if (!fishId) return;

  if (normalizedMutationId) {
    player.mutationInventory[fishId] = player.mutationInventory[fishId] || {};
    player.mutationInventory[fishId][normalizedMutationId] = Math.max(0, Math.floor(cleanNumber(player.mutationInventory[fishId][normalizedMutationId], 0))) + 1;
  } else {
    player.inventory = player.inventory && typeof player.inventory === "object" && !Array.isArray(player.inventory) ? player.inventory : {};
    player.inventory[fishId] = Math.max(0, Math.floor(cleanNumber(player.inventory[fishId], 0))) + 1;
  }

  const dexEntry = player.fishDex[fishId] || { count: 0, heaviestWeight: 0, mutations: {} };
  dexEntry.count = Math.max(0, Math.floor(cleanNumber(dexEntry.count, 0))) + 1;
  dexEntry.heaviestWeight = Math.max(0, cleanNumber(dexEntry.heaviestWeight, 0), cleanNumber(catchWeight, 0));
  dexEntry.mutations = normalizeMutationDexEntries(dexEntry.mutations);
  if (normalizedMutationId) {
    const mutationEntry = dexEntry.mutations[normalizedMutationId] || { count: 0, heaviestWeight: 0 };
    dexEntry.mutations[normalizedMutationId] = {
      count: Math.max(0, Math.floor(cleanNumber(mutationEntry.count, 0))) + 1,
      heaviestWeight: Math.max(0, cleanNumber(mutationEntry.heaviestWeight, 0), cleanNumber(catchWeight, 0))
    };
    dexEntry.lastMutationId = normalizedMutationId;
  }
  player.fishDex[fishId] = dexEntry;
}

function getMutationInventoryEntries(player, fishId, rawMutations = null) {
  const entries = [];
  const normalQuantity = Math.max(0, Math.floor(cleanNumber(player?.inventory?.[fishId], 0)));
  if (normalQuantity > 0) entries.push({ mutationId: NO_MUTATION_ID, quantity: normalQuantity, mutation: null });
  const mutations = normalizeMutationInventory(player?.mutationInventory)?.[fishId] || {};
  for (const [mutationId, quantity] of Object.entries(mutations)) {
    if (quantity > 0) entries.push({ mutationId, quantity, mutation: getMutationDefinition(mutationId, rawMutations) });
  }
  return entries;
}

function getMutationSummary(dexEntry, rawMutations = null) {
  return Object.entries(normalizeMutationDexEntries(dexEntry?.mutations)).map(([mutationId, entry]) => ({
    mutationId,
    mutation: getMutationDefinition(mutationId, rawMutations),
    ...entry
  }));
}

module.exports = {
  NO_MUTATION_ID,
  defaultMutationDefinitions: getMutationDefinitions(),
  mutationVisualPresets,
  mutationMotionPresets,
  normalizeMutationSettings,
  getMutationChoices,
  getMutationDefinition,
  getMutationDefinitions,
  getMutationInventoryEntries,
  getMutationSummary,
  normalizeFishDex,
  normalizeMutationId,
  normalizeMutationInventory,
  ensurePlayerMutationData,
  recordCatch,
  resolveMutationCatch,
  rollMutation
};
