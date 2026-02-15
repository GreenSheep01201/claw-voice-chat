from __future__ import annotations

import asyncio
import json
import shlex
import shutil
from contextlib import suppress
from time import perf_counter
from typing import Any, AsyncIterator, Callable

from app.config import settings


class CodexMcpSession:
    def __init__(self, profile: str | None = None) -> None:
        self._proc: asyncio.subprocess.Process | None = None
        self._reader_task: asyncio.Task[None] | None = None
        self._stderr_task: asyncio.Task[None] | None = None
        self._pending: dict[int, asyncio.Future[dict[str, Any]]] = {}
        self._events: asyncio.Queue[dict[str, Any]] = asyncio.Queue()
        self._stderr_chunks: list[str] = []
        self._write_lock = asyncio.Lock()
        self._turn_lock = asyncio.Lock()
        self._next_request_id = 1
        self._thread_id: str | None = None
        self._startup_ms: int | None = None
        self._profile = profile

    @property
    def has_thread(self) -> bool:
        return bool(self._thread_id)

    @property
    def startup_ms(self) -> int | None:
        return self._startup_ms

    async def reset(self) -> None:
        self._thread_id = None

    async def close(self) -> None:
        # Cancel pending futures so asyncio doesn't warn about un-retrieved exceptions
        # when we intentionally shut the MCP transport down.
        for future in self._pending.values():
            if not future.done():
                future.cancel()
        self._pending.clear()

        reader_task = self._reader_task
        stderr_task = self._stderr_task
        self._reader_task = None
        self._stderr_task = None

        proc = self._proc
        self._proc = None

        if reader_task and not reader_task.done():
            reader_task.cancel()
        if stderr_task and not stderr_task.done():
            stderr_task.cancel()

        if proc is not None:
            if proc.stdin is not None:
                with suppress(Exception):
                    proc.stdin.close()

            if proc.returncode is None:
                with suppress(Exception):
                    proc.terminate()
                with suppress(Exception):
                    await asyncio.wait_for(proc.wait(), timeout=1.0)

            if proc.returncode is None:
                with suppress(Exception):
                    proc.kill()
                with suppress(Exception):
                    await proc.wait()

        if reader_task:
            with suppress(asyncio.CancelledError, Exception):
                await reader_task
        if stderr_task:
            with suppress(asyncio.CancelledError, Exception):
                await stderr_task

        self._thread_id = None

    async def start(self) -> None:
        if self._proc is not None and self._proc.returncode is None:
            return

        cmd = build_codex_mcp_command(self._profile)
        startup_start = perf_counter()

        try:
            proc = await asyncio.create_subprocess_exec(
                *cmd,
                stdin=asyncio.subprocess.PIPE,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
        except FileNotFoundError as exc:
            raise RuntimeError(f"MCP command not found: {cmd[0]}") from exc

        if proc.stdin is None or proc.stdout is None:
            with suppress(Exception):
                proc.terminate()
            raise RuntimeError("Codex MCP process has no stdio streams")

        self._stderr_chunks.clear()
        self._proc = proc
        self._reader_task = asyncio.create_task(self._reader_loop())
        self._stderr_task = asyncio.create_task(_collect_stream(proc.stderr, self._stderr_chunks))

        protocol_version = settings.codex_mcp_protocol_version.strip() or "2025-03-26"
        timeout_sec = settings.codex_mcp_startup_timeout_sec

        try:
            init_response = await self._request(
                "initialize",
                {
                    "protocolVersion": protocol_version,
                    "capabilities": {},
                    "clientInfo": {"name": "claw-voice-chat", "version": "0.1.0"},
                },
                timeout_sec=timeout_sec,
            )
            if not isinstance(init_response.get("result"), dict):
                raise RuntimeError("Codex MCP initialize response missing result object")

            await self._notify("notifications/initialized", {})
            tools_response = await self._request("tools/list", {}, timeout_sec=timeout_sec)
            _ensure_codex_mcp_tools_available(tools_response)
        except Exception:
            await self.close()
            raise

        self._startup_ms = int((perf_counter() - startup_start) * 1000)

    async def stream_turn(self, prompt: str, model: str | None = None) -> AsyncIterator[str]:
        user_prompt = prompt.strip()
        if not user_prompt:
            return

        await self.start()

        async with self._turn_lock:
            request_params = _build_mcp_call_tool_params(
                prompt=user_prompt,
                thread_id=self._thread_id,
                model=model,
            )
            request_id, response_future = await self._start_request("tools/call", request_params)

            emitted_text = ""
            saw_content_delta = False

            while True:
                if response_future.done():
                    break

                try:
                    event = await asyncio.wait_for(self._events.get(), timeout=0.05)
                except asyncio.TimeoutError:
                    continue

                if not _mcp_event_matches_request(event, request_id):
                    continue

                delta, emitted_text, saw_content_delta = extract_mcp_delta(
                    event=event,
                    emitted_text=emitted_text,
                    saw_content_delta=saw_content_delta,
                )
                if delta:
                    yield delta

            response = await self._await_response(
                request_id=request_id,
                response_future=response_future,
                method="tools/call",
                timeout_sec=settings.codex_mcp_request_timeout_sec,
            )

            thread_id, final_text = parse_mcp_call_tool_response(response)
            if thread_id:
                self._thread_id = thread_id

            if final_text:
                delta, emitted_text = _append_only_new_text(emitted_text, final_text)
                if delta:
                    yield delta

    async def _reader_loop(self) -> None:
        proc = self._proc
        if proc is None or proc.stdout is None:
            return

        while True:
            raw_line = await proc.stdout.readline()
            if not raw_line:
                break

            line = raw_line.decode("utf-8", errors="ignore").strip()
            if not line:
                continue

            message = _safe_json_loads(line)
            if not message:
                continue

            await self._route_incoming_message(message)

        self._fail_pending(RuntimeError(self._process_exit_message()))

    async def _route_incoming_message(self, message: dict[str, Any]) -> None:
        if "method" in message and "id" in message:
            await self._handle_server_request(message)
            return

        if "id" in message and ("result" in message or "error" in message):
            request_id = _coerce_request_id(message.get("id"))
            if request_id is None:
                return

            future = self._pending.pop(request_id, None)
            if future is not None and not future.done():
                future.set_result(message)
            return

        method = str(message.get("method") or "")
        if method == "codex/event":
            await self._events.put(message)

    async def _handle_server_request(self, message: dict[str, Any]) -> None:
        request_id = message.get("id")
        if request_id is None:
            return

        method = str(message.get("method") or "")
        if method == "elicitation/create":
            await self._write_message(
                {
                    "jsonrpc": "2.0",
                    "id": request_id,
                    "result": {"decision": "denied"},
                }
            )
            return

        await self._write_message(
            {
                "jsonrpc": "2.0",
                "id": request_id,
                "error": {
                    "code": -32601,
                    "message": f"Unsupported MCP server request: {method}",
                },
            }
        )

    async def _request(
        self,
        method: str,
        params: dict[str, Any] | None,
        timeout_sec: float | None = None,
    ) -> dict[str, Any]:
        request_id, future = await self._start_request(method, params)
        return await self._await_response(request_id, future, method, timeout_sec=timeout_sec)

    async def _start_request(
        self,
        method: str,
        params: dict[str, Any] | None,
    ) -> tuple[int, asyncio.Future[dict[str, Any]]]:
        loop = asyncio.get_running_loop()
        request_id = self._next_request_id
        self._next_request_id += 1

        future: asyncio.Future[dict[str, Any]] = loop.create_future()
        self._pending[request_id] = future

        payload: dict[str, Any] = {
            "jsonrpc": "2.0",
            "id": request_id,
            "method": method,
        }
        if params is not None:
            payload["params"] = params

        try:
            await self._write_message(payload)
        except Exception as exc:
            self._pending.pop(request_id, None)
            if not future.done():
                future.set_exception(exc)
            raise RuntimeError(f"Failed to send MCP request {method}: {exc}") from exc

        return request_id, future

    async def _await_response(
        self,
        request_id: int,
        response_future: asyncio.Future[dict[str, Any]],
        method: str,
        timeout_sec: float | None = None,
    ) -> dict[str, Any]:
        timeout = timeout_sec if timeout_sec is not None else settings.codex_mcp_request_timeout_sec
        try:
            response = await asyncio.wait_for(response_future, timeout=timeout)
        except asyncio.TimeoutError as exc:
            self._pending.pop(request_id, None)
            raise RuntimeError(f"MCP request timed out for {method}") from exc

        error = response.get("error")
        if isinstance(error, dict):
            message = str(error.get("message") or error)
            raise RuntimeError(f"MCP {method} failed: {message}")

        if "result" not in response:
            raise RuntimeError(f"MCP {method} returned no result")

        return response

    async def _notify(self, method: str, params: dict[str, Any] | None = None) -> None:
        payload: dict[str, Any] = {"jsonrpc": "2.0", "method": method}
        if params is not None:
            payload["params"] = params
        await self._write_message(payload)

    async def _write_message(self, payload: dict[str, Any]) -> None:
        proc = self._proc
        if proc is None or proc.stdin is None:
            raise RuntimeError("MCP process is not running")

        line = json.dumps(payload, ensure_ascii=False, separators=(",", ":")) + "\n"
        data = line.encode("utf-8")

        async with self._write_lock:
            proc.stdin.write(data)
            await proc.stdin.drain()

    def _fail_pending(self, error: Exception) -> None:
        for future in self._pending.values():
            if not future.done():
                future.set_exception(error)
        self._pending.clear()

    def _process_exit_message(self) -> str:
        proc = self._proc
        if proc is not None and proc.returncode is not None:
            base = f"Codex MCP process exited with code {proc.returncode}"
        else:
            base = "Codex MCP process exited unexpectedly"

        stderr_text = "".join(self._stderr_chunks).strip()
        if stderr_text:
            tail = stderr_text[-300:]
            return f"{base}: {tail}"
        return base


class OpenClawClient:
    def __init__(
        self,
        mcp_session_factory: Callable[[], CodexMcpSession] | None = None,
        *,
        own_mcp_session: bool = True,
        model: str | None = None,
        profile: str | None = None,
        engine: str | None = None,
    ) -> None:
        self._model = model if model is not None else settings.codex_model.strip()
        self._profile = profile
        self._engine = engine
        
        # Only use MCP if explicitly enabled AND we are using the default engine (codex) or no engine specified.
        # Different engines (claude/gemini) might not support the same MCP protocol or command structure yet.
        is_codex = (not self._engine) or (self._engine == "codex")
        self._prefer_mcp = settings.codex_mcp_enabled and not settings.llm_command.strip() and is_codex
        
        self._mcp_session_factory = mcp_session_factory or CodexMcpSession
        self._mcp_session: CodexMcpSession | None = None
        self._own_mcp_session = own_mcp_session
        self._mcp_disabled_reason: str | None = None
        self._last_transport = "exec"
        self._last_mcp_startup_ms: int | None = None

    @property
    def model_label(self) -> str:
        label = self._model or "default"
        if self._engine:
            return f"{self._engine}:{label}"
        return label

    @property
    def last_transport(self) -> str:
        return self._last_transport

    @property
    def last_mcp_startup_ms(self) -> int | None:
        return self._last_mcp_startup_ms

    async def close(self) -> None:
        if self._mcp_session is not None and self._own_mcp_session:
            await self._mcp_session.close()
        self._mcp_session = None

    async def reset(self) -> None:
        if self._mcp_session is not None:
            await self._mcp_session.reset()

    async def stream_chat(self, messages: list[dict[str, str]]) -> AsyncIterator[str]:
        if self._prefer_mcp and self._mcp_disabled_reason is None:
            emitted_any = False
            try:
                async for delta in self._stream_chat_via_mcp(messages):
                    emitted_any = emitted_any or bool(delta)
                    yield delta
                return
            except Exception as exc:
                if emitted_any:
                    raise
                await self._disable_mcp(exc)

        async for delta in self._stream_chat_via_exec(messages):
            yield delta

    async def _disable_mcp(self, exc: Exception) -> None:
        self._mcp_disabled_reason = str(exc)
        if self._mcp_session is not None:
            await self._mcp_session.close()
            self._mcp_session = None

    async def _stream_chat_via_mcp(self, messages: list[dict[str, str]]) -> AsyncIterator[str]:
        if self._mcp_session is None:
            if self._mcp_session_factory == CodexMcpSession:
                self._mcp_session = CodexMcpSession(profile=self._profile)
            else:
                self._mcp_session = self._mcp_session_factory()

        await self._mcp_session.start()

        if self._mcp_session.has_thread:
            prompt = _latest_user_message(messages) or build_codex_prompt(messages)
        else:
            prompt = build_codex_prompt(messages)

        self._last_transport = "mcp"
        self._last_mcp_startup_ms = self._mcp_session.startup_ms

        async for delta in self._mcp_session.stream_turn(prompt=prompt, model=self._model or None):
            yield delta

    async def _stream_chat_via_exec(self, messages: list[dict[str, str]]) -> AsyncIterator[str]:
        prompt = build_codex_prompt(messages)
        cmd = build_llm_command(prompt, model=self._model, profile=self._profile, engine=self._engine)
        expect_json = "--json" in cmd
        self._last_transport = "exec"
        self._last_mcp_startup_ms = None

        try:
            proc = await asyncio.create_subprocess_exec(
                *cmd,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
        except FileNotFoundError as exc:
            raise RuntimeError(f"LLM command not found: {cmd[0]}") from exc

        if proc.stdout is None:
            raise RuntimeError("LLM command has no stdout stream")

        stderr_chunks: list[str] = []
        stderr_task = asyncio.create_task(_collect_stream(proc.stderr, stderr_chunks))

        emitted_text = ""
        return_code = 0
        try:
            while True:
                raw_line = await proc.stdout.readline()
                if not raw_line:
                    break

                line = raw_line.decode("utf-8", errors="ignore").strip()
                if not line:
                    continue

                if not expect_json:
                    chunk = f"{line}\n"
                    emitted_text += chunk
                    yield chunk
                    continue

                event = _safe_json_loads(line)
                if not event:
                    continue

                delta, emitted_text = extract_agent_delta(event, emitted_text)
                if delta:
                    yield delta

            return_code = await proc.wait()
        finally:
            await stderr_task

        if return_code != 0:
            stderr_text = "".join(stderr_chunks).strip() or f"exit code {return_code}"
            raise RuntimeError(f"Codex command failed: {stderr_text}")


def _safe_json_loads(value: str) -> dict[str, Any] | None:
    try:
        parsed = json.loads(value)
    except json.JSONDecodeError:
        return None
    return parsed if isinstance(parsed, dict) else None


def build_codex_prompt(messages: list[dict[str, str]]) -> str:
    conversation: list[dict[str, str]] = []
    for message in messages:
        role = str(message.get("role") or "").strip().lower()
        content = str(message.get("content") or "").strip()
        if not role or not content:
            continue
        conversation.append({"role": role, "content": content})

    conversation_json = json.dumps(conversation, ensure_ascii=False)
    return (
        "You are the assistant for Claw-Voice-Chat.\n"
        "Read the conversation JSON below and output ONLY the next assistant reply.\n"
        "ABSOLUTE RULES:\n"
        "- Output ONLY the final answer text the user should see.\n"
        "- Do NOT include planning, intentions, or meta commentary (e.g., 'I will ...', 'I am going to ...').\n"
        "- Do NOT include timing/latency logs (e.g., 'timing', 'ttfb', 'total').\n"
        "- Do NOT include role labels, markdown code fences, or analysis sections.\n\n"
        f"conversation={conversation_json}"
    )


def build_llm_command(
    prompt: str, 
    model: str | None = None, 
    profile: str | None = None, 
    engine: str | None = None
) -> list[str]:
    custom_command = settings.llm_command.strip()
    if custom_command:
        parts = shlex.split(custom_command)
        return _inject_prompt(parts, prompt)

    # Determine base command based on engine
    command = []
    openclaw_bin = settings.openclaw_bin.strip()
    has_openclaw = openclaw_bin and _command_exists(openclaw_bin)
    
    if engine and engine != "codex":
        # Specific engine (claude/gemini/etc)
        # NOTE: the upstream `gemini` CLI does NOT support `exec --json`, so we run it in
        # plain-text mode (no --json) and stream lines.
        if engine == "gemini":
            if has_openclaw:
                # Prefer OpenClaw's gemini runner if available.
                command = [openclaw_bin, "gemini", "exec"]
            else:
                # Fallback to gemini CLI (best-effort; may differ by installation).
                command = ["gemini"]
        else:
            if has_openclaw:
                # openclaw <engine> exec --json
                command = [openclaw_bin, engine, "exec", "--json"]
            else:
                # <engine> exec --json (fallback)
                command = [engine, "exec", "--json"]
    else:
        # Default / Codex
        if has_openclaw:
            command = [openclaw_bin, "codex", "exec", "--json"]
        else:
            command = [settings.codex_bin, "exec", "--json"]

    actual_model = model if model else settings.codex_model.strip()
    # Only add model/profile flags when we are using the OpenClaw-style CLI.
    # The standalone `gemini` CLI may not support these flags.
    if actual_model and command and command[0] == openclaw_bin:
        command.extend(["--model", actual_model])

    if profile and command and command[0] == openclaw_bin:
        command.extend(["--profile", profile])

    # Only add extra args if using codex/default engine, 
    # as other engines might not support the same flags.
    if (not engine or engine == "codex"):
        extra_args = settings.codex_extra_args.strip()
        if extra_args:
            command.extend(shlex.split(extra_args))

    command.append(prompt)
    return command


def build_codex_mcp_command(profile: str | None = None) -> list[str]:
    openclaw_bin = settings.openclaw_bin.strip()
    if openclaw_bin and _command_exists(openclaw_bin):
        cmd = [openclaw_bin, "codex", "mcp-server"]
        if profile:
            cmd.extend(["--profile", profile])
        return cmd
    return [settings.codex_bin, "mcp-server"]


def extract_agent_delta(event: dict[str, Any], emitted_text: str) -> tuple[str, str]:
    event_type = _normalize_event_name(event.get("type"))

    item = event.get("item")
    if isinstance(item, dict):
        item_text = _extract_agent_message_item_text(item)
        if item_text:
            return _append_only_new_text(emitted_text, item_text)

    if event_type in {"agent_message_delta", "agent_message_content_delta"}:
        delta = event.get("delta")
        if isinstance(delta, str) and delta:
            return delta, emitted_text + delta

    if event_type in {"agent_message"}:
        text = event.get("message")
        if isinstance(text, str):
            return _append_only_new_text(emitted_text, text)

    if event_type in {"task_complete", "turn_complete"}:
        text = event.get("last_agent_message")
        if isinstance(text, str):
            return _append_only_new_text(emitted_text, text)

    return "", emitted_text


def extract_mcp_delta(
    event: dict[str, Any],
    emitted_text: str,
    saw_content_delta: bool,
) -> tuple[str, str, bool]:
    params = event.get("params")
    if not isinstance(params, dict):
        return "", emitted_text, saw_content_delta

    msg = params.get("msg")
    if not isinstance(msg, dict):
        return "", emitted_text, saw_content_delta

    event_type = _normalize_event_name(msg.get("type"))

    if event_type == "agent_message_content_delta":
        saw_content_delta = True
        delta = msg.get("delta")
        if isinstance(delta, str) and delta:
            return delta, emitted_text + delta, saw_content_delta
        return "", emitted_text, saw_content_delta

    if event_type == "agent_message_delta":
        if saw_content_delta:
            return "", emitted_text, saw_content_delta
        delta = msg.get("delta")
        if isinstance(delta, str) and delta:
            return delta, emitted_text + delta, saw_content_delta
        return "", emitted_text, saw_content_delta

    if event_type == "item_completed":
        item = msg.get("item")
        if isinstance(item, dict):
            item_text = _extract_agent_message_item_text(item)
            if item_text:
                delta, updated = _append_only_new_text(emitted_text, item_text)
                return delta, updated, saw_content_delta

    if event_type in {"task_complete", "turn_complete"}:
        text = msg.get("last_agent_message")
        if isinstance(text, str):
            delta, updated = _append_only_new_text(emitted_text, text)
            return delta, updated, saw_content_delta

    if event_type == "agent_message":
        text = msg.get("message")
        if isinstance(text, str):
            delta, updated = _append_only_new_text(emitted_text, text)
            return delta, updated, saw_content_delta

    return "", emitted_text, saw_content_delta


def parse_mcp_call_tool_response(response: dict[str, Any]) -> tuple[str | None, str]:
    result = response.get("result")
    if not isinstance(result, dict):
        return None, ""

    thread_id: str | None = None
    text = ""

    structured = result.get("structuredContent")
    if isinstance(structured, dict):
        maybe_thread_id = structured.get("threadId")
        if isinstance(maybe_thread_id, str) and maybe_thread_id:
            thread_id = maybe_thread_id

        structured_text = structured.get("content")
        if isinstance(structured_text, str):
            text = structured_text

    if not text:
        content = result.get("content")
        if isinstance(content, list):
            chunks: list[str] = []
            for block in content:
                if not isinstance(block, dict):
                    continue
                if _normalize_token(block.get("type")) != "text":
                    continue
                block_text = block.get("text")
                if isinstance(block_text, str):
                    chunks.append(block_text)
            text = "".join(chunks)

    return thread_id, text


async def _collect_stream(stream: asyncio.StreamReader | None, chunks: list[str]) -> None:
    if stream is None:
        return

    while True:
        data = await stream.readline()
        if not data:
            return
        chunks.append(data.decode("utf-8", errors="ignore"))


def _default_codex_command() -> list[str]:
    openclaw_bin = settings.openclaw_bin.strip()
    if openclaw_bin and _command_exists(openclaw_bin):
        return [openclaw_bin, "codex", "exec", "--json"]
    return [settings.codex_bin, "exec", "--json"]


def _command_exists(command: str) -> bool:
    return shutil.which(command) is not None


def _inject_prompt(parts: list[str], prompt: str) -> list[str]:
    if not parts:
        raise RuntimeError("OPENCLAW_LLM_COMMAND is empty after parsing")

    rendered: list[str] = []
    has_placeholder = False
    for part in parts:
        if "{prompt}" in part:
            rendered.append(part.replace("{prompt}", prompt))
            has_placeholder = True
            continue
        rendered.append(part)

    if not has_placeholder:
        rendered.append(prompt)
    return rendered


def _append_only_new_text(previous: str, current: str) -> tuple[str, str]:
    if not current:
        return "", previous
    if current.startswith(previous):
        return current[len(previous) :], current
    return current, current


def _normalize_event_name(value: Any) -> str:
    if not isinstance(value, str):
        return ""
    return value.strip().lower().replace("-", "_").replace(".", "_")


def _normalize_token(value: Any) -> str:
    if not isinstance(value, str):
        return ""
    return "".join(ch for ch in value.strip().lower() if ch.isalnum())


def _extract_agent_message_item_text(item: dict[str, Any]) -> str:
    if _normalize_token(item.get("type")) != "agentmessage":
        return ""

    content = item.get("content")
    if isinstance(content, list):
        chunks: list[str] = []
        for entry in content:
            if not isinstance(entry, dict):
                continue
            if _normalize_token(entry.get("type")) != "text":
                continue
            text = entry.get("text")
            if isinstance(text, str):
                chunks.append(text)
        if chunks:
            return "".join(chunks)

    text = item.get("text")
    if isinstance(text, str):
        return text
    return ""


def _latest_user_message(messages: list[dict[str, str]]) -> str:
    for message in reversed(messages):
        role = str(message.get("role") or "").strip().lower()
        content = str(message.get("content") or "").strip()
        if role == "user" and content:
            return content
    return ""


def _coerce_request_id(value: Any) -> int | None:
    if isinstance(value, int):
        return value
    if isinstance(value, str):
        with suppress(ValueError):
            return int(value)
    return None


def _build_mcp_call_tool_params(prompt: str, thread_id: str | None, model: str | None) -> dict[str, Any]:
    if thread_id:
        return {
            "name": "codex-reply",
            "arguments": {
                "threadId": thread_id,
                "prompt": prompt,
            },
        }

    arguments: dict[str, Any] = {"prompt": prompt}
    if model:
        arguments["model"] = model

    sandbox = settings.codex_mcp_sandbox.strip()
    if sandbox:
        arguments["sandbox"] = sandbox

    approval_policy = settings.codex_mcp_approval_policy.strip()
    if approval_policy:
        arguments["approval-policy"] = approval_policy

    return {"name": "codex", "arguments": arguments}


def _mcp_event_matches_request(event: dict[str, Any], request_id: int) -> bool:
    params = event.get("params")
    if not isinstance(params, dict):
        return False

    meta = params.get("_meta")
    if not isinstance(meta, dict):
        return True

    request_id_value = _coerce_request_id(meta.get("requestId"))
    if request_id_value is None:
        return True
    return request_id_value == request_id


def _ensure_codex_mcp_tools_available(response: dict[str, Any]) -> None:
    result = response.get("result")
    if not isinstance(result, dict):
        raise RuntimeError("MCP tools/list missing result object")

    tools = result.get("tools")
    if not isinstance(tools, list):
        raise RuntimeError("MCP tools/list returned no tool list")

    names = {
        str(item.get("name") or "")
        for item in tools
        if isinstance(item, dict)
    }
    if "codex" not in names:
        raise RuntimeError("MCP server does not expose 'codex' tool")
