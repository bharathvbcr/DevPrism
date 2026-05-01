use crate::agent::providers::gemini::GeminiProvider;
use crate::agent::providers::ollama::OllamaProvider;
use crate::agent::providers::Provider;
use crate::agent::{CliReporter, Orchestrator};
use colored::*;
use rustyline::error::ReadlineError;
use rustyline::DefaultEditor;
use std::sync::Arc;

pub async fn run_repl(model: Option<String>) -> Result<(), String> {
    let provider = init_provider(model)?;
    let orchestrator = Orchestrator::new(provider, crate::agent::knowledge::ProjectState::new());
    let reporter = Arc::new(CliReporter::new());

    let mut rl = DefaultEditor::new().map_err(|e| e.to_string())?;

    println!("{}", "DevPrism Agent REPL".bold().bright_green());
    println!("Type 'exit' or 'quit' to leave.");

    loop {
        let readline = rl.readline(">> ");
        match readline {
            Ok(line) => {
                let line = line.trim();
                if line.is_empty() {
                    continue;
                }
                if line == "exit" || line == "quit" {
                    break;
                }
                rl.add_history_entry(line).map_err(|e| e.to_string())?;

                if let Err(e) = orchestrator
                    .continue_task_with_reporter(reporter.clone(), line.to_string())
                    .await
                {
                    eprintln!("Error: {}", e.red());
                }
            }
            Err(ReadlineError::Interrupted) => {
                println!("CTRL-C");
                break;
            }
            Err(ReadlineError::Eof) => {
                println!("CTRL-D");
                break;
            }
            Err(err) => {
                println!("Error: {:?}", err);
                break;
            }
        }
    }
    Ok(())
}

pub async fn run_chat(prompt: String, model: Option<String>) -> Result<(), String> {
    let provider = init_provider(model)?;
    let orchestrator = Orchestrator::new(provider, crate::agent::knowledge::ProjectState::new());
    let reporter = Arc::new(CliReporter::new());

    orchestrator.run_task_with_reporter(reporter, prompt).await
}

fn init_provider(model: Option<String>) -> Result<Arc<dyn Provider>, String> {
    if std::env::var("GEMINI_API_KEY").is_ok() {
        Ok(Arc::new(GeminiProvider::new(model)?))
    } else {
        let ollama_model = std::env::var("OLLAMA_MODEL").ok().or(model);
        Ok(Arc::new(OllamaProvider::new(ollama_model)))
    }
}
