const { AttachmentBuilder } = require("discord.js");

function parseDataImage(dataUrl) {
  if (!dataUrl || typeof dataUrl !== "string") {
    return null;
  }

  const match = dataUrl.match(/^data:(image\/(?:png|jpe?g|gif|webp));base64,([A-Za-z0-9+/=]+)$/);
  if (!match) {
    return null;
  }

  const extension = match[1].split("/")[1].replace("jpeg", "jpg");
  return {
    buffer: Buffer.from(match[2], "base64"),
    extension
  };
}

function makeIconAttachment(item, namePrefix) {
  if (item.iconUrl) {
    return {
      attachment: null,
      url: item.iconUrl
    };
  }

  const image = parseDataImage(item.iconBase64);
  if (!image) {
    return null;
  }

  const fileName = `${namePrefix}-${item.id}.${image.extension}`;
  return {
    attachment: new AttachmentBuilder(image.buffer, { name: fileName }),
    url: `attachment://${fileName}`
  };
}

module.exports = {
  parseDataImage,
  makeIconAttachment
};
