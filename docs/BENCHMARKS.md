# Benchmark baseline

One command runs the baseline harness:

```bash
bun run --filter=@devprism/desktop bench
```

From `apps/desktop`, the same entry is `bun run bench`. Rust-only:

```bash
TECTONIC_DEP_BACKEND=vcpkg VCPKG_ROOT=$HOME/vcpkg \
  PKG_CONFIG_PATH=/opt/homebrew/opt/icu4c@78/lib/pkgconfig:/opt/homebrew/opt/openssl@3/lib/pkgconfig \
  CXXFLAGS="-std=c++17 -I/opt/homebrew/opt/harfbuzz/include" \
  CFLAGS="-I/opt/homebrew/opt/harfbuzz/include" \
  cargo bench --manifest-path apps/desktop/src-tauri/Cargo.toml --bench baseline
```

`--bench baseline` is required. `cargo bench -- --smoke` forwards `--smoke` to the lib unittest harness, which rejects the flag and does not run the bench.

`bun run bench` sets those variables itself. The committed figures are `bench-results/baseline-2026-10.json`, written by a non-smoke run. The statistic is the **minimum** of the same-config reruns. Spread is max minus min of those reruns. The mean is not the reported figure. A full run uses **N = 7** after **one excluded warmup**. `first_call_ms` / `warmup` is that excluded pass (font discovery on the first Typst compile). It is not part of the spread.

`BENCH_SMOKE=1` or `--smoke` uses one iteration. That single sample is not a noise floor. Smoke prints JSON and does **not** overwrite `baseline-2026-10.json`.

A measurement that did not run is `status: "not_measured"` with a reason. It is not a zero.

## What each measurement is

1. **30-page compile, first-page raster, full re-raster.** The fixture is `apps/desktop/src-tauri/benches/fixtures/thirty-page.typ` (synthetic, generated in-tree). `career_typst::engine::compile_resume_pdf` returns the whole PDF; it does not stop at page 1. The compile wall time is that full compile. "First page" is a MuPDF raster of page 0 at 144 DPI (`renderScale` 1 × 72 × `MIN_RENDER_DPR` 2), using the same RGB-to-RGBA loop as `mupdf-worker.ts`. "Full re-raster" is all 30 pages with the document already open. The page count must be 30 and the bytes must start with `%PDF-` before a duration is kept.

2. **Retained canvas bytes.** After `putPageBitmap` of pages 0..29, `pageBitmapCacheBytesForTest()`. The cap is `MAX_PAGE_BITMAP_BYTES` (160 MiB). Eviction stops when one page would have to remain over the cap.

3. **50 KB streamed reply.** 50_000 bytes, chunks of 1024 (the Rust coalescer's `FLUSH_BYTES`), through `useClaudeChatStore._appendMessage` with `subtype: "streaming_delta"`. `aiAutoTitles` is off so the timed path does not call a model. The result is store notifications per reply and milliseconds per delta. The merged text must be 50_000 characters or the sample is rejected.

4. **`claude-output` events per second.** Not measured. This commit has no golden NDJSON fixture. A rate was not invented.

5. **Per-keystroke cost against document size.** Real CodeMirror `EditorState.update` transactions with `userEvent: "input.type"`, then `doc.toString()`, at 4096, 32768, 131072, and 524288 characters. Each sample starts from the same base state. The document must grow by one character. This replaces `scripts/bench-typing.ts`, which timed `createDebouncedContentPush(...).schedule` and described that as snapshot stringification. This number is **not** keystroke-to-preview latency. The environment is bun, without `EditorView` layout.

6. **Sidebar and editor render counts per keystroke.** React `Profiler` commits of the real `Sidebar` and `LatexEditor` after one `EditorView.dispatch`, in vitest's jsdom. The 150 ms debounced content push is not included. If those components do not mount, the JSON says not measured and includes the error.

7. **Cold Manvi turn.** The sequence is `manvi --version`, then `manvi run` with `--mcp devprism`, then the devprism process serving `--mcp`. `manvi --version` is recorded on its own only when that binary is an executable on `PATH`, and it is labeled `counts_as_turn_start: false`. The sequence itself is not measured when `devprism` is not on `PATH`. The installed `DevPrism.app` is not used. `manvi run` is not started, so no provider is called and no combined wall time is invented.

8. **IPC payload versus PDF bytes.** `serde_json` of `TypstCompileResult.pdf_bytes` from `compile_resume_pdf`, which is the `career_typst_compile` shape: a JSON array of numbers (`Vec<u8>`). The first PDF byte is `%` (37), so the array must open with `[37,` or `[37]`. `typst_compile_document`'s `tauri::ipc::Response` bytes were **not** measured. This commit is before that parity change.

9. **In-process Typst compile wall time.** Same public API, `std::time` inside the worker (thread spawn is not the number). Harness deadline is 120 seconds. A hang returns `Exceeded` and the process exits without a duration. The deadline does not change the engine. This tree does not have a 30-second in-engine deadline. The bench also refuses to record a duration when `success` is false, the page count is wrong, or the PDF header is missing. One-page and thirty-page compiles are both reported. The release profile is unchanged (`lto = thin`, `codegen-units = 1`).

The deadline self-check sleeps 2 seconds behind a 40 millisecond wait and must return before that sleep ends. `cargo test --test bench_harness` covers it. `cargo bench --bench baseline --manifest-path apps/desktop/src-tauri/Cargo.toml -- --self-test` runs only that check. `bun run --filter=@devprism/desktop bench -- --smoke` runs one iteration of the same `baseline` target.

## CI

`.github/workflows/lint.yml` has one non-gating step (`continue-on-error: true`) that runs the smoke harness with `--skip-rust`. The lint job does not install Tectonic, vcpkg, or a Rust toolchain. This card does not add cargo-audit, cargo-deny, a Manvi checksum pin, or a required vitest, tsc, or cargo gate.

## Tooling

Rust benches use `std::time`, not criterion. TypeScript samples use `performance.now` with an explicit min-of-N. Vitest 4.1.12's `bench` command exists in this install; the UI measurement uses it only as a jsdom host. Tinybench's mean over a time budget is not the committed statistic.

`CONTRIBUTING.md` and `docs/ARCHITECTURE.md` still name `bench:typing`. Those files are outside this change. The command is `bun run bench`.

## Measured baseline

Recorded in `bench-results/baseline-2026-10.json` at git `348d14f8f5a116cbacd4cdeed69b1113131d401c` (the harness commit is the child of that SHA). Machine: Apple M5 Pro (`Mac17,8`), Darwin arm64, macOS 27.2 build 26B123. N = 7 after one excluded warmup. Spread is max − min of those seven. Command: `bun run --filter=@devprism/desktop bench` (exit 0). No speedup is claimed.

| Measurement | Min | Spread |
| --- | --- | --- |
| 30-page `compile_resume_pdf` | 1.381 ms | 0.123 ms |
| 30-page first call (excluded; fonts) | 62.376 ms | — |
| 1-page `compile_resume_pdf` | 0.411 ms | 0.133 ms |
| Raster page 0 at 144 DPI | 1.687 ms | 0.917 ms |
| Raster all 30 pages | 54.513 ms | 10.666 ms |
| Retained canvas bytes after 30 pages | 160451520 | 0 |
| 50_000-byte reply, 49 deltas, store updates | 49 | 0 |
| Milliseconds per delta | 0.00191 ms | 0.00156 ms |
| Reply wall time | 0.094 ms | 0.076 ms |
| Keystroke + `toString`, 4096 chars | 0.0060 ms | 0.019 ms |
| Keystroke + `toString`, 32768 chars | 0.0043 ms | 0.047 ms |
| Keystroke + `toString`, 131072 chars | 0.0038 ms | 0.011 ms |
| Keystroke + `toString`, 524288 chars | 0.0040 ms | 0.029 ms |
| Sidebar commits per keystroke | 2 | 0 |
| Editor commits per keystroke | 2 | 0 |
| IPC JSON number array / PDF | 213973 / 62464 bytes (ratio 3.426) | — |

The 30-page PDF is 62464 bytes. The retained-byte figure is under the 160 MiB cap (`167772160`); seven repeats matched. Keystroke spreads are larger than the minima: one transaction sits in the timer noise. Sidebar and editor counts are React profiler commits in jsdom, not a webview. jsdom logs `getClientRects` from CodeMirror's animation frame; the transactions still grew the document by one character per sample (cursor ended at 8 after one warmup and seven samples).

Not measured:

- `claude-output` events per second. No golden NDJSON fixture is in this commit.
- Cold Manvi turn (version, `manvi run --mcp devprism`, `devprism --mcp`). `manvi` is `/Users/bharath/.local/bin/manvi` (v0.1.0, `6ec2b13cad2cfb9a788d988796243be147e54bb1`). `devprism` is not on `PATH`. `manvi --version` alone, which is not the turn, min 6.596 ms, spread 1.222 ms.

`cargo test --test bench_harness` passed both deadline tests (`2 passed`). `Cargo.lock` did not change. `git2` stays 0.20 (lock 0.20.4).
