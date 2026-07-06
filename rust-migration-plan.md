# Rust Migration Plan — zalo-tg

## Strategy: Incremental, not wholesale

Rewrite in 3 phases. Each phase produces shippable, tested code that works alongside the existing TypeScript. No big-bang cutover.

---

## Phase 1 — Low Risk, High Reward (1-2 weeks)

### 1.1 Go TUI → Rust TUI

**Files to replace:**
```
cmd/zalo-tg-tui/  (8 files, ~1850 lines Go)
→ cmd/zalo-tg-tui-rs/  (Rust rewrite)
```

**Stack:** `ratatui` + `crossterm` + `tokio` (event loop from stdin/fd 3) + `serde_json` (parse envelopes)

**Protocol:** Identical — newline-delimited JSON envelopes on fd 3. Parent process (`terminal.ts`) detects binary name (`ZALO_TG_TUI_BIN`) and spawns it. Zero changes to Node.js.

**Implementation sketch:**
```
cmd/zalo-tg-tui-rs/
├── Cargo.toml
├── src/
│   ├── main.rs          # Entry, tokio runtime, fd 3 reader
│   ├── types.rs         # Envelope, Model, ActivityEvent structs (serde)
│   ├── ui.rs            # ratatui layout: top bar, status, panel, footer
│   ├── palette.rs       # Nebula color theme
│   ├── widgets/
│   │   ├── event_card.rs
│   │   ├── signal_rail.rs
│   │   ├── sparkline.rs
│   │   └── toast.rs
│   ├── animation.rs     # Gradient interpolation, breathing
│   └── clipboard.rs     # OSC52 + system clipboard
```

**Key crates:**
- `ratatui` — TUI framework (bubbletea equivalent)
- `crossterm` — terminal control
- `tokio` — async runtime
- `serde` / `serde_json` — envelope parsing
- `clap` — CLI args (mouse flag, etc.)

**Risks:** Low. UI-only, no data logic, small codebase. ratatui has active maintenance and docs.

**Success criteria:**
- [ ] Builds with `cargo build`
- [ ] Startup animation (gradient logo + breathing dots)
- [ ] Top bar with status indicators
- [ ] Activity event cards with color-coded tones
- [ ] Signal rail animation
- [ ] Toast notification on copy
- [ ] Mouse support (drag-select)
- [ ] Clipboard (OSC52)
- [ ] Same binary size or smaller
- [ ] Startup time < 50ms

---

### 1.2 Rust napi-rs Store Persistence Addon

**Files to replace:**
```
src/store.ts  lines 37-51 (load), 188-224 (_loadMsgMap), 
              226-273 (_scheduleMsgPersist), 287-301 (_evictOne),
              434-464 (_loadUserCache), 1167-1183 (_loadPolls)
→ crates/zalo-store/  (Rust native addon)
```

**Stack:** `napi-rs` (Rust ↔ Node.js bridge) + `serde_json` + `flate2` (gzip) + `tokio` (async fs)

**Implementation sketch:**
```
crates/zalo-store/
├── Cargo.toml
├── src/
│   ├── lib.rs           # napi-rs exports
│   ├── persistence.rs   # Atomic write, gzip, JSON serde
│   ├── msg_map.rs       # v2 compact format (string interning)
│   └── cache.rs         # LRU eviction for msg map
```

**API exposed to TypeScript:**
```typescript
// Same interface — drop-in replacement
export async function loadTopics(): Promise<TopicMap>
export async function saveTopics(data: TopicMap): Promise<void>
export async function loadMsgMap(): Promise<MsgMapData>
export async function saveMsgMap(data: MsgMapData): Promise<void>
export async function loadUserCache(): Promise<UserCache>
export async function saveUserCache(data: UserCache): Promise<void>
// ... etc
```

**Key crates:**
- `napi` / `napi-derive` — Rust-to-Node.js bindings
- `serde` / `serde_json` — JSON serialization
- `flate2` — gzip compression (streaming, no intermediate buffer)
- `tokio` — async file I/O
- `fs2` — file locking (prevent concurrent write corruption)

**Risks:**
- **Low.** The persistence layer is self-contained (no Zalo/TG dependencies).
- `napi-rs` requires matching Node.js ABI, but CI can build for target Node version.
- napi-rs adds ~5MB to binary size (but replaces several npm deps).

**Success criteria:**
- [ ] All store unit tests pass with Rust backend
- [ ] File format identical (existing data migrates automatically)
- [ ] Atomic writes: crash mid-write never corrupts file
- [ ] Concurrent read/write safe (file locking)
- [ ] 2x faster serialization + gzip (measured)
- [ ] No silent error swallowing (all failures propagate as rejected promises)

---

## Phase 2 — Medium Risk, 2-4 weeks

### 2.1 Rust Native Media Processing

**Files to replace:**
```
src/utils/media.ts  lines 36-109 (downloadToTemp),
                    194-226 (convertSpriteSheetToGif),
                    240-253 (convertToM4a) — KEEP ffmpeg for audio,
                    268-286 (convertWebmToGif),
                    309-351 (convertTgsToGif),
                    353-373 (convertStickerToPng)
→ crates/zalo-media/  (Rust native addon, or standalone binary)
```

Two approaches:
- **A) napi-rs addon** — TypeScript calls Rust functions directly. Best for integration.
- **B) Standalone binary** — Node spawns a Rust media-worker subprocess. Simpler, allows parallel processing.

**Recommendation:** (A) via napi-rs for low-latency calls. (B) only if process isolation is needed.

**Key crates (approach A, napi-rs):**
- `image` crate — WebP→PNG, sprite sheet→GIF
- `gif` crate — GIF encoding
- `reqwest` — HTTP download (replace axios for media)
- `lottie` / `lottie-converter` — Lottie animation rendering (TGS→GIF)
- `tokio` — async task spawning
- `tempfile` — temp file management

**Critical bottleneck fixed:**
- TGS rendering currently blocks Node event loop for 1-20s
- In Rust: render on `spawn_blocking` or dedicated thread pool
- TypeScript receives a Promise that resolves when done — non-blocking

**Risks:**
- **Medium.** `lottie` crate ecosystem in Rust is less mature than ffmpeg.
- May need to keep ffmpeg for audio (M4A conversion) — audio codecs are complex.
- sprite-sheet→GIF logic must be carefully reproduced.

**Success criteria:**
- [ ] TGS→GIF: 2x faster than current (ffmpeg + canvas pipeline)
- [ ] TGS rendering does not block event loop (>0ms blocking)
- [ ] Sticker→PNG: no dependency on `@napi-rs/canvas` (Rust native)
- [ ] All media tests pass
- [ ] Edge cases: corrupted files, empty files, unsupported formats all return proper errors

---

## Phase 3 — Optional, 1-2 months

### 3.1 Rust Store Sidecar

**Replace:**
```
src/store.ts  (entire 1247 lines)
→ crates/zalo-store-daemon/  (standalone Rust binary)
```

**Architecture:**
```
┌──────────────┐     Unix socket (JSON)     ┌──────────────────────┐
│  Node.js     │◄──────────────────────────►│  Rust Store Sidecar   │
│  (bridge)    │   request/response          │  (rusqlite + tokio)   │
└──────────────┘                             └──────────────────────┘
```

**Protocol:** JSON-RPC over Unix domain socket. Node sends `{ method: "loadTopics", params: [], id: 1 }`, sidecar responds `{ result: {...}, id: 1 }`.

**Key crates:**
- `rusqlite` — SQLite with WAL mode for concurrent reads
- `tokio` + `tokio-uds` — async Unix socket
- `serde_json` — RPC messages
- `zeroize` — credential zeroing on drop

**Why SQLite instead of JSON files:**
- ACID transactions — no partial writes even on crash
- Concurrent read/write — WAL mode allows reads during writes
- Queryable — can inspect state with `sqlite3` CLI
- Single file — easier backup than 5+ JSON files
- Memory mapping — faster reads for large caches

**Migration:** Existing JSON files imported into SQLite on first run.

**Risks:**
- **Medium.** New process to manage (restart, health check, socket path).
- Startup latency: sidecar must start before bridge.
- Socket communication adds ~0.1ms per call (negligible).

**Success criteria:**
- [ ] All store operations faster than JSON-file baseline
- [ ] Zero data loss on crash (tested with SIGKILL during writes)
- [ ] 5+ concurrent readers (WAL mode)
- [ ] Graceful sidecar restart without bridge restart
- [ ] New deployments auto-import from existing JSON files

### 3.2 Rust Credential Manager

**Files to replace:**
```
src/utils/privateFile.ts  (22 lines)
src/zalo/appApi.ts  lines 50-55 (loadAppSession)
→ crates/zalo-credentials/  (handled by store sidecar or separate)
```

**Features:**
- Encrypted-at-rest credential storage (AES-256-GCM, key derived from machine ID)
- `Zeroizing<T>` on all credential buffers
- File permissions `0o600` (POSIX) + Windows ACL
- Atomic write + rollback on failure

**Key crates:**
- `zeroize` — memory-zeroing on drop
- `aes-gcm` — AEAD encryption
- `ring` — key derivation (PBKDF2 or Argon2 from machine secret)
- `serde` — serialization

---

## Non-Goals (Keep in TypeScript)

| Module | Lines | Reason to keep |
|--------|-------|----------------|
| `zca-js` integration | ~500 in handler.ts | Reverse-engineered, changes frequently; rewrite would chase moving target |
| `telegram/handler.ts` | 3347 | Well-structured, I/O-bound, benefits limited from Rust |
| `zalo/handler.ts` message routing | 1500 | Deeply coupled to zca-js event model |
| `src/index.ts` lifecycle | 239 | Orchestration logic, not performance-critical |

---

## Build & CI Changes

### New Cargo workspace
```
zalo-tg/
├── Cargo.toml              # Workspace root
├── crates/
│   └── zalo-tui/           # Phase 1.1 — Rust TUI
│   └── zalo-store/         # Phase 1.2 — napi-rs store addon
│   └── zalo-media/         # Phase 2 — napi-rs media addon
│   └── zalo-store-daemon/  # Phase 3 — store sidecar
│   └── zalo-credentials/   # Phase 3 — credential manager
```

### package.json additions
```json
{
  "scripts": {
    "tui:build": "npm run tui:build:go  ||  npm run tui:build:rs",
    "tui:build:rs": "cargo build --package zalo-tui --release"
  },
  "napi": {
    "name": "zalo-store",
    "triples": {}
  }
}
```

### CI pipeline additions
```
- `cargo build --workspace`
- `cargo test --workspace`
- `cargo clippy --workspace`
- napi-rs: `napi build --release` (for store addon)
```

---

## Testing Strategy

- **Unit tests**: `cargo test` for all Rust crates
- **Integration tests**: Current `npm run test` must still pass after each phase
- **Fuzz testing**: `cargo fuzz` for JSON parsing paths (Phase 1.2)
- **Crash safety**: `SIGKILL` testing for store persistence (Phase 3)
- **Regression**: Run bridge in test mode with recorded Zalo/TG message traces

---

## Summary

| Phase | What | Risk | Time | Benefit |
|-------|------|------|------|---------|
| 1.1 | Go TUI → Rust TUI | Low | 1-2w | Remove Go dep, faster startup |
| 1.2 | napi-rs store addon | Low | 1w | ACID writes, no silent data loss |
| 2.1 | Rust media processing | Medium | 2-3w | Non-blocking TGS, faster conversions |
| 3.1 | Rust store sidecar | Medium | 2-4w | SQLite ACID, queryable, crash-safe |
| 3.2 | Rust credential mgr | Low | 1w | Encrypted at rest, zeroed in memory |

**Always shippable after each phase.** No big-bang cutover.
