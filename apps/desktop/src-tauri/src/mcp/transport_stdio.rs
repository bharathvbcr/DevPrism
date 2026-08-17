//! Stdio transport for external agents (Cursor, Claude Code, Goose, Cline, etc.).
//!
//! Reads newline-delimited JSON-RPC requests from standard input and writes
//! responses to standard output.

use crate::career_db::CareerDbState;
use crate::mcp::protocol::{JsonRpcError, JsonRpcRequest, JsonRpcResponse};
use crate::mcp::server::StatelessMcpServer;
use std::io::{self, BufRead, Write};

pub async fn run_stdio_transport(career_db: CareerDbState) -> Result<(), String> {
    let server = StatelessMcpServer::new(career_db);
    let stdin = io::stdin();
    let mut stdout = io::stdout();
    let mut reader = stdin.lock();

    let mut line = String::new();
    while let Ok(bytes_read) = reader.read_line(&mut line) {
        if bytes_read == 0 {
            break; // EOF
        }

        let trimmed = line.trim();
        if !trimmed.is_empty() {
            let response = match serde_json::from_str::<JsonRpcRequest>(trimmed) {
                Ok(req) => server.handle_request(None, req).await,
                Err(e) => JsonRpcResponse::error(
                    None,
                    JsonRpcError::new(-32700, format!("Parse error: {e}")),
                ),
            };

            if let Ok(res_json) = serde_json::to_string(&response) {
                let _ = writeln!(stdout, "{res_json}");
                let _ = stdout.flush();
            }
        }

        line.clear();
    }

    Ok(())
}
