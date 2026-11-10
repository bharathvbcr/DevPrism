# ScholarLM desktop bridge

The desktop WisDev CLI bridge has been removed. That included the Rust
commands (`wisdev_check`, `wisdev_build`, `wisdev_research`, `wisdev_docgen`),
`apps/desktop/src-tauri/src/wisdev.rs`, the ScholarLM sidebar tab, the research
panel, the Zustand store, and the command-palette entries that opened them.

ScholarLM itself is a separate product. This repository no longer spawns a
local `wisdev` binary or ships a panel for it.
