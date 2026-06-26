// loop.mjs — Convergence harness for the design-conformance gate.
//
// Drives an edit → re-check → accept-or-rollback loop with the three guards the
// research found necessary so an AGENT converges instead of thrashing:
//   1. the external deterministic diff is the ONLY oracle — the agent never judges
//      its own success (ungrounded self-critique stalls: "mirror loop").
//   2. accept an edit ONLY if total severity STRICTLY decreases (ReLook "Forced
//      Optimization") — otherwise roll back to best-so-far.
//   3. bound the retries — terminate at maxRounds with the best result preserved
//      (prevents "behavioral collapse" where revisions trend worse).
//
// In production `fix` is the coding agent (handed the property-level findings);
// `check` re-measures the live DOM and re-compares to the design spec. In the
// self-test they're pure in-memory functions, which is how convergence + anti-thrash
// are proven without a browser.

/**
 * @param {object} o
 * @param {() => ({findings:Array, severity:number, count:number})} o.check  re-measure + compare (the oracle)
 * @param {(findings:Array) => void|Promise<void>} o.fix                     apply an edit (the agent)
 * @param {() => any} o.snapshot                                            capture current state
 * @param {(s:any) => void} o.applyState                                    restore a snapshot
 */
export async function runConformanceLoop({ check, fix, snapshot, applyState, maxRounds = 10, onRound = () => {} }) {
  let best = await check();
  let bestState = snapshot();
  const history = [];
  let round = 0, accepted = 0, rejected = 0;

  while (best.severity > 1e-9 && round < maxRounds) {
    round++;
    await fix(best.findings);                 // agent edits, guided by the diff
    const res = await check();                 // external oracle re-measures
    const improved = res.severity < best.severity - 1e-9;  // STRICT decrease only
    const entry = { round, severity: r3(res.severity), count: res.count, accepted: improved };
    history.push(entry);
    onRound(entry);
    if (improved) { best = res; bestState = snapshot(); accepted++; }
    else { applyState(bestState); rejected++; }   // roll back — never let it degrade
  }

  return {
    converged: best.severity <= 1e-9,
    rounds: round, accepted, rejected,
    severity: r3(best.severity), count: best.count, findings: best.findings,
    history,
  };
}

const r3 = (n) => Math.round(n * 1000) / 1000;
