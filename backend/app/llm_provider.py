from __future__ import annotations

from dataclasses import dataclass
from typing import (
    Dict,
    Iterable,
    Iterator,
    List,
    Optional,
    Protocol,
    TypedDict,
)


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


_PROVIDERS: Dict[str, LLMProvider] = {
    "fake": FakeProvider(),
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
