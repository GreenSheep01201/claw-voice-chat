import asyncio
import json
import shutil
from pathlib import Path
from typing import Any, Dict, List, Optional

from app.config import settings

# Common LLM CLIs to check for (for UI display only)
CLI_TOOLS = [
    "openclaw",
    "codex",
    "claude",
    "gemini",
]


async def run_command(args: List[str]) -> Optional[str]:
    cmd = args[0]
    if not shutil.which(cmd):
        return None

    try:
        proc = await asyncio.create_subprocess_exec(
            *args, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE
        )
        stdout, _ = await proc.communicate()
        if proc.returncode != 0:
            return None
        return stdout.decode().strip()
    except Exception:
        return None


async def get_cli_status() -> Dict[str, Any]:
    """
    Detect available CLI tools and return their status.
    """
    tools = {}
    for tool in CLI_TOOLS:
        path = shutil.which(tool)
        if path:
            tools[tool] = path

    # Check primary tool version (openclaw or codex)
    version = None
    primary_bin = settings.openclaw_bin or settings.codex_bin
    if primary_bin and shutil.which(primary_bin):
        output = await run_command([primary_bin, "--version"])
        if output:
            version = output

    return {
        "available": bool(tools.get("openclaw") or tools.get("codex")),
        "tools": tools,
        "primary_bin": primary_bin,
        "version": version,
    }


async def get_profiles() -> List[Dict[str, Any]]:
    """Read OpenClaw auth profiles from ~/.openclaw/openclaw.json.

    Returns **non-secret metadata only**:
    - key: profile key (e.g. "github-copilot:github")
    - provider: provider id
    - mode: oauth|token|...

    Never return tokens/keys to the browser.
    """

    config_path = Path.home() / ".openclaw" / "openclaw.json"
    if not config_path.exists():
        return []

    try:
        data = json.loads(config_path.read_text(encoding="utf-8"))
    except Exception:
        return []

    profiles_obj = (data.get("auth") or {}).get("profiles")
    if not isinstance(profiles_obj, dict):
        return []

    profiles: List[Dict[str, Any]] = []
    for key, meta in profiles_obj.items():
        if not isinstance(key, str) or not key:
            continue
        if not isinstance(meta, dict):
            meta = {}

        provider = str(meta.get("provider") or "").strip() or "unknown"
        mode = str(meta.get("mode") or "").strip() or "unknown"

        profiles.append({
            "key": key,
            "provider": provider,
            "mode": mode,
        })

    profiles.sort(key=lambda p: (p.get("provider") or "", p.get("key") or ""))
    return profiles


async def get_models(profile: Optional[str] = None, engine: Optional[str] = None) -> List[str]:
    """Return models available for the selected auth profile OR engine.

    Priority:
    1) If `openclaw` CLI is available:
       - If profile provided: `openclaw models list --json --profile <key>`
       - If engine provided: `openclaw <engine> models list --json`
    2) If `openclaw` not available, try specific CLI:
       - `codex models list --json`
       - `claude models list --json`
       - ...
    3) Fallback: read cached provider models from `~/.openclaw/openclaw.json` (only if profile provided).

    Notes:
    - We NEVER return secrets.
    """

    openclaw_path = shutil.which(settings.openclaw_bin)
    
    # 1) Try via OpenClaw CLI first (unified tool)
    if openclaw_path:
        cmd = [openclaw_path]
        if engine and engine != "codex":
             # e.g. "openclaw claude models list"
             cmd.extend([engine, "models", "list", "--json"])
        else:
             # Default to "openclaw models list" (usually implies codex or default context)
             # But if engine is codex, we can be explicit: "openclaw codex models list"
             if engine == "codex":
                 cmd.extend(["codex", "models", "list", "--json"])
             else:
                 cmd.extend(["models", "list", "--json"])
        
        if profile:
            cmd.extend(["--profile", profile])

        output = await run_command(cmd)
        if output:
            models = _parse_models_json(output)
            if models:
                return models

    # 2) Fallback to standalone CLIs if openclaw didn't work or isn't present
    #    (Only if no profile is involved, as profiles are openclaw-specific)
    if not profile and engine:
        bin_path = shutil.which(engine)
        if bin_path:
            output = await run_command([bin_path, "models", "list", "--json"])
            if output:
                 models = _parse_models_json(output)
                 if models:
                     return models

    # 3) Fallback: derive provider from profile key and use cached models in openclaw.json.
    if not profile:
        return []

    config_path = Path.home() / ".openclaw" / "openclaw.json"
    if not config_path.exists():
        return []

    try:
        cfg = json.loads(config_path.read_text(encoding="utf-8"))
    except Exception:
        return []

    profile_meta = ((cfg.get("auth") or {}).get("profiles") or {}).get(profile)
    if not isinstance(profile_meta, dict):
        return []

    provider = str(profile_meta.get("provider") or "").strip()
    if not provider:
        return []

    providers_cfg = (cfg.get("models") or {}).get("providers")
    if not isinstance(providers_cfg, dict):
        return []

    provider_cfg = providers_cfg.get(provider)
    if not isinstance(provider_cfg, dict):
        return []

    cached = provider_cfg.get("models")
    if not isinstance(cached, list):
        return []

    out: List[str] = []
    for item in cached:
        if isinstance(item, str):
            out.append(item)
        elif isinstance(item, dict):
            mid = item.get("id") or item.get("name") or item.get("model")
            if isinstance(mid, str) and mid:
                out.append(mid)

    return [m for m in out if m]


def _parse_models_json(json_str: str) -> List[str]:
    try:
        data = json.loads(json_str)
    except json.JSONDecodeError:
        return []

    models: List[str] = []
    if isinstance(data, list):
        for item in data:
            if isinstance(item, str):
                models.append(item)
            elif isinstance(item, dict):
                val = item.get("id") or item.get("name") or item.get("model")
                if isinstance(val, str) and val:
                    models.append(val)
    return models
