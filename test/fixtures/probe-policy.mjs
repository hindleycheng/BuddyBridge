export * from '../../src/probe-policy.js';
import { runProbeQueue as run } from '../../src/probe-policy.js';
import { setTimeout } from 'node:timers/promises';
// Integration tests keep the production queue but shorten its already unit-tested delay.
export const runProbeQueue = (models, options) => run(models, { ...options, sleep: (_, value, opts) => setTimeout(20, value, opts) });
