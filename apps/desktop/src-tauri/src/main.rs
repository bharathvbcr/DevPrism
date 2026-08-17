// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    let args: Vec<String> = std::env::args().collect();

    // Hidden CLI mode: when invoked with `--tectonic-compile <work_dir> <main_file>`,
    // run tectonic in this subprocess and exit. This isolates tectonic's global C state
    // so that a failed compilation doesn't poison the font cache for subsequent runs.
    if args.len() >= 4 && args[1] == "--tectonic-compile" {
        let work_dir = std::path::Path::new(&args[2]);
        let main_file = &args[3];
        match claude_prism_desktop_lib::tectonic_compile_subprocess(work_dir, main_file) {
            Ok(()) => std::process::exit(0),
            Err(e) => {
                eprintln!("{}", e);
                std::process::exit(1);
            }
        }
    }

    // Stateless MCP 2.0 Stdio mode: `--mcp` or `mcp-server` or `--mcp-stdio`
    if args.iter().any(|a| a == "--mcp" || a == "mcp-server" || a == "--mcp-stdio") {
        let runtime = tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .build()
            .expect("Failed to build Tokio runtime for MCP server");

        let res = runtime.block_on(async {
            claude_prism_desktop_lib::mcp::transport_stdio::run_stdio_transport(Default::default()).await
        });

        match res {
            Ok(()) => std::process::exit(0),
            Err(e) => {
                eprintln!("[mcp_stdio] error: {e}");
                std::process::exit(1);
            }
        }
    }

    // Stateless MCP 2.0 HTTP mode: `--mcp-http [port]`
    if let Some(pos) = args.iter().position(|a| a == "--mcp-http") {
        let port: u16 = args
            .get(pos + 1)
            .and_then(|p| p.parse().ok())
            .unwrap_or(39200);

        let runtime = tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .build()
            .expect("Failed to build Tokio runtime for MCP HTTP server");

        let res = runtime.block_on(async {
            claude_prism_desktop_lib::mcp::transport_http::run_http_transport(Default::default(), port).await
        });

        match res {
            Ok(()) => std::process::exit(0),
            Err(e) => {
                eprintln!("[mcp_http] error: {e}");
                std::process::exit(1);
            }
        }
    }

    claude_prism_desktop_lib::run()
}
