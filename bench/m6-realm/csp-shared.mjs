// A SharedWorker body, for the row that asks whether a process realm can construct one.
// Constraint 53: a worker a process makes for itself is invisible to the process table while
// still holding a renderer-wide worker slot, so the kernel's cap is enforced over a number that
// is not the real one.
self.onconnect = (e) => {
  e.ports[0].postMessage("shared worker alive");
};
