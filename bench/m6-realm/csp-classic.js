// A CLASSIC script, for `importScripts` only. A module worker has no `importScripts` at all, so
// the row this file exists for is expected to refuse before it reaches the network — and the
// probe reports which of the two refused it.
self.__m6_classic = "classic script ran";
