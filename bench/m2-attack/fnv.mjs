function fnv1aStr(s, seed = 0x811c9dc5) {
  let h = seed;
  for (let i = 0; i < s.length; i += 1) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h >>> 0;
}
for (const s of ["", "a", "foobar"]) console.log(JSON.stringify(s), "0x" + fnv1aStr(s).toString(16));
