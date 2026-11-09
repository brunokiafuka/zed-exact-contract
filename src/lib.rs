//! Exact Contract for Zed: starts the language server.
//!
//! The server is one dependency-free script, carried in this extension and run
//! on the Node that Zed manages, so there is nothing to download or install.

use std::{env, fs};
use zed_extension_api::{self as zed, serde_json, settings::LspSettings, LanguageServerId, Result};

const SERVER_FILE: &str = "contract-lsp.mjs";
const SERVER_SOURCE: &str = include_str!("../server/contract-lsp.mjs");

struct ContractExtension;

impl zed::Extension for ContractExtension {
    fn new() -> Self {
        Self
    }

    fn language_server_command(
        &mut self,
        language_server_id: &LanguageServerId,
        worktree: &zed::Worktree,
    ) -> Result<zed::Command> {
        let env = worktree.shell_env();

        // `lsp.contract-lsp.binary` in settings runs another server instead.
        let binary = LspSettings::for_worktree(language_server_id.as_ref(), worktree)
            .ok()
            .and_then(|settings| settings.binary);
        if let Some(binary) = binary {
            if let Some(path) = binary.path {
                return Ok(zed::Command {
                    command: path,
                    args: binary.arguments.unwrap_or_default(),
                    env,
                });
            }
        }

        fs::write(SERVER_FILE, SERVER_SOURCE)
            .map_err(|error| format!("writing {SERVER_FILE}: {error}"))?;
        let server = env::current_dir()
            .map_err(|error| format!("the extension's directory: {error}"))?
            .join(SERVER_FILE);

        Ok(zed::Command {
            command: zed::node_binary_path()?,
            args: vec![server.to_string_lossy().into_owned()],
            env,
        })
    }

    // `lsp.contract-lsp.initialization_options`: `contractPath` names the compiler
    // binary, `exactPath` the exact checkout, when neither is found from the app.
    fn language_server_initialization_options(
        &mut self,
        language_server_id: &LanguageServerId,
        worktree: &zed::Worktree,
    ) -> Result<Option<serde_json::Value>> {
        Ok(LspSettings::for_worktree(language_server_id.as_ref(), worktree)
            .ok()
            .and_then(|settings| settings.initialization_options))
    }
}

zed::register_extension!(ContractExtension);
