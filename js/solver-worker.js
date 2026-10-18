// Runs the optimizer off the main thread so the page stays responsive.
import { solve } from './solver.js';

self.onmessage = (e) => {
  const { id, problem, options } = e.data;
  try {
    self.postMessage({ id, result: solve(problem, options) });
  } catch (err) {
    self.postMessage({ id, error: String(err && err.message ? err.message : err) });
  }
};
