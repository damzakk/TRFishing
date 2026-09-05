const path = require("node:path");
const { Jimp, JimpMime, intToRGBA, loadFont, rgbaToInt } = require("jimp");

const templatePath = path.join(__dirname, "..", "assets", "fishshowoff-template.png");
const fontRoot = path.join(__dirname, "..", "node_modules", "@jimp", "plugin-print", "fonts", "open-sans");
const fontPaths = {
  title: path.join(fontRoot, "open-sans-32-white", "open-sans-32-white.fnt"),
  body: path.join(fontRoot, "open-sans-16-white", "open-sans-16-white.fnt"),
  small: path.join(fontRoot, "open-sans-14-black", "open-sans-14-black.fnt")
};

const avatarSlot = {
  centerX: 650,
  centerY: 320,
  size: 350,
  radius: 54,
  angle: 13
};

const fishSlot = {
  centerX: 1300,
  centerY: 245,
  size: 335,
  radius: 44,
  angle: -16
};

function clampByte(value) {
  return Math.max(0, Math.min(255, Math.round(Number(value || 0))));
}

function rgba(r, g, b, a = 255) {
  return rgbaToInt(clampByte(r), clampByte(g), clampByte(b), clampByte(a));
}

function makeImage(width, height, color) {
  return new Jimp({ width, height, color });
}

function coverSquare(image, size) {
  const source = image.clone();
  const scale = Math.max(size / source.bitmap.width, size / source.bitmap.height);
  source.resize({
    w: Math.ceil(source.bitmap.width * scale),
    h: Math.ceil(source.bitmap.height * scale)
  });
  const x = Math.max(0, Math.floor((source.bitmap.width - size) / 2));
  const y = Math.max(0, Math.floor((source.bitmap.height - size) / 2));
  return source.crop({ x, y, w: size, h: size });
}

function applyRoundedCorners(image, radius) {
  const { width, height, data } = image.bitmap;
  const safeRadius = Math.max(0, Math.min(radius, Math.floor(Math.min(width, height) / 2)));
  if (!safeRadius) {
    return image;
  }

  image.scan(0, 0, width, height, function scanPixel(x, y, idx) {
    const left = x < safeRadius;
    const right = x >= width - safeRadius;
    const top = y < safeRadius;
    const bottom = y >= height - safeRadius;
    if ((!left && !right) || (!top && !bottom)) {
      return;
    }

    const cornerX = left ? safeRadius : width - safeRadius - 1;
    const cornerY = top ? safeRadius : height - safeRadius - 1;
    const dx = x - cornerX;
    const dy = y - cornerY;
    if (Math.sqrt(dx * dx + dy * dy) > safeRadius) {
      data[idx + 3] = 0;
    }
  });
  return image;
}

function compositeCentered(base, overlay, centerX, centerY) {
  const x = Math.round(centerX - overlay.bitmap.width / 2);
  const y = Math.round(centerY - overlay.bitmap.height / 2);
  base.composite(overlay, x, y);
}

async function readImageFromUrl(url) {
  const selectedUrl = String(url || "").trim();
  if (!selectedUrl) {
    return null;
  }
  const response = await fetch(selectedUrl);
  if (!response.ok) {
    throw new Error(`Could not fetch image: ${response.status} ${response.statusText}`);
  }
  const arrayBuffer = await response.arrayBuffer();
  return Jimp.read(Buffer.from(arrayBuffer));
}

async function readImageFromItem(item) {
  if (item?.iconUrl) {
    return readImageFromUrl(item.iconUrl);
  }

  const base64 = String(item?.iconBase64 || "");
  const match = base64.match(/^data:image\/(?:png|jpe?g|gif|webp);base64,([A-Za-z0-9+/=]+)$/);
  if (!match) {
    return null;
  }
  return Jimp.read(Buffer.from(match[1], "base64"));
}

function makeFishFallbackTile(fish) {
  const tile = makeImage(fishSlot.size, fishSlot.size, rgba(245, 57, 166, 255));
  const inner = makeImage(fishSlot.size - 32, fishSlot.size - 32, rgba(255, 126, 207, 245));
  applyRoundedCorners(inner, 34);
  tile.composite(inner, 16, 16);

  const cx = Math.floor(fishSlot.size / 2);
  const cy = Math.floor(fishSlot.size / 2);
  const bodyColor = rgba(124, 225, 232, 255);
  const finColor = rgba(80, 176, 209, 255);
  tile.scan(0, 0, fishSlot.size, fishSlot.size, function drawFish(x, y, idx) {
    const body = ((x - cx) ** 2) / (78 ** 2) + ((y - cy) ** 2) / (47 ** 2) <= 1;
    const tail = x > cx + 62 && Math.abs(y - cy) < (x - (cx + 62)) * 0.75 + 10 && x < cx + 112;
    const fin = x > cx - 5 && x < cx + 45 && y > cy - 74 && y < cy - 36;
    if (body || tail || fin) {
      const color = fin || tail ? finColor : bodyColor;
      const value = intToRGBA(color);
      this.bitmap.data[idx] = value.r;
      this.bitmap.data[idx + 1] = value.g;
      this.bitmap.data[idx + 2] = value.b;
      this.bitmap.data[idx + 3] = value.a;
    }
  });
  return tile;
}

async function makeOverlayImage(source, slot, fallback = null) {
  const image = source ? coverSquare(source, slot.size) : fallback || makeImage(slot.size, slot.size, rgba(120, 211, 238, 255));
  applyRoundedCorners(image, slot.radius);
  image.rotate(slot.angle);
  return image;
}

function makeStatsPanel(width, height) {
  const panel = makeImage(width, height, rgba(8, 24, 39, 190));
  applyRoundedCorners(panel, 26);
  return panel;
}

async function drawStats(base, fonts, stats) {
  const panelX = 54;
  const panelY = 612;
  const panel = makeStatsPanel(690, 210);
  base.composite(panel, panelX, panelY);

  base.print({ font: fonts.title, x: panelX + 28, y: panelY + 22, text: stats.displayName });
  base.print({ font: fonts.body, x: panelX + 30, y: panelY + 75, text: `Level ${stats.level}  |  EXP ${stats.exp}/${stats.nextExp}  |  Gold ${stats.gold}` });
  base.print({ font: fonts.body, x: panelX + 30, y: panelY + 108, text: `Total ikan: ${stats.totalFishCaught}  |  Jenis: ${stats.caughtFishTypes}/${stats.availableFishCount}` });
  base.print({ font: fonts.body, x: panelX + 30, y: panelY + 141, text: `Ikan dipamerkan : ${stats.fishName || "Belum ada"}${stats.fishRarity ? ` (${stats.fishRarity})` : ""}` });
  base.print({ font: fonts.body, x: panelX + 30, y: panelY + 174, text: `Max weight: ${stats.fishMaxWeight || "-"}  |  Luck Score: ${stats.fishLuckScore || "-"}` });
}

async function makeFishShowoffBanner({ avatarUrl, fish, stats }) {
  const [base, fonts, avatar, fishImage] = await Promise.all([
    Jimp.read(templatePath),
    Promise.all([
      loadFont(fontPaths.title),
      loadFont(fontPaths.body),
      loadFont(fontPaths.small)
    ]).then(([title, body, small]) => ({ title, body, small })),
    readImageFromUrl(avatarUrl).catch(() => null),
    readImageFromItem(fish).catch(() => null)
  ]);

  const avatarOverlay = await makeOverlayImage(avatar, avatarSlot);
  const fishOverlay = await makeOverlayImage(fishImage, fishSlot, makeFishFallbackTile(fish));
  compositeCentered(base, avatarOverlay, avatarSlot.centerX, avatarSlot.centerY);
  compositeCentered(base, fishOverlay, fishSlot.centerX, fishSlot.centerY);
  await drawStats(base, fonts, stats);
  return base.getBuffer(JimpMime.png);
}

module.exports = {
  makeFishShowoffBanner
};
