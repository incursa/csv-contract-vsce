/* eslint-disable @typescript-eslint/no-require-imports, no-undef -- SEA bridge is intentionally CommonJS. */
// Standalone-only bridge: SEA's injected require accepts built-ins only, so
// load the extracted native package with a filesystem-backed createRequire.
const { loadStandaloneNativeSqlDriver } = require("./standalone-native");

module.exports = loadStandaloneNativeSqlDriver();
