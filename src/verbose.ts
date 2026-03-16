/**
 * Global verbose mode flag — set early by checking argv directly so it is
 * available before Commander parses options (important for api.ts imports).
 */
export const verbose = process.argv.includes("--verbose");
