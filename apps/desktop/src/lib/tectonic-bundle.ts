/** Shape returned by the Rust `check_tectonic_bundle` command. */
export interface TectonicBundleStatus {
  /** The bundle answered a real file request — compiles will work. */
  ready: boolean;
  /** True when the check succeeded fully offline. */
  cached: boolean;
  /** Human-readable explanation when not ready. */
  message: string | null;
}
