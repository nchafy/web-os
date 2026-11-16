// Served by the probe's SECOND server, on a second port, which is a second origin. Stands for
// the hostile host in constraint 139: a module a process names in a computed `import(expr)`,
// which the kernel's linker never sees and `fetch` has nothing to do with.
//
// The probe's hostile server sends `Access-Control-Allow-Origin: *`, because without it a
// cross-origin module fetch fails CORS and the row would read "refused" for a reason that has
// nothing to do with the policy under test. Constraint 139 records the same point: COEP does not
// stop this, since a module script is fetched in CORS mode.
export const V = "off-origin module evaluated";
