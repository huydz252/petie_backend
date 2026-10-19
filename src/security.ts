import { randomInt } from "node:crypto";
export function distanceKm(a: number, b: number, c: number, d: number): number {
  const r = Math.PI / 180;
  const h =
    Math.sin(((c - a) * r) / 2) ** 2 +
    Math.cos(a * r) * Math.cos(c * r) * Math.sin(((d - b) * r) / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}
export function fuzz(
  lat: number,
  lng: number,
  seed?: Buffer,
): { latitude: number; longitude: number } {
  const radius =
      (seed ? 200 + (seed.readUInt32BE(0) % 301) : randomInt(200, 501)) /
      6371000,
    bearing =
      (((seed ? seed.readUInt32BE(4) % 360000 : randomInt(0, 360000)) / 1000) *
        Math.PI) /
      180,
    a = (lat * Math.PI) / 180,
    b = (lng * Math.PI) / 180;
  const x = Math.asin(
    Math.sin(a) * Math.cos(radius) +
      Math.cos(a) * Math.sin(radius) * Math.cos(bearing),
  );
  const y =
    b +
    Math.atan2(
      Math.sin(bearing) * Math.sin(radius) * Math.cos(a),
      Math.cos(radius) - Math.sin(a) * Math.sin(x),
    );
  return {
    latitude: (x * 180) / Math.PI,
    longitude: (((y * 180) / Math.PI + 540) % 360) - 180,
  };
}
