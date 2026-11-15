def fnv1a(s: bytes, seed=0x811c9dc5):
    h = seed
    for b in s:
        h ^= b
        h = (h * 0x01000193) & 0xFFFFFFFF
    return h


for text, claimed in ((b"", 0x811c9dc5), (b"a", 0xe40c292c), (b"foobar", 0xbf9cf968)):
    got = fnv1a(text)
    print(f"{text!r}: independent {got:#010x} vs abi.mjs selfTest's claim {claimed:#010x} "
          f"-> {'match' if got == claimed else 'MISMATCH'}")
