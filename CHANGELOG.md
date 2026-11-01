# Changelog

## 0.1.1

- Added a Schemastery `Config` export and loader-visible defaults.
- Bounded session/state maps with `maxTrackedSessions` and session-instance-aware caches.
- Added fail-soft preparation, per-seq read containment, and same-id resume card injection regression tests.
- Clarified GitHub Release, DSH `plugin add`, npm download, and npmjs publishing paths.

## 0.1.0

- Added non-invasive `compaction/summary` observer, five-section parser, deterministic P0 anchor extraction, and append-only session index.
- Added `enforce` / `compat` / `observe` admission modes with quarantine diagnostics and salvage injection cards.
- Added `sumidx_search`, `sumidx_read`, and `sumidx_probe` name-spaced read-only tools.
- Added deterministic pointer/search/read/source-range/replacement probes and model-level recall question generation.
- Added P0-P3 retention mapping, bounded/redacted storage, per-session serialized JSONL writes, and path-safe storage layout.
- Added DSH naming declaration, bundle patch, architecture notes, and tests for parsing, admission, probes, storage, and plugin integration.
- Added v3/v4 producer-source selection, semantic expansion of escaped JSON tool arguments, and a strict tools-only mode via `inject: false`.
- Hardened missed-event recovery with an incremental compaction scan and in-memory fallback when the index store cannot be read.
