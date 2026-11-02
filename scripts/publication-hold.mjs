const message =
  "COMMERCIALIZATION_PUBLICATION_HOLD: publishing is disabled during the commercialization transition; local build and packaging remain available.";

console.error(message);
process.exitCode = 78;
