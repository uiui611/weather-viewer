import { deflateSync } from "node:zlib";

const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, value) => {
  let crc = value;
  for (let bit = 0; bit < 8; bit++) crc = (crc & 1) ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  return crc >>> 0;
});

function chunk(type: string, data: Uint8Array): Buffer {
  const result = Buffer.alloc(data.length + 12);
  result.writeUInt32BE(data.length, 0);
  result.write(type, 4, 4, "ascii");
  result.set(data, 8);
  let crc = 0xffffffff;
  for (const byte of result.subarray(4, -4)) crc = CRC_TABLE[(crc ^ byte) & 255]! ^ (crc >>> 8);
  result.writeUInt32BE((crc ^ 0xffffffff) >>> 0, result.length - 4);
  return result;
}

// Opaque, non-interlaced 8-bit grayscale PNG. No gamma/ICC/EXIF metadata.
export function encodeGrayscalePng(width: number, height: number, pixels: Uint8Array): Buffer {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 ||
      pixels.length !== width * height) throw new Error("Invalid PNG dimensions");
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 0; // grayscale, no alpha
  const rows = Buffer.alloc((width + 1) * height);
  for (let y = 0; y < height; y++) {
    const rowStart = y * (width + 1);
    rows[rowStart] = 1; // Sub filter preserves horizontal spatial coherence.
    for (let x = 0; x < width; x++) {
      const index = y * width + x;
      rows[rowStart + x + 1] = (pixels[index]! - (x ? pixels[index - 1]! : 0)) & 255;
    }
  }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header), chunk("IDAT", deflateSync(rows)), chunk("IEND", new Uint8Array()),
  ]);
}
