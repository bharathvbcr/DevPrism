// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use clap::{Parser, Subcommand};

#[derive(Parser)]
#[command(name = "devprism")]
#[command(about = "DevPrism Agent CLI", long_about = None)]
struct Cli {
    #[command(subcommand)]
    command: Option<Commands>,
}

#[derive(Subcommand)]
enum Commands {
    /// Start an interactive chat session
    Repl {
        /// Model to use
        #[arg(short, long)]
        model: Option<String>,
    },
    /// Run a single prompt and exit
    Chat {
        /// The prompt to execute
        prompt: String,
        /// Model to use
        #[arg(short, long)]
        model: Option<String>,
    },
}

fn main() {
    // Hidden CLI mode for tectonic
    let args: Vec<String> = std::env::args().collect();
    if args.len() >= 4 && args[1] == "--tectonic-compile" {
        let work_dir = std::path::Path::new(&args[2]);
        let main_file = &args[3];
        match dev_prism_desktop_lib::tectonic_compile_subprocess(work_dir, main_file) {
            Ok(()) => std::process::exit(0),
            Err(e) => {
                eprintln!("{}", e);
                std::process::exit(1);
            }
        }
    }

    // Parse CLI arguments for Agent CLI
    // We enter CLI mode if a known subcommand is used, or if help/version is requested.
    let is_subcommand = args.len() > 1 && matches!(args[1].as_str(), "repl" | "chat");
    let is_help_or_version =
        args.len() > 1 && matches!(args[1].as_str(), "--help" | "-h" | "--version" | "-V");

    if is_subcommand || is_help_or_version {
        let cli = Cli::parse();
        if let Some(command) = cli.command {
            let rt = tokio::runtime::Runtime::new().expect("Failed to create tokio runtime");
            rt.block_on(async {
                match command {
                    Commands::Repl { model } => {
                        if let Err(e) = dev_prism_desktop_lib::run_repl(model).await {
                            eprintln!("Error: {}", e);
                            std::process::exit(1);
                        }
                    }
                    Commands::Chat { prompt, model } => {
                        if let Err(e) = dev_prism_desktop_lib::run_chat(prompt, model).await {
                            eprintln!("Error: {}", e);
                            std::process::exit(1);
                        }
                    }
                }
            });
            return;
        }
    }

    dev_prism_desktop_lib::run()
}
