import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

const PNG_SIGNATURE = Buffer.from("89504e470d0a1a0a", "hex");

function parsePngDimensions(buffer) {
  if (
    buffer.length < 33 ||
    !buffer.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE) ||
    buffer.readUInt32BE(8) !== 13 ||
    buffer.toString("ascii", 12, 16) !== "IHDR"
  ) {
    throw new Error("Malformed PNG image");
  }
  const width = buffer.readUInt32BE(16);
  const height = buffer.readUInt32BE(20);
  if (width === 0 || height === 0) throw new Error("Malformed PNG dimensions");
  return { width, height };
}

function parseVp8Dimensions(payload) {
  if (
    payload.length < 10 ||
    payload[3] !== 0x9d ||
    payload[4] !== 0x01 ||
    payload[5] !== 0x2a
  ) {
    throw new Error("Malformed VP8 image");
  }
  const width = payload.readUInt16LE(6) & 0x3fff;
  const height = payload.readUInt16LE(8) & 0x3fff;
  if (width === 0 || height === 0) throw new Error("Malformed VP8 dimensions");
  return { width, height };
}

function parseVp8lDimensions(payload) {
  if (payload.length < 5 || payload[0] !== 0x2f) {
    throw new Error("Malformed VP8L image");
  }
  const bits = payload.readUInt32LE(1);
  return {
    width: (bits & 0x3fff) + 1,
    height: ((bits >>> 14) & 0x3fff) + 1,
  };
}

function parseVp8xDimensions(payload) {
  if (payload.length < 10) throw new Error("Malformed VP8X image");
  return {
    width: payload.readUIntLE(4, 3) + 1,
    height: payload.readUIntLE(7, 3) + 1,
  };
}

function parseWebpDimensions(buffer) {
  if (
    buffer.length < 12 ||
    buffer.toString("ascii", 0, 4) !== "RIFF" ||
    buffer.toString("ascii", 8, 12) !== "WEBP"
  ) {
    throw new Error("Malformed WebP image");
  }
  const declaredLength = buffer.readUInt32LE(4);
  if (declaredLength !== buffer.length - 8) {
    throw new Error(
      `Malformed WebP RIFF length: declared ${declaredLength}, actual ${buffer.length - 8}`,
    );
  }

  const containerEnd = declaredLength + 8;
  let offset = 12;
  let dimensions;
  while (offset < containerEnd) {
    if (offset + 8 > containerEnd) throw new Error("Malformed WebP chunk header");
    const kind = buffer.toString("ascii", offset, offset + 4);
    const length = buffer.readUInt32LE(offset + 4);
    const payloadStart = offset + 8;
    const payloadEnd = payloadStart + length;
    if (payloadEnd > containerEnd) throw new Error(`Malformed ${kind.trim()} WebP chunk`);
    const paddedEnd = payloadEnd + (length % 2);
    if (paddedEnd > containerEnd) {
      throw new Error(`Malformed ${kind.trim()} WebP chunk padding`);
    }
    const payload = buffer.subarray(payloadStart, payloadEnd);

    let chunkDimensions;
    if (kind === "VP8 ") chunkDimensions = parseVp8Dimensions(payload);
    if (kind === "VP8L") chunkDimensions = parseVp8lDimensions(payload);
    if (kind === "VP8X") chunkDimensions = parseVp8xDimensions(payload);
    dimensions ??= chunkDimensions;

    offset = paddedEnd;
  }

  if (dimensions === undefined) {
    throw new Error("WebP image has no supported dimensions chunk");
  }
  return dimensions;
}

export async function inspectImage(filePath, { expectedFormat } = {}) {
  const buffer = await readFile(filePath);
  let dimensions;
  let format;
  if (buffer.length >= PNG_SIGNATURE.length && buffer.subarray(0, 8).equals(PNG_SIGNATURE)) {
    dimensions = parsePngDimensions(buffer);
    format = "png";
  } else if (
    buffer.length >= 12 &&
    buffer.toString("ascii", 0, 4) === "RIFF" &&
    buffer.toString("ascii", 8, 12) === "WEBP"
  ) {
    dimensions = parseWebpDimensions(buffer);
    format = "webp";
  } else {
    throw new Error("Unsupported image format: expected PNG or WebP");
  }

  const inferredFormat = path.extname(filePath).toLowerCase().slice(1);
  const declaredFormat = expectedFormat ?? inferredFormat;
  if (expectedFormat !== undefined && expectedFormat !== "png" && expectedFormat !== "webp") {
    throw new Error(`Unsupported expected image format: ${String(expectedFormat)}`);
  }
  if ((declaredFormat === "png" || declaredFormat === "webp") && declaredFormat !== format) {
    throw new Error(`Image format mismatch: .${declaredFormat} file contains ${format.toUpperCase()}`);
  }

  return {
    sha256: createHash("sha256").update(buffer).digest("hex"),
    bytes: buffer.length,
    ...dimensions,
  };
}

export async function verifyLocalAsset({ filePath, asset }) {
  const expectedFormat = typeof asset?.cacheFile === "string"
    ? path.extname(asset.cacheFile).toLowerCase().slice(1)
    : undefined;
  const metadata = await inspectImage(filePath, { expectedFormat });
  for (const field of ["sha256", "bytes", "width", "height"]) {
    if (asset?.[field] !== metadata[field]) {
      throw new Error(
        `${field} mismatch: expected ${String(asset?.[field])}, actual ${String(metadata[field])}`,
      );
    }
  }
  return metadata;
}
