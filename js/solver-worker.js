// Runs the optimizer off the main thread so the page stays responsive.
// solver.js is loaded with this file's version tag (see tools/stamp.mjs), never an old copy.
const solver = import('./solver.js' + self.location.search);

self.onmessage = async (e) => {
  const { id, problem, options } = e.data;
  try {
    const { solve } = await solver;
    self.postMessage({ id, result: solve(problem, options) });
  } catch (err) {
    self.postMessage({ id, error: String(err && err.message ? err.message : err) });
  }
};
