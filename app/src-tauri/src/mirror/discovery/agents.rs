//! Ported from vercel-labs/skills@1.7.0 (MIT License).
//! See UPSTREAM.md in this directory for maintenance notes.

use std::path::{Path, PathBuf};

use crate::env::Environment;

/// What the agent table reads from the machine: the home directory,
/// environment variables and file existence. [`Environment`] is the real
/// implementation; tests inject a probe.
pub trait AgentProbe {
    fn home(&self) -> &Path;
    fn var(&self, key: &str) -> Option<&str>;
    fn exists(&self, path: &Path) -> bool;
}

impl AgentProbe for Environment {
    fn home(&self) -> &Path {
        &self.home
    }

    fn var(&self, key: &str) -> Option<&str> {
        Environment::var(self, key)
    }

    fn exists(&self, path: &Path) -> bool {
        Environment::exists(self, path)
    }
}

/// One supported agent with its folders and detection result.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Agent {
    pub id: String,
    pub display_name: String,
    pub native_folder: PathBuf,
    pub install_folder: PathBuf,
    pub detected: bool,
}

struct AgentConfig {
    id: &'static str,
    display_name: &'static str,
    skills_dir: &'static str,
    global_skills_dir: PathBuf,
    detected: bool,
}

const UNIVERSAL_SKILLS_DIR: &str = ".agents/skills";

fn join_all(base: &Path, parts: &[&str]) -> PathBuf {
    parts
        .iter()
        .fold(base.to_path_buf(), |path, part| path.join(part))
}

fn create_agents(environment: &impl AgentProbe) -> Vec<AgentConfig> {
    let home = environment.home().to_path_buf();
    let exists = |path: &Path| environment.exists(path);
    let env_home = |name: &str, fallback: &str| -> PathBuf {
        match environment
            .var(name)
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            Some(value) => PathBuf::from(value),
            None => join_all(&home, &[fallback]),
        }
    };
    let config_home = match environment
        .var("XDG_CONFIG_HOME")
        .filter(|value| !value.is_empty())
    {
        Some(value) => PathBuf::from(value),
        None => join_all(&home, &[".config"]),
    };
    let codex_home = env_home("CODEX_HOME", ".codex");
    let claude_home = env_home("CLAUDE_CONFIG_DIR", ".claude");
    let vibe_home = env_home("VIBE_HOME", ".vibe");
    let hermes_home = env_home("HERMES_HOME", ".hermes");
    let autohand_home = env_home("AUTOHAND_HOME", ".autohand");
    let grok_home = env_home("GROK_HOME", ".grok");
    let sarvam_home = env_home("SARVAM_HOME", ".sarvam");
    let zed_app_data = environment
        .var("APPDATA")
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string);
    let zed_flatpak = environment
        .var("FLATPAK_XDG_CONFIG_HOME")
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string);

    let in_home = |path: &str| exists(&join_all(&home, &[path]));

    let open_claw_global_skills_dir = || {
        if in_home(".openclaw") {
            join_all(&home, &[".openclaw/skills"])
        } else if in_home(".clawdbot") {
            join_all(&home, &[".clawdbot/skills"])
        } else if in_home(".moltbot") {
            join_all(&home, &[".moltbot/skills"])
        } else {
            join_all(&home, &[".openclaw/skills"])
        }
    };

    vec![
        AgentConfig {
            id: "aider-desk",
            display_name: "AiderDesk",
            skills_dir: ".aider-desk/skills",
            global_skills_dir: join_all(&home, &[".aider-desk/skills"]),
            detected: in_home(".aider-desk"),
        },
        AgentConfig {
            id: "amp",
            display_name: "Amp",
            skills_dir: ".agents/skills",
            global_skills_dir: join_all(&config_home, &["agents/skills"]),
            detected: exists(&join_all(&config_home, &["amp"])),
        },
        AgentConfig {
            id: "antigravity",
            display_name: "Antigravity",
            skills_dir: ".agents/skills",
            global_skills_dir: join_all(&home, &[".gemini/antigravity/skills"]),
            detected: in_home(".gemini/antigravity"),
        },
        AgentConfig {
            id: "antigravity-cli",
            display_name: "Antigravity CLI",
            skills_dir: ".agents/skills",
            global_skills_dir: join_all(&home, &[".gemini/antigravity-cli/skills"]),
            detected: in_home(".gemini/antigravity-cli"),
        },
        AgentConfig {
            id: "astrbot",
            display_name: "AstrBot",
            skills_dir: "data/skills",
            global_skills_dir: join_all(&home, &[".astrbot/data/skills"]),
            detected: in_home(".astrbot"),
        },
        AgentConfig {
            id: "autohand-code",
            display_name: "Autohand Code CLI",
            skills_dir: ".autohand/skills",
            global_skills_dir: join_all(&autohand_home, &["skills"]),
            detected: exists(&autohand_home),
        },
        AgentConfig {
            id: "augment",
            display_name: "Augment",
            skills_dir: ".augment/skills",
            global_skills_dir: join_all(&home, &[".augment/skills"]),
            detected: in_home(".augment"),
        },
        AgentConfig {
            id: "bob",
            display_name: "IBM Bob",
            skills_dir: ".bob/skills",
            global_skills_dir: join_all(&home, &[".bob/skills"]),
            detected: in_home(".bob"),
        },
        AgentConfig {
            id: "claude-code",
            display_name: "Claude Code",
            skills_dir: ".claude/skills",
            global_skills_dir: join_all(&claude_home, &["skills"]),
            detected: exists(&claude_home),
        },
        AgentConfig {
            id: "openclaw",
            display_name: "OpenClaw",
            skills_dir: "skills",
            global_skills_dir: open_claw_global_skills_dir(),
            detected: in_home(".openclaw") || in_home(".clawdbot") || in_home(".moltbot"),
        },
        AgentConfig {
            id: "cline",
            display_name: "Cline",
            skills_dir: ".agents/skills",
            global_skills_dir: join_all(&home, &[".agents", "skills"]),
            detected: in_home(".cline"),
        },
        AgentConfig {
            id: "codearts-agent",
            display_name: "CodeArts Agent",
            skills_dir: ".codeartsdoer/skills",
            global_skills_dir: join_all(&home, &[".codeartsdoer/skills"]),
            detected: in_home(".codeartsdoer"),
        },
        AgentConfig {
            id: "codebuddy",
            display_name: "CodeBuddy",
            skills_dir: ".codebuddy/skills",
            global_skills_dir: join_all(&home, &[".codebuddy/skills"]),
            detected: in_home(".codebuddy"),
        },
        AgentConfig {
            id: "codemaker",
            display_name: "Codemaker",
            skills_dir: ".codemaker/skills",
            global_skills_dir: join_all(&home, &[".codemaker/skills"]),
            detected: in_home(".codemaker"),
        },
        AgentConfig {
            id: "codestudio",
            display_name: "Code Studio",
            skills_dir: ".codestudio/skills",
            global_skills_dir: join_all(&home, &[".codestudio/skills"]),
            detected: in_home(".codestudio"),
        },
        AgentConfig {
            id: "codex",
            display_name: "Codex",
            skills_dir: ".agents/skills",
            global_skills_dir: join_all(&codex_home, &["skills"]),
            detected: exists(&codex_home) || exists(Path::new("/etc/codex")),
        },
        AgentConfig {
            id: "command-code",
            display_name: "Command Code",
            skills_dir: ".commandcode/skills",
            global_skills_dir: join_all(&home, &[".commandcode/skills"]),
            detected: in_home(".commandcode"),
        },
        AgentConfig {
            id: "continue",
            display_name: "Continue",
            skills_dir: ".continue/skills",
            global_skills_dir: join_all(&home, &[".continue/skills"]),
            detected: in_home(".continue"),
        },
        AgentConfig {
            id: "cortex",
            display_name: "Cortex Code",
            skills_dir: ".cortex/skills",
            global_skills_dir: join_all(&home, &[".snowflake/cortex/skills"]),
            detected: in_home(".snowflake/cortex"),
        },
        AgentConfig {
            id: "crush",
            display_name: "Crush",
            skills_dir: ".crush/skills",
            global_skills_dir: join_all(&home, &[".config/crush/skills"]),
            detected: in_home(".config/crush"),
        },
        AgentConfig {
            id: "cursor",
            display_name: "Cursor",
            skills_dir: ".agents/skills",
            global_skills_dir: join_all(&home, &[".cursor/skills"]),
            detected: in_home(".cursor"),
        },
        AgentConfig {
            id: "deepagents",
            display_name: "Deep Agents",
            skills_dir: ".agents/skills",
            global_skills_dir: join_all(&home, &[".deepagents/agent/skills"]),
            detected: in_home(".deepagents"),
        },
        AgentConfig {
            id: "devin",
            display_name: "Devin for Terminal",
            skills_dir: ".devin/skills",
            global_skills_dir: join_all(&config_home, &["devin/skills"]),
            detected: exists(&join_all(&config_home, &["devin"])),
        },
        AgentConfig {
            id: "dexto",
            display_name: "Dexto",
            skills_dir: ".agents/skills",
            global_skills_dir: join_all(&home, &[".agents/skills"]),
            detected: in_home(".dexto"),
        },
        AgentConfig {
            id: "droid",
            display_name: "Droid",
            skills_dir: ".agents/skills",
            global_skills_dir: join_all(&home, &[".factory/skills"]),
            detected: in_home(".factory"),
        },
        AgentConfig {
            id: "firebender",
            display_name: "Firebender",
            skills_dir: ".agents/skills",
            global_skills_dir: join_all(&home, &[".firebender/skills"]),
            detected: in_home(".firebender"),
        },
        AgentConfig {
            id: "forgecode",
            display_name: "ForgeCode",
            skills_dir: ".forge/skills",
            global_skills_dir: join_all(&home, &[".forge/skills"]),
            detected: in_home(".forge"),
        },
        AgentConfig {
            id: "fx",
            display_name: "fx",
            skills_dir: ".fx/skills",
            global_skills_dir: join_all(&home, &[".fx/skills"]),
            detected: in_home(".fx"),
        },
        AgentConfig {
            id: "gemini-cli",
            display_name: "Gemini CLI",
            skills_dir: ".agents/skills",
            global_skills_dir: join_all(&home, &[".gemini/skills"]),
            detected: in_home(".gemini"),
        },
        AgentConfig {
            id: "github-copilot",
            display_name: "GitHub Copilot",
            skills_dir: ".agents/skills",
            global_skills_dir: join_all(&home, &[".copilot/skills"]),
            detected: in_home(".copilot"),
        },
        AgentConfig {
            id: "goose",
            display_name: "Goose",
            skills_dir: ".goose/skills",
            global_skills_dir: join_all(&config_home, &["goose/skills"]),
            detected: exists(&join_all(&config_home, &["goose"])),
        },
        AgentConfig {
            id: "grok",
            display_name: "Grok Build",
            skills_dir: ".grok/skills",
            global_skills_dir: join_all(&grok_home, &["skills"]),
            detected: exists(&grok_home),
        },
        AgentConfig {
            id: "hermes-agent",
            display_name: "Hermes Agent",
            skills_dir: ".hermes/skills",
            global_skills_dir: join_all(&hermes_home, &["skills"]),
            detected: exists(&hermes_home),
        },
        AgentConfig {
            id: "inference-sh",
            display_name: "inference.sh",
            skills_dir: ".inferencesh/skills",
            global_skills_dir: join_all(&home, &[".inferencesh/skills"]),
            detected: in_home(".inferencesh"),
        },
        AgentConfig {
            id: "jazz",
            display_name: "Jazz",
            skills_dir: ".jazz/skills",
            global_skills_dir: join_all(&home, &[".jazz/skills"]),
            detected: in_home(".jazz"),
        },
        AgentConfig {
            id: "junie",
            display_name: "Junie",
            skills_dir: ".junie/skills",
            global_skills_dir: join_all(&home, &[".junie/skills"]),
            detected: in_home(".junie"),
        },
        AgentConfig {
            id: "iflow-cli",
            display_name: "iFlow CLI",
            skills_dir: ".iflow/skills",
            global_skills_dir: join_all(&home, &[".iflow/skills"]),
            detected: in_home(".iflow"),
        },
        AgentConfig {
            id: "kilo",
            display_name: "Kilo Code",
            skills_dir: ".agents/skills",
            global_skills_dir: join_all(&home, &[".kilo/skills"]),
            detected: in_home(".kilo") || in_home(".kilocode"),
        },
        AgentConfig {
            id: "kimchi",
            display_name: "Kimchi",
            skills_dir: ".kimchi/skills",
            global_skills_dir: join_all(&home, &[".config", "kimchi", "harness", "skills"]),
            detected: exists(&join_all(&home, &[".config", "kimchi"])),
        },
        AgentConfig {
            id: "kimi-code-cli",
            display_name: "Kimi Code CLI",
            skills_dir: ".agents/skills",
            global_skills_dir: join_all(&home, &[".agents/skills"]),
            detected: in_home(".kimi-code") || in_home(".kimi"),
        },
        AgentConfig {
            id: "kiro-cli",
            display_name: "Kiro CLI",
            skills_dir: ".kiro/skills",
            global_skills_dir: join_all(&home, &[".kiro/skills"]),
            detected: in_home(".kiro"),
        },
        AgentConfig {
            id: "kode",
            display_name: "Kode",
            skills_dir: ".kode/skills",
            global_skills_dir: join_all(&home, &[".kode/skills"]),
            detected: in_home(".kode"),
        },
        AgentConfig {
            id: "lingma",
            display_name: "Lingma",
            skills_dir: ".lingma/skills",
            global_skills_dir: join_all(&home, &[".lingma/skills"]),
            detected: in_home(".lingma"),
        },
        AgentConfig {
            id: "loaf",
            display_name: "Loaf",
            skills_dir: ".agents/skills",
            global_skills_dir: join_all(&home, &[".agents/skills"]),
            detected: in_home(".loaf"),
        },
        AgentConfig {
            id: "mcpjam",
            display_name: "MCPJam",
            skills_dir: ".mcpjam/skills",
            global_skills_dir: join_all(&home, &[".mcpjam/skills"]),
            detected: in_home(".mcpjam"),
        },
        AgentConfig {
            id: "minimax-code",
            display_name: "MiniMax Code",
            skills_dir: ".minimax/skills",
            global_skills_dir: join_all(&home, &[".minimax/skills"]),
            detected: in_home(".minimax") || exists(Path::new("/Applications/MiniMax Code.app")),
        },
        AgentConfig {
            id: "mistral-vibe",
            display_name: "Mistral Vibe",
            skills_dir: ".vibe/skills",
            global_skills_dir: join_all(&vibe_home, &["skills"]),
            detected: exists(&vibe_home),
        },
        AgentConfig {
            id: "moxby",
            display_name: "Moxby",
            skills_dir: ".moxby/skills",
            global_skills_dir: join_all(&home, &[".moxby/skills"]),
            detected: in_home(".moxby"),
        },
        AgentConfig {
            id: "mux",
            display_name: "Mux",
            skills_dir: ".mux/skills",
            global_skills_dir: join_all(&home, &[".mux/skills"]),
            detected: in_home(".mux"),
        },
        AgentConfig {
            id: "opencode",
            display_name: "OpenCode",
            skills_dir: ".agents/skills",
            global_skills_dir: join_all(&config_home, &["opencode/skills"]),
            detected: exists(&join_all(&config_home, &["opencode"])),
        },
        AgentConfig {
            id: "openhands",
            display_name: "OpenHands",
            skills_dir: ".openhands/skills",
            global_skills_dir: join_all(&home, &[".openhands/skills"]),
            detected: in_home(".openhands"),
        },
        AgentConfig {
            id: "ona",
            display_name: "Ona",
            skills_dir: ".ona/skills",
            global_skills_dir: join_all(&home, &[".ona/skills"]),
            detected: in_home(".ona"),
        },
        AgentConfig {
            id: "pi",
            display_name: "Pi",
            skills_dir: ".pi/skills",
            global_skills_dir: join_all(&home, &[".pi/agent/skills"]),
            detected: in_home(".pi/agent"),
        },
        AgentConfig {
            id: "posit-assistant",
            display_name: "Posit Assistant",
            skills_dir: ".posit/assistant/skills",
            global_skills_dir: join_all(&home, &[".posit/assistant/skills"]),
            detected: in_home(".posit/assistant") || in_home(".positai"),
        },
        AgentConfig {
            id: "qoder",
            display_name: "Qoder",
            skills_dir: ".qoder/skills",
            global_skills_dir: join_all(&home, &[".qoder/skills"]),
            detected: in_home(".qoder"),
        },
        AgentConfig {
            id: "qoder-cn",
            display_name: "Qoder CN",
            skills_dir: ".qoder/skills",
            global_skills_dir: join_all(&home, &[".qoder-cn/skills"]),
            detected: in_home(".qoder-cn"),
        },
        AgentConfig {
            id: "qwen-code",
            display_name: "Qwen Code",
            skills_dir: ".qwen/skills",
            global_skills_dir: join_all(&home, &[".qwen/skills"]),
            detected: in_home(".qwen"),
        },
        AgentConfig {
            id: "replit",
            display_name: "Replit",
            skills_dir: ".agents/skills",
            global_skills_dir: join_all(&config_home, &["agents/skills"]),
            detected: false,
        },
        AgentConfig {
            id: "reasonix",
            display_name: "Reasonix",
            skills_dir: ".reasonix/skills",
            global_skills_dir: join_all(&home, &[".reasonix/skills"]),
            detected: in_home(".reasonix"),
        },
        AgentConfig {
            id: "rovodev",
            display_name: "Rovo Dev",
            skills_dir: ".rovodev/skills",
            global_skills_dir: join_all(&home, &[".rovodev/skills"]),
            detected: in_home(".rovodev"),
        },
        AgentConfig {
            id: "roo",
            display_name: "Roo Code",
            skills_dir: ".roo/skills",
            global_skills_dir: join_all(&home, &[".roo/skills"]),
            detected: in_home(".roo"),
        },
        AgentConfig {
            id: "sarvam-code",
            display_name: "Sarvam Code",
            skills_dir: ".agents/skills",
            global_skills_dir: join_all(&home, &[".agents/skills"]),
            detected: exists(&sarvam_home),
        },
        AgentConfig {
            id: "tabnine-cli",
            display_name: "Tabnine CLI",
            skills_dir: ".tabnine/agent/skills",
            global_skills_dir: join_all(&home, &[".tabnine/agent/skills"]),
            detected: in_home(".tabnine"),
        },
        AgentConfig {
            id: "terramind",
            display_name: "Terramind",
            skills_dir: ".terramind/skills",
            global_skills_dir: join_all(&home, &[".terramind/skills"]),
            detected: in_home(".terramind"),
        },
        AgentConfig {
            id: "tinycloud",
            display_name: "Tinycloud",
            skills_dir: ".tinycloud/skills",
            global_skills_dir: join_all(&home, &[".tinycloud/skills"]),
            detected: in_home(".tinycloud"),
        },
        AgentConfig {
            id: "trae",
            display_name: "Trae",
            skills_dir: ".trae/skills",
            global_skills_dir: join_all(&home, &[".trae/skills"]),
            detected: in_home(".trae"),
        },
        AgentConfig {
            id: "trae-cn",
            display_name: "Trae CN",
            skills_dir: ".trae/skills",
            global_skills_dir: join_all(&home, &[".trae-cn/skills"]),
            detected: in_home(".trae-cn"),
        },
        AgentConfig {
            id: "warp",
            display_name: "Warp",
            skills_dir: ".agents/skills",
            global_skills_dir: join_all(&home, &[".agents/skills"]),
            detected: in_home(".warp"),
        },
        AgentConfig {
            id: "windsurf",
            display_name: "Windsurf",
            skills_dir: ".windsurf/skills",
            global_skills_dir: join_all(&home, &[".codeium/windsurf/skills"]),
            detected: in_home(".codeium/windsurf"),
        },
        AgentConfig {
            id: "zed",
            display_name: "Zed",
            skills_dir: ".agents/skills",
            global_skills_dir: join_all(&home, &[".agents/skills"]),
            detected: exists(&join_all(&config_home, &["zed"]))
                || zed_app_data
                    .as_deref()
                    .is_some_and(|dir| exists(&join_all(Path::new(dir), &["Zed"])))
                || zed_flatpak
                    .as_deref()
                    .is_some_and(|dir| exists(&join_all(Path::new(dir), &["zed"]))),
        },
        AgentConfig {
            id: "zcode",
            display_name: "ZCode",
            skills_dir: ".zcode/skills",
            global_skills_dir: join_all(&home, &[".zcode/skills"]),
            detected: in_home(".zcode") || exists(Path::new("/Applications/ZCode.app")),
        },
        AgentConfig {
            id: "zencoder",
            display_name: "Zencoder",
            skills_dir: ".zencoder/skills",
            global_skills_dir: join_all(&home, &[".zencoder/skills"]),
            detected: in_home(".zencoder"),
        },
        AgentConfig {
            id: "zenflow",
            display_name: "Zenflow",
            skills_dir: ".zencoder/skills",
            global_skills_dir: join_all(&home, &[".zencoder/skills"]),
            detected: in_home(".zencoder"),
        },
        AgentConfig {
            id: "neovate",
            display_name: "Neovate",
            skills_dir: ".neovate/skills",
            global_skills_dir: join_all(&home, &[".neovate/skills"]),
            detected: in_home(".neovate"),
        },
        AgentConfig {
            id: "pochi",
            display_name: "Pochi",
            skills_dir: ".pochi/skills",
            global_skills_dir: join_all(&home, &[".pochi/skills"]),
            detected: in_home(".pochi"),
        },
        AgentConfig {
            id: "adal",
            display_name: "AdaL",
            skills_dir: ".adal/skills",
            global_skills_dir: join_all(&home, &[".adal/skills"]),
            detected: in_home(".adal"),
        },
    ]
}

/// The supported agents with folders resolved against the given environment. Reads the
/// home directory, environment variables and file existence only through it.
pub fn agent_table(environment: &impl AgentProbe) -> Vec<Agent> {
    let shared_target = environment.home().join(UNIVERSAL_SKILLS_DIR);
    create_agents(environment)
        .into_iter()
        .map(|config| Agent {
            id: config.id.to_string(),
            display_name: config.display_name.to_string(),
            install_folder: if config.skills_dir == UNIVERSAL_SKILLS_DIR {
                shared_target.clone()
            } else {
                config.global_skills_dir.clone()
            },
            native_folder: config.global_skills_dir,
            detected: config.detected,
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;
    use std::collections::{HashMap, HashSet};

    struct Probe {
        home: PathBuf,
        env: HashMap<String, String>,
        existing: HashSet<PathBuf>,
        probed: RefCell<Vec<PathBuf>>,
    }

    impl Probe {
        fn new(env: HashMap<String, String>, existing: HashSet<PathBuf>) -> Self {
            Probe {
                home: PathBuf::from(HOME),
                env,
                existing,
                probed: RefCell::new(Vec::new()),
            }
        }
    }

    impl AgentProbe for Probe {
        fn home(&self) -> &Path {
            &self.home
        }

        fn var(&self, key: &str) -> Option<&str> {
            self.env.get(key).map(String::as_str)
        }

        fn exists(&self, path: &Path) -> bool {
            self.probed.borrow_mut().push(path.to_path_buf());
            self.existing.contains(path)
        }
    }

    const HOME: &str = "/home/tester";

    fn table(env: &[(&str, &str)], existing: &[&str]) -> Vec<Agent> {
        agent_table(&Probe::new(
            env.iter()
                .map(|(k, v)| (k.to_string(), v.to_string()))
                .collect(),
            existing.iter().map(PathBuf::from).collect(),
        ))
    }

    fn agent(id: &str, env: &[(&str, &str)], existing: &[&str]) -> Agent {
        table(env, existing)
            .into_iter()
            .find(|agent| agent.id == id)
            .unwrap_or_else(|| panic!("missing agent {id}"))
    }

    #[test]
    fn leaves_out_universal_eve_and_promptscript() {
        let ids: Vec<_> = table(&[], &[]).into_iter().map(|a| a.id).collect();
        for left_out in ["universal", "eve", "promptscript"] {
            assert!(!ids.contains(&left_out.to_string()));
        }
    }

    #[test]
    fn includes_every_other_upstream_agent() {
        let mut ids: Vec<_> = table(&[], &[]).into_iter().map(|a| a.id).collect();
        ids.sort();
        let expected = [
            "adal",
            "aider-desk",
            "amp",
            "antigravity",
            "antigravity-cli",
            "astrbot",
            "augment",
            "autohand-code",
            "bob",
            "claude-code",
            "cline",
            "codearts-agent",
            "codebuddy",
            "codemaker",
            "codestudio",
            "codex",
            "command-code",
            "continue",
            "cortex",
            "crush",
            "cursor",
            "deepagents",
            "devin",
            "dexto",
            "droid",
            "firebender",
            "forgecode",
            "fx",
            "gemini-cli",
            "github-copilot",
            "goose",
            "grok",
            "hermes-agent",
            "iflow-cli",
            "inference-sh",
            "jazz",
            "junie",
            "kilo",
            "kimchi",
            "kimi-code-cli",
            "kiro-cli",
            "kode",
            "lingma",
            "loaf",
            "mcpjam",
            "minimax-code",
            "mistral-vibe",
            "moxby",
            "mux",
            "neovate",
            "ona",
            "openclaw",
            "opencode",
            "openhands",
            "pi",
            "pochi",
            "posit-assistant",
            "qoder",
            "qoder-cn",
            "qwen-code",
            "reasonix",
            "replit",
            "roo",
            "rovodev",
            "sarvam-code",
            "tabnine-cli",
            "terramind",
            "tinycloud",
            "trae",
            "trae-cn",
            "warp",
            "windsurf",
            "zcode",
            "zed",
            "zencoder",
            "zenflow",
        ];
        assert_eq!(ids, expected);
    }

    #[test]
    fn reads_nothing_but_the_injected_home_env_and_exists() {
        let probe = Probe::new(HashMap::new(), HashSet::new());
        let agents = agent_table(&probe);
        for agent in &agents {
            assert!(!agent.display_name.is_empty());
            assert!(agent.native_folder.starts_with("/home/tester/"));
            assert!(agent.install_folder.starts_with("/home/tester/"));
            assert!(!agent.detected);
        }
        let mut outside: Vec<_> = probe
            .probed
            .into_inner()
            .into_iter()
            .filter(|path| !path.starts_with("/home/tester/"))
            .map(|path| path.to_string_lossy().to_string())
            .collect();
        outside.sort();
        outside.dedup();
        assert_eq!(
            outside,
            [
                "/Applications/MiniMax Code.app",
                "/Applications/ZCode.app",
                "/etc/codex"
            ]
        );
    }

    #[test]
    fn own_folder_agents_install_into_their_native_folder() {
        assert_eq!(
            agent("windsurf", &[], &["/home/tester/.codeium/windsurf"]),
            Agent {
                id: "windsurf".into(),
                display_name: "Windsurf".into(),
                native_folder: "/home/tester/.codeium/windsurf/skills".into(),
                install_folder: "/home/tester/.codeium/windsurf/skills".into(),
                detected: true,
            }
        );
    }

    #[test]
    fn universal_agents_install_into_the_shared_target() {
        assert_eq!(
            agent("cursor", &[], &[]),
            Agent {
                id: "cursor".into(),
                display_name: "Cursor".into(),
                native_folder: "/home/tester/.cursor/skills".into(),
                install_folder: "/home/tester/.agents/skills".into(),
                detected: false,
            }
        );
        assert_eq!(
            agent("opencode", &[], &[]).install_folder,
            PathBuf::from("/home/tester/.agents/skills")
        );
    }

    #[test]
    fn absolute_detection_checks_go_through_exists() {
        assert!(!agent("zcode", &[], &[]).detected);
        assert!(agent("zcode", &[], &["/Applications/ZCode.app"]).detected);
        assert!(agent("codex", &[], &["/etc/codex"]).detected);
    }

    #[test]
    fn never_detects_from_the_working_directory() {
        let cwd = std::env::current_dir().unwrap();
        let data_skills = cwd.join("data/skills").to_string_lossy().to_string();
        let codebuddy = cwd.join(".codebuddy").to_string_lossy().to_string();
        let existing = [data_skills.as_str(), codebuddy.as_str()];
        assert!(!agent("astrbot", &[], &existing).detected);
        assert!(!agent("codebuddy", &[], &existing).detected);
    }

    #[test]
    fn codex_home_moves_the_codex_folder() {
        let codex = agent("codex", &[("CODEX_HOME", "/opt/codex")], &["/opt/codex"]);
        assert_eq!(codex.native_folder, PathBuf::from("/opt/codex/skills"));
        assert!(codex.detected);
    }

    #[test]
    fn claude_config_dir_moves_the_claude_code_folder() {
        let claude = agent(
            "claude-code",
            &[("CLAUDE_CONFIG_DIR", "/opt/claude")],
            &["/opt/claude"],
        );
        assert_eq!(claude.native_folder, PathBuf::from("/opt/claude/skills"));
        assert_eq!(claude.install_folder, PathBuf::from("/opt/claude/skills"));
        assert!(claude.detected);
    }

    #[test]
    fn xdg_config_home_moves_the_goose_folder() {
        let goose = agent(
            "goose",
            &[("XDG_CONFIG_HOME", "/opt/xdg")],
            &["/opt/xdg/goose"],
        );
        assert_eq!(goose.install_folder, PathBuf::from("/opt/xdg/goose/skills"));
        assert!(goose.detected);
        assert_eq!(
            agent("goose", &[], &[]).install_folder,
            PathBuf::from("/home/tester/.config/goose/skills")
        );
    }

    #[test]
    fn openclaw_prefers_the_first_existing_legacy_folder() {
        let legacy = agent("openclaw", &[], &["/home/tester/.clawdbot"]);
        assert_eq!(
            legacy.install_folder,
            PathBuf::from("/home/tester/.clawdbot/skills")
        );
        assert!(legacy.detected);
        assert_eq!(
            agent("openclaw", &[], &[]).install_folder,
            PathBuf::from("/home/tester/.openclaw/skills")
        );
    }

    #[test]
    fn zed_is_detected_from_appdata_and_flatpak_config() {
        assert!(agent("zed", &[("APPDATA", "/win/appdata")], &["/win/appdata/Zed"]).detected);
        assert!(agent("zed", &[("FLATPAK_XDG_CONFIG_HOME", "/fp")], &["/fp/zed"]).detected);
        assert!(!agent("zed", &[], &[]).detected);
    }
}
