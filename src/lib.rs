//! Exact Contract for Zed: starts the language server.
//!
//! The server is one dependency-free script. It is downloaded from this repository's
//! latest release into the extension's work directory and run on the Node that Zed manages.

use std::{env, fs};
use zed_extension_api::{
    self as zed, serde_json, settings::LspSettings, DownloadedFileType, GithubReleaseOptions,
    LanguageServerId, LanguageServerInstallationStatus, Result,
};

const SERVER_REPOSITORY: &str = "brunokiafuka/zed-exact-contract";
const SERVER_FILE: &str = "contract-lsp.mjs";
const SERVER_DIR_PREFIX: &str = "contract-lsp-";

struct ContractExtension {
    /// The server script this session already resolved, relative to the work directory.
    server: Option<String>,
}

fn is_file(path: &str) -> bool {
    fs::metadata(path).is_ok_and(|file| file.is_file())
}

impl ContractExtension {
    /// The newest server already in the work directory, if any.
    fn downloaded() -> Option<String> {
        let mut found: Vec<String> = fs::read_dir(".")
            .ok()?
            .flatten()
            .filter_map(|entry| entry.file_name().into_string().ok())
            .filter(|name| name.starts_with(SERVER_DIR_PREFIX))
            .map(|name| format!("{name}/{SERVER_FILE}"))
            .filter(|path| is_file(path))
            .collect();
        found.sort();
        found.pop()
    }

    /// The server script: the latest release, downloaded once, else the copy already here.
    fn server_path(&mut self, language_server_id: &LanguageServerId) -> Result<String> {
        if let Some(path) = &self.server {
            if is_file(path) {
                return Ok(path.clone());
            }
        }

        zed::set_language_server_installation_status(
            language_server_id,
            &LanguageServerInstallationStatus::CheckingForUpdate,
        );
        let release = zed::latest_github_release(
            SERVER_REPOSITORY,
            GithubReleaseOptions {
                require_assets: true,
                pre_release: false,
            },
        );
        let path = match release {
            Ok(release) => {
                let dir = format!("{SERVER_DIR_PREFIX}{}", release.version);
                let path = format!("{dir}/{SERVER_FILE}");
                if !is_file(&path) {
                    let asset = release
                        .assets
                        .iter()
                        .find(|asset| asset.name == SERVER_FILE)
                        .ok_or_else(|| {
                            format!("release {} has no {SERVER_FILE}", release.version)
                        })?;
                    zed::set_language_server_installation_status(
                        language_server_id,
                        &LanguageServerInstallationStatus::Downloading,
                    );
                    fs::create_dir_all(&dir).map_err(|error| format!("creating {dir}: {error}"))?;
                    zed::download_file(&asset.download_url, &path, DownloadedFileType::Uncompressed)
                        .map_err(|error| format!("downloading {SERVER_FILE}: {error}"))?;
                    // Earlier versions are no longer needed.
                    for entry in fs::read_dir(".").into_iter().flatten().flatten() {
                        if let Ok(name) = entry.file_name().into_string() {
                            if name.starts_with(SERVER_DIR_PREFIX) && name != dir {
                                fs::remove_dir_all(entry.path()).ok();
                            }
                        }
                    }
                }
                path
            }
            // Offline, or GitHub did not answer: the copy from an earlier session still works.
            Err(error) => Self::downloaded()
                .ok_or_else(|| format!("finding the Contract language server: {error}"))?,
        };

        self.server = Some(path.clone());
        Ok(path)
    }
}

impl zed::Extension for ContractExtension {
    fn new() -> Self {
        Self { server: None }
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

        let server = env::current_dir()
            .map_err(|error| format!("the extension's directory: {error}"))?
            .join(self.server_path(language_server_id)?);

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
