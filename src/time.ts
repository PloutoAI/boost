/**
 * Time constants shared across the codebase. One source of truth so a
 * mistyped magnitude (24*60*60*100) can't slip through unit-style
 * arithmetic at 10 different call sites.
 */

export const HOUR_MS = 60 * 60 * 1000;
export const DAY_MS = 24 * HOUR_MS;
