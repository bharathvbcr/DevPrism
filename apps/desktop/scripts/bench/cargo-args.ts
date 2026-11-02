/**
 * Argv for `cargo bench`. `--bench baseline` is required: a bare
 * `cargo bench -- --smoke` forwards `--smoke` to the lib unittest harness,
 * which rejects the flag and never runs this bench.
 */
export function cargoBenchArgs(manifest: string, smoke: boolean): string[] {
  const args = ["bench", "--manifest-path", manifest, "--bench", "baseline"];
  if (smoke) args.push("--", "--smoke");
  return args;
}
