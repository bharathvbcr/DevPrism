//! Lightweight HTTP Transport for Stateless MCP 2.0 (SEP-2243).
//!
//! Serves POST requests at `/mcp` with full header inspection and validation.

use crate::career_db::CareerDbState;
use crate::mcp::protocol::{HttpHeaders, JsonRpcError, JsonRpcRequest, JsonRpcResponse};
use crate::mcp::server::StatelessMcpServer;
use std::collections::HashMap;
use std::net::SocketAddr;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

pub async fn run_http_transport(career_db: CareerDbState, port: u16) -> Result<(), String> {
    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    let listener = TcpListener::bind(addr)
        .await
        .map_err(|e| format!("Failed to bind MCP HTTP server to {addr}: {e}"))?;

    eprintln!("[mcp_http] Stateless MCP 2.0 server listening on http://{addr}/mcp");
    let server = StatelessMcpServer::new(career_db);

    loop {
        match listener.accept().await {
            Ok((stream, _)) => {
                let s = server.clone();
                tokio::spawn(async move {
                    handle_connection(stream, s).await;
                });
            }
            Err(e) => {
                eprintln!("[mcp_http] Accept error: {e}");
            }
        }
    }
}

async fn handle_connection(mut stream: TcpStream, server: StatelessMcpServer) {
    let mut buffer = vec![0u8; 64 * 1024];
    let bytes_read = match stream.read(&mut buffer).await {
        Ok(n) if n > 0 => n,
        _ => return,
    };

    let request_str = match std::str::from_utf8(&buffer[..bytes_read]) {
        Ok(s) => s,
        Err(_) => return,
    };

    // Simple HTTP parsing
    let mut headers = HashMap::new();
    let parts: Vec<&str> = request_str.split("\r\n\r\n").collect();
    let body = if parts.len() >= 2 {
        let header_lines: Vec<&str> = parts[0].lines().collect();
        for line in header_lines.iter().skip(1) {
            if let Some((k, v)) = line.split_once(':') {
                headers.insert(k.trim().to_lowercase(), v.trim().to_string());
            }
        }
        parts[1]
    } else {
        request_str
    };

    let http_headers = HttpHeaders::from_map(&headers);
    let response: JsonRpcResponse = match serde_json::from_str::<JsonRpcRequest>(body.trim()) {
        Ok(req) => server.handle_request(Some(&http_headers), req).await,
        Err(e) => JsonRpcResponse::error(
            None,
            JsonRpcError::new(-32700, format!("Parse error: {e}")),
        ),
    };

    let res_body = serde_json::to_string(&response).unwrap_or_else(|_| "{}".to_string());
    let http_res = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nAccess-Control-Allow-Origin: *\r\nAccess-Control-Allow-Headers: *\r\nConnection: close\r\n\r\n{}",
        res_body.len(),
        res_body
    );

    let _ = stream.write_all(http_res.as_bytes()).await;
    let _ = stream.flush().await;
}
