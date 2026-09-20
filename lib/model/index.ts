/**
 * Public surface of the Premier League prediction model. Every module is pure
 * TypeScript — no I/O, no runtime clock, no randomness — so predictions are
 * fully reproducible from a config + the history snapshot.
 */

export * from "./types"
export * from "./config"
export * from "./dates"
export * from "./elo"
export * from "./poisson"
export * from "./team-strength"
export * from "./predictor"
export * from "./reasons"
export * from "./metrics"
export * from "./backtest"
