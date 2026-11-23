import type { TestProject } from 'vitest/node';
import './time-budget.js';

// Global setup for the unit config: tells budget() whether this run collects coverage, read from the
// resolved config so `--coverage.enabled=false` keeps the plain budgets.
export default function setup(project: TestProject): void {
  project.provide('v8Coverage', project.globalConfig.coverage.enabled);
}
