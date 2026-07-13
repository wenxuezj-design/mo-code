import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  inspectImage,
  verifyLocalAsset,
} from "../docs/story/tools/lettering/lib/image-metadata.mjs";

function pngFixture(width, height) {
  const buffer = Buffer.alloc(33);
  Buffer.from("89504e470d0a1a0a", "hex").copy(buffer, 0);
  buffer.writeUInt32BE(13, 8);
  buffer.write("IHDR", 12, "ascii");
  buffer.writeUInt32BE(width, 16);
  buffer.writeUInt32BE(height, 20);
  buffer[24] = 8;
  buffer[25] = 6;
  return buffer;
}

function webpFixture(kind, width, height) {
  let payload;
  if (kind === "VP8 ") {
    payload = Buffer.alloc(10);
    Buffer.from([0x10, 0x00, 0x00, 0x9d, 0x01, 0x2a]).copy(payload);
    payload.writeUInt16LE(width, 6);
    payload.writeUInt16LE(height, 8);
  } else if (kind === "VP8L") {
    payload = Buffer.alloc(5);
    payload[0] = 0x2f;
    payload.writeUInt32LE((width - 1) | ((height - 1) << 14), 1);
  } else {
    payload = Buffer.alloc(10);
    payload.writeUIntLE(width - 1, 4, 3);
    payload.writeUIntLE(height - 1, 7, 3);
  }

  const paddedLength = payload.length + (payload.length % 2);
  const buffer = Buffer.alloc(20 + paddedLength);
  buffer.write("RIFF", 0, "ascii");
  buffer.writeUInt32LE(buffer.length - 8, 4);
  buffer.write("WEBP", 8, "ascii");
  buffer.write(kind, 12, "ascii");
  buffer.writeUInt32LE(payload.length, 16);
  payload.copy(buffer, 20);
  return buffer;
}

function webpChunk(kind, payload) {
  const buffer = Buffer.alloc(8 + payload.length + (payload.length % 2));
  buffer.write(kind, 0, "ascii");
  buffer.writeUInt32LE(payload.length, 4);
  payload.copy(buffer, 8);
  return buffer;
}

function appendInsideRiff(webp, bytes) {
  const buffer = Buffer.concat([webp, bytes]);
  buffer.writeUInt32LE(buffer.length - 8, 4);
  return buffer;
}

async function withTempFile(contents, callback, fileName = "fixture.bin") {
  const directory = await mkdtemp(path.join(os.tmpdir(), "story-image-"));
  const filePath = path.join(directory, fileName);
  try {
    await writeFile(filePath, contents);
    return await callback(filePath);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("inspectImage reads PNG, VP8, VP8L, and VP8X dimensions", async (t) => {
  const fixtures = [
    ["PNG", pngFixture(864, 1821), 864, 1821],
    ["VP8", webpFixture("VP8 ", 640, 480), 640, 480],
    ["VP8L", webpFixture("VP8L", 321, 123), 321, 123],
    ["VP8X", webpFixture("VP8X", 1920, 1080), 1920, 1080],
  ];

  for (const [name, fixture, width, height] of fixtures) {
    await t.test(name, async () => {
      await withTempFile(fixture, async (filePath) => {
        const metadata = await inspectImage(filePath);
        assert.deepEqual(metadata, {
          sha256: createHash("sha256").update(fixture).digest("hex"),
          bytes: fixture.length,
          width,
          height,
        });
      });
    });
  }
});

test("inspectImage rejects unsupported image formats", async () => {
  await withTempFile(Buffer.from("GIF89a", "ascii"), async (filePath) => {
    await assert.rejects(() => inspectImage(filePath), /Unsupported image format/);
  });
});

test("inspectImage rejects PNG and WebP content with the opposite supported extension", async (t) => {
  for (const [name, fixture, fileName] of [
    ["WebP named PNG", webpFixture("VP8X", 24, 36), "page.png"],
    ["PNG named WebP", pngFixture(24, 36), "page.webp"],
  ]) {
    await t.test(name, async () => {
      await withTempFile(fixture, async (filePath) => {
        await assert.rejects(() => inspectImage(filePath), /format mismatch/i);
      }, fileName);
    });
  }
});

test("inspectImage rejects invalid PNG IHDR length and boundaries", async (t) => {
  const invalidLength = Buffer.from(pngFixture(24, 36));
  invalidLength.writeUInt32BE(12, 8);
  const truncatedChunk = pngFixture(24, 36).subarray(0, 32);

  for (const [name, fixture] of [
    ["invalid length", invalidLength],
    ["truncated chunk", truncatedChunk],
  ]) {
    await t.test(name, async () => {
      await withTempFile(fixture, async (filePath) => {
        await assert.rejects(() => inspectImage(filePath), /Malformed PNG/);
      });
    });
  }
});

test("inspectImage requires the RIFF declaration to match the entire WebP file", async (t) => {
  const valid = webpFixture("VP8X", 320, 240);
  const chunkOutsideRiff = Buffer.concat([
    valid,
    webpChunk("JUNK", Buffer.from([1, 2])),
  ]);
  const declarationBeyondFile = Buffer.from(valid);
  declarationBeyondFile.writeUInt32LE(valid.length - 8 + 2, 4);

  for (const [name, fixture] of [
    ["chunk outside RIFF", chunkOutsideRiff],
    ["declaration beyond file", declarationBeyondFile],
  ]) {
    await t.test(name, async () => {
      await withTempFile(fixture, async (filePath) => {
        await assert.rejects(() => inspectImage(filePath), /Malformed WebP|RIFF/i);
      });
    });
  }
});

test("inspectImage rejects a missing odd-chunk pad and trailing chunk overflow", async (t) => {
  const vp8lWithoutPad = webpFixture("VP8L", 24, 36).subarray(0, -1);
  vp8lWithoutPad.writeUInt32LE(vp8lWithoutPad.length - 8, 4);

  const truncatedTrailingChunk = Buffer.alloc(10);
  truncatedTrailingChunk.write("JUNK", 0, "ascii");
  truncatedTrailingChunk.writeUInt32LE(4, 4);
  const overflowAfterImage = appendInsideRiff(
    webpFixture("VP8X", 24, 36),
    truncatedTrailingChunk,
  );

  for (const [name, fixture] of [
    ["missing odd pad", vp8lWithoutPad],
    ["trailing chunk overflow", overflowAfterImage],
  ]) {
    await t.test(name, async () => {
      await withTempFile(fixture, async (filePath) => {
        await assert.rejects(() => inspectImage(filePath), /Malformed WebP|chunk|pad/i);
      });
    });
  }
});

test("inspectImage rejects zero VP8 dimensions", async () => {
  await withTempFile(webpFixture("VP8 ", 0, 36), async (filePath) => {
    await assert.rejects(() => inspectImage(filePath), /Malformed VP8|dimensions/i);
  });
});

test("verifyLocalAsset returns metadata when every field matches", async () => {
  const fixture = pngFixture(24, 36);
  await withTempFile(fixture, async (filePath) => {
    const expected = {
      sha256: createHash("sha256").update(fixture).digest("hex"),
      bytes: fixture.length,
      width: 24,
      height: 36,
    };

    assert.deepEqual(await verifyLocalAsset({ filePath, asset: expected }), expected);
  });
});

test("verifyLocalAsset reports each mismatched field with expected and actual values", async (t) => {
  const fixture = pngFixture(24, 36);
  await withTempFile(fixture, async (filePath) => {
    const actual = {
      sha256: createHash("sha256").update(fixture).digest("hex"),
      bytes: fixture.length,
      width: 24,
      height: 36,
    };
    const mismatches = {
      sha256: "b".repeat(64),
      bytes: actual.bytes + 1,
      width: actual.width + 1,
      height: actual.height + 1,
    };

    for (const [field, expected] of Object.entries(mismatches)) {
      await t.test(field, async () => {
        await assert.rejects(
          () => verifyLocalAsset({ filePath, asset: { ...actual, [field]: expected } }),
          new RegExp(`${field} mismatch: expected ${expected}, actual ${actual[field]}`),
        );
      });
    }
  });
});
