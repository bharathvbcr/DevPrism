fn main() {
    // Embed ZOTERO credentials at compile time from .env file or system env
    let _ = dotenvy::dotenv(); // load .env if present (local dev)
    for key in ["ZOTERO_CONSUMER_KEY", "ZOTERO_CONSUMER_SECRET"] {
        if let Ok(val) = std::env::var(key) {
            println!("cargo:rustc-env={key}={val}");
        }
    }
    tauri_build::build()
}
