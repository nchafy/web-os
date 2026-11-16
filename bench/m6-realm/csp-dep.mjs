// A static import for the probe worker, so a policy that refuses `'self'` is distinguishable
// from one that only refuses the loader's other schemes: if this module does not load, the
// worker never starts and the probe reports a startup failure rather than a row.
export const DEP = "csp-dep loaded";
