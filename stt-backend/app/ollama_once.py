from __future__ import annotations

import json
import os
import sys

import requests


def main() -> int:
    if len(sys.argv) < 3:
        print("usage: ollama_once.py MODEL PROMPT", file=sys.stderr)
        return 2

    model = sys.argv[1]
    prompt = sys.argv[2]
    base_url = os.getenv("OLLAMA_BASE_URL", "http://127.0.0.1:11434").rstrip("/")

    sentence_terminators = (".", "!", "?")
    flush_after = 40

    try:
        with requests.post(
            f"{base_url}/api/generate",
            json={
                "model": model,
                "prompt": prompt,
                "stream": True,
                "options": {
                    "temperature": 0.3,
                    "num_ctx": 4096,
                },
            },
            stream=True,
            timeout=300,
        ) as response:
            response.raise_for_status()

            buffer = ""
            for raw in response.iter_lines(decode_unicode=True):
                if not raw:
                    continue
                try:
                    chunk = json.loads(raw)
                except json.JSONDecodeError:
                    continue

                delta = str(chunk.get("response") or "")
                if delta:
                    buffer += delta

                    stripped = buffer.rstrip()
                    if stripped.endswith(sentence_terminators):
                        sys.stdout.write(buffer + "\n")
                        sys.stdout.flush()
                        buffer = ""
                    elif len(buffer) >= flush_after and " " in buffer:
                        cut = buffer.rfind(" ")
                        if cut > 0:
                            sys.stdout.write(buffer[:cut] + "\n")
                            sys.stdout.flush()
                            buffer = buffer[cut + 1:]

                if chunk.get("done"):
                    if buffer:
                        sys.stdout.write(buffer + "\n")
                        sys.stdout.flush()
                        buffer = ""
                    break

            if buffer:
                sys.stdout.write(buffer + "\n")
                sys.stdout.flush()

    except requests.HTTPError as exc:
        print(f"Ollama HTTP error: {exc}", file=sys.stderr)
        return 1
    except requests.RequestException as exc:
        print(f"Ollama request failed: {exc}", file=sys.stderr)
        return 1

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
