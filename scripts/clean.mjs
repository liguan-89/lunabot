import { rm } from "node:fs/promises";

const generatedPaths = [
  "dist",
  "dist-electron",
  "dist-native",
  "dist-server",
  "release",
  "electron/resources/speech-helper",
  "electron/resources/Luna Bot Speech.app",
  "electron/resources/DEX BOT Speech.app",
  "electron/resources/LunaBot Speech.app",
];

await Promise.all(
  generatedPaths.map((path) => rm(path, { recursive: true, force: true })),
);
