from __future__ import annotations

import os
from dataclasses import dataclass
import json
from typing import (
    Dict,
    Iterable,
    Iterator,
    List,
    Optional,
    Protocol,
    TypedDict,
)

from urllib.error import HTTPError
from urllib.request import Request, urlopen

from .settings import settings


class ChatMessage(TypedDict):
    role: str
    content: str


@dataclass(frozen=True)
class LLMPreferences:
    provider: str = "none"
    model: Optional[str] = None
    temperature: float = 0.2
    max_tokens: int = 512


class LLMProvider(Protocol):
    name: str
    requires_confirm_send: bool

    def generate(
        self,
        *,
        messages: List[ChatMessage],
        prefs: LLMPreferences,
        confirm_send: bool,
    ) -> str: ...

    def stream_generate(
        self,
        *,
        messages: List[ChatMessage],
        prefs: LLMPreferences,
        confirm_send: bool,
    ) -> Iterator[str]: ...


class FakeProvider:
    name = "fake"
    requires_confirm_send = False

    def generate(
        self,
        *,
        messages: List[ChatMessage],
        prefs: LLMPreferences,
        confirm_send: bool,
    ) -> str:
        last_user = ""
        for m in messages:
            if m.get("role") == "user":
                last_user = str(m.get("content") or "")
        return f"[FAKE:{prefs.model or 'default'}] {last_user}".strip()

    def stream_generate(
        self,
        *,
        messages: List[ChatMessage],
        prefs: LLMPreferences,
        confirm_send: bool,
    ) -> Iterator[str]:
        text = self.generate(
            messages=messages,
            prefs=prefs,
            confirm_send=confirm_send,
        )
        for part in _iter_text_parts(text, part_size=16):
            yield part


class OpenAICompatibleProvider:
    def __init__(
        self,
        *,
        name: str,
        base_url: str,
        default_model: str,
        api_key: str = "",
        requires_confirm_send: bool = False,
        require_enabled: bool = False,
    ) -> None:
        self.name = name
        self.requires_confirm_send = requires_confirm_send
        self._base_url = str(base_url or "").rstrip("/")
        self._default_model = str(default_model or "")
        self._api_key = str(api_key or "")
        self._require_enabled = bool(require_enabled)

    def _timeout_seconds(self) -> int:
        try:
            return max(5, int(os.getenv("LLM_REQUEST_TIMEOUT_SECONDS", "600")))
        except Exception:
            return 600

    def _assert_allowed(self) -> None:
        if self._require_enabled and not bool(settings.enable_cloud_llm):
            raise RuntimeError("CLOUD_LLM_DISABLED")
        if self._require_enabled and not self._api_key:
            raise RuntimeError("CLOUD_LLM_API_KEY_MISSING")

    def _assert_confirmed(self, confirm_send: bool) -> None:
        if self.requires_confirm_send and not bool(confirm_send):
            raise RuntimeError("CONFIRM_SEND_REQUIRED")

    def _chat_completions_url(self) -> str:
        return f"{self._base_url}/chat/completions"

    def _headers(self) -> Dict[str, str]:
        headers = {
            "Content-Type": "application/json",
        }
        if self._api_key:
            headers["Authorization"] = f"Bearer {self._api_key}"
        return headers

    def generate(
        self,
        *,
        messages: List[ChatMessage],
        prefs: LLMPreferences,
        confirm_send: bool,
    ) -> str:
        self._assert_allowed()
        self._assert_confirmed(confirm_send)
        model = str(prefs.model or self._default_model)
        payload = {
            "model": model,
            "messages": messages,
            "temperature": float(prefs.temperature),
            "max_tokens": int(prefs.max_tokens),
            "stream": False,
        }
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        req = Request(
            self._chat_completions_url(),
            data=body,
            headers=self._headers(),
            method="POST",
        )
        try:
            with urlopen(req, timeout=self._timeout_seconds()) as resp:
                raw = resp.read().decode("utf-8", errors="replace")
        except HTTPError as e:
            raw = e.read().decode("utf-8", errors="replace")
            raise RuntimeError(f"LLM_HTTP_{e.code}:{raw}")
        except TimeoutError as e:
            raise RuntimeError("LLM_TIMEOUT") from e
        except Exception as e:
            raise RuntimeError(
                f"LLM_REQUEST_FAILED:{type(e).__name__}:{e}"
            ) from e

        obj = json.loads(raw or "{}")
        choices = obj.get("choices") or []
        if not choices:
            return ""
        msg = (choices[0] or {}).get("message") or {}
        return str(msg.get("content") or "")

    def stream_generate(
        self,
        *,
        messages: List[ChatMessage],
        prefs: LLMPreferences,
        confirm_send: bool,
    ) -> Iterator[str]:
        self._assert_allowed()
        self._assert_confirmed(confirm_send)
        model = str(prefs.model or self._default_model)
        payload = {
            "model": model,
            "messages": messages,
            "temperature": float(prefs.temperature),
            "max_tokens": int(prefs.max_tokens),
            "stream": True,
        }
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        req = Request(
            self._chat_completions_url(),
            data=body,
            headers=self._headers(),
            method="POST",
        )

        try:
            resp = urlopen(req, timeout=self._timeout_seconds())
        except HTTPError as e:
            raw = e.read().decode("utf-8", errors="replace")
            raise RuntimeError(f"LLM_HTTP_{e.code}:{raw}")
        except TimeoutError as e:
            raise RuntimeError("LLM_TIMEOUT") from e
        except Exception as e:
            raise RuntimeError(
                f"LLM_REQUEST_FAILED:{type(e).__name__}:{e}"
            ) from e

        with resp:
            while True:
                line = resp.readline()
                if not line:
                    break

                s = line.decode("utf-8", errors="replace").strip()
                if not s:
                    continue
                if not s.startswith("data:"):
                    continue

                data = s[len("data:"):].strip()
                if data == "[DONE]":
                    break

                try:
                    obj = json.loads(data)
                except Exception:
                    continue

                choices = obj.get("choices") or []
                if not choices:
                    continue
                delta = (choices[0] or {}).get("delta") or {}
                part = delta.get("content")
                if part is None:
                    continue
                yield str(part)


_PROVIDERS: Dict[str, LLMProvider] = {
    "fake": FakeProvider(),
    "openai_local": OpenAICompatibleProvider(
        name="openai_local",
        base_url=settings.llm_local_base_url,
        default_model=settings.llm_local_model,
        requires_confirm_send=False,
        require_enabled=False,
    ),
    "openai_cloud": OpenAICompatibleProvider(
        name="openai_cloud",
        base_url=settings.llm_cloud_base_url,
        default_model=settings.llm_cloud_model,
        api_key=settings.llm_cloud_api_key,
        requires_confirm_send=True,
        require_enabled=True,
    ),
}


def list_providers() -> List[str]:
    return sorted(_PROVIDERS.keys())


def get_provider(name: str) -> Optional[LLMProvider]:
    return _PROVIDERS.get((name or "").strip())


def _iter_text_parts(text: str, part_size: int = 16) -> Iterable[str]:
    s = str(text or "")
    n = max(1, int(part_size))
    for i in range(0, len(s), n):
        yield s[i:i + n]
