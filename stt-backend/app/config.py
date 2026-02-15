from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path


@dataclass(slots=True)
class Settings:
    host: str = os.getenv("VCB_HOST", "0.0.0.0")
    port: int = int(os.getenv("VCB_PORT", "8766"))
    auth_token: str = os.getenv("VCB_AUTH_TOKEN", "")

    llm_command: str = os.getenv("OPENCLAW_LLM_COMMAND", "")
    codex_bin: str = os.getenv("CODEX_BIN", "codex")
    codex_model: str = os.getenv("CODEX_MODEL", "")
    codex_extra_args: str = os.getenv("CODEX_EXTRA_ARGS", "")
    codex_mcp_enabled: bool = os.getenv("CODEX_MCP_ENABLED", "1") != "0"
    codex_mcp_protocol_version: str = os.getenv("CODEX_MCP_PROTOCOL_VERSION", "2025-03-26")
    codex_mcp_startup_timeout_sec: float = float(os.getenv("CODEX_MCP_STARTUP_TIMEOUT_SEC", "8.0"))
    codex_mcp_request_timeout_sec: float = float(os.getenv("CODEX_MCP_REQUEST_TIMEOUT_SEC", "120.0"))
    codex_mcp_sandbox: str = os.getenv("CODEX_MCP_SANDBOX", "workspace-write")
    codex_mcp_approval_policy: str = os.getenv("CODEX_MCP_APPROVAL_POLICY", "never")
    codex_warmup: bool = os.getenv("CODEX_WARMUP", "1") != "0"

    # Legacy Ollama settings are kept for backward-compatible env files.
    ollama_base_url: str = os.getenv("OLLAMA_BASE_URL", "http://127.0.0.1:11434")
    ollama_model: str = os.getenv("OLLAMA_MODEL", "llama3.1:8b")
    system_prompt: str = os.getenv(
        "VCB_SYSTEM_PROMPT",
        "You are a concise, practical assistant. Output ONLY the final answer for the user. "
        "Do NOT include planning, tool descriptions, meta commentary, timing/latency logs, or phrases like 'I will'. "
        "No analysis sections. No preambles. If the user asks you to do something, just do it and reply with the result.",
    )

    stt_model_size: str = os.getenv("STT_MODEL_SIZE", "medium")
    stt_device: str = os.getenv("STT_DEVICE", "auto")
    stt_compute_type: str = os.getenv("STT_COMPUTE_TYPE", "int8")
    stt_partial_interval_sec: float = float(os.getenv("STT_PARTIAL_INTERVAL_SEC", "1.0"))

    tts_mode: str = os.getenv("TTS_MODE", "auto")  # auto|off|piper|say
    piper_bin: str = os.getenv("PIPER_BIN", "piper")
    piper_model: str = os.getenv("PIPER_MODEL", "")

    kanban_inbox_url: str = os.getenv("KANBAN_INBOX_URL", "http://127.0.0.1:8787/api/inbox")
    openclaw_bin: str = os.getenv("OPENCLAW_BIN", "openclaw")

    work_vault_root: Path = Path(
        os.getenv(
            "WORK_VAULT_ROOT",
            str(Path.home() / "Documents/Obsidian/custom-obsidian-vault/work"),
        )
    )
    personal_vault_root: Path = Path(
        os.getenv(
            "PERSONAL_VAULT_ROOT",
            str(Path.home() / "Documents/Obsidian/custom-obsidian-vault/personal"),
        )
    )

    hook_wake_enabled: bool = os.getenv("HOOK_WAKE_ENABLED", "1") != "0"

    max_history_messages: int = int(os.getenv("VCB_MAX_HISTORY_MESSAGES", "16"))

    @property
    def llm_display_name(self) -> str:
        model = self.codex_model.strip()
        return model or "codex"


def _load_dotenv_if_present() -> None:
    """Load .env for non-shell launches (e.g., uvicorn via process manager).

    This avoids surprises where `scripts/run_local.sh` is not used.
    """

    try:
        from dotenv import load_dotenv  # type: ignore

        load_dotenv()
    except Exception:
        return


_load_dotenv_if_present()
settings = Settings()

# Load env-derived values after dotenv so Settings reflects .env content.
# (Dataclass field defaults are evaluated at class definition time.)
settings.auth_token = os.getenv("VCB_AUTH_TOKEN", settings.auth_token)
settings.host = os.getenv("VCB_HOST", settings.host)
settings.port = int(os.getenv("VCB_PORT", str(settings.port)))
settings.llm_command = os.getenv("OPENCLAW_LLM_COMMAND", settings.llm_command)
settings.codex_bin = os.getenv("CODEX_BIN", settings.codex_bin)
settings.codex_model = os.getenv("CODEX_MODEL", settings.codex_model)
settings.codex_extra_args = os.getenv("CODEX_EXTRA_ARGS", settings.codex_extra_args)
settings.codex_mcp_enabled = os.getenv("CODEX_MCP_ENABLED", "1") != "0"
settings.codex_mcp_protocol_version = os.getenv("CODEX_MCP_PROTOCOL_VERSION", settings.codex_mcp_protocol_version)
settings.codex_mcp_startup_timeout_sec = float(
    os.getenv("CODEX_MCP_STARTUP_TIMEOUT_SEC", str(settings.codex_mcp_startup_timeout_sec))
)
settings.codex_mcp_request_timeout_sec = float(
    os.getenv("CODEX_MCP_REQUEST_TIMEOUT_SEC", str(settings.codex_mcp_request_timeout_sec))
)
settings.codex_mcp_sandbox = os.getenv("CODEX_MCP_SANDBOX", settings.codex_mcp_sandbox)
settings.codex_mcp_approval_policy = os.getenv("CODEX_MCP_APPROVAL_POLICY", settings.codex_mcp_approval_policy)
settings.codex_warmup = os.getenv("CODEX_WARMUP", "1") != "0"
settings.ollama_base_url = os.getenv("OLLAMA_BASE_URL", settings.ollama_base_url)
settings.ollama_model = os.getenv("OLLAMA_MODEL", settings.ollama_model)
settings.system_prompt = os.getenv("VCB_SYSTEM_PROMPT", settings.system_prompt)
settings.stt_model_size = os.getenv("STT_MODEL_SIZE", settings.stt_model_size)
settings.stt_device = os.getenv("STT_DEVICE", settings.stt_device)
settings.stt_compute_type = os.getenv("STT_COMPUTE_TYPE", settings.stt_compute_type)
settings.stt_partial_interval_sec = float(os.getenv("STT_PARTIAL_INTERVAL_SEC", str(settings.stt_partial_interval_sec)))
settings.tts_mode = os.getenv("TTS_MODE", settings.tts_mode)
settings.piper_bin = os.getenv("PIPER_BIN", settings.piper_bin)
settings.piper_model = os.getenv("PIPER_MODEL", settings.piper_model)
settings.kanban_inbox_url = os.getenv("KANBAN_INBOX_URL", settings.kanban_inbox_url)
settings.openclaw_bin = os.getenv("OPENCLAW_BIN", settings.openclaw_bin)
settings.hook_wake_enabled = os.getenv("HOOK_WAKE_ENABLED", "1") != "0"
settings.max_history_messages = int(os.getenv("VCB_MAX_HISTORY_MESSAGES", str(settings.max_history_messages)))
