import os
import threading
import time
from contextlib import contextmanager
from typing import Any, Dict, Iterator, Optional


class DynamicSemaphore:
    def __init__(self, max_value: int) -> None:
        self._cond = threading.Condition()
        self._max = max(0, int(max_value))
        self._in_use = 0

    def max_value(self) -> int:
        with self._cond:
            return int(self._max)

    def set_max_value(self, max_value: int) -> None:
        new_max = max(0, int(max_value))
        with self._cond:
            self._max = new_max
            self._cond.notify_all()

    def acquire(self, timeout_seconds: Optional[float] = None) -> bool:
        deadline: Optional[float] = None
        if timeout_seconds is not None:
            deadline = time.monotonic() + float(timeout_seconds)

        with self._cond:
            while True:
                if self._max <= 0:
                    return False

                if self._in_use < self._max:
                    self._in_use += 1
                    return True

                if deadline is None:
                    self._cond.wait()
                    continue

                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    return False
                self._cond.wait(timeout=remaining)

    def release(self) -> None:
        with self._cond:
            if self._in_use > 0:
                self._in_use -= 1
                self._cond.notify()

    def in_use(self) -> int:
        with self._cond:
            return int(self._in_use)

    def snapshot(self) -> Dict[str, Any]:
        with self._cond:
            return {
                "max": int(self._max),
                "in_use": int(self._in_use),
            }


_asr_limiter = DynamicSemaphore(1)
_llm_limiter = DynamicSemaphore(1)
_heavy_limiter = DynamicSemaphore(1)


def get_llm_concurrency_timeout_seconds() -> float:
    try:
        raw = os.getenv("LLM_CONCURRENCY_TIMEOUT_SECONDS", "3")
        return max(0.0, float(raw))
    except Exception:
        return 3.0


def get_asr_concurrency_timeout_seconds() -> float:
    try:
        raw = os.getenv("ASR_CONCURRENCY_TIMEOUT_SECONDS", "3")
        return max(0.0, float(raw))
    except Exception:
        return 3.0


def get_heavy_concurrency_timeout_seconds() -> float:
    try:
        raw = os.getenv("HEAVY_CONCURRENCY_TIMEOUT_SECONDS", "3")
        return max(0.0, float(raw))
    except Exception:
        return 3.0


def get_profile_defaults(profile: str) -> Dict[str, Any]:
    name = str(profile or "").strip().lower() or "balanced"
    if name == "cpu":
        return {
            "profile": "cpu",
            "asr_concurrency": 1,
            "llm_concurrency": 1,
            "heavy_concurrency": 1,
            "llm_timeout_seconds": 600,
            "asr_device": "cpu",
            "asr_compute_type": "int8",
        }
    if name in ("gpu", "gpu_recommended"):
        return {
            "profile": "gpu_recommended",
            "asr_concurrency": 1,
            "llm_concurrency": 1,
            "heavy_concurrency": 1,
            "llm_timeout_seconds": 600,
            "asr_device": "cuda",
            "asr_compute_type": "float16",
        }
    return {
        "profile": "balanced",
        "asr_concurrency": 1,
        "llm_concurrency": 1,
        "heavy_concurrency": 1,
        "llm_timeout_seconds": 600,
        "asr_device": "cpu",
        "asr_compute_type": "int8",
    }


def get_effective_runtime_preferences(prefs: Dict[str, Any]) -> Dict[str, Any]:
    profile = str(
        (prefs or {}).get("profile") or "balanced"
    ).strip().lower()
    if profile == "gpu":
        profile = "gpu_recommended"
    base = get_profile_defaults(profile)

    merged: Dict[str, Any] = dict(base)
    if isinstance(prefs, dict):
        merged.update(prefs)

    merged["profile"] = str(
        merged.get("profile") or "balanced"
    ).strip().lower()
    if merged["profile"] == "gpu":
        merged["profile"] = "gpu_recommended"

    try:
        merged["asr_concurrency"] = max(
            0, int(merged.get("asr_concurrency") or 0)
        )
    except Exception:
        merged["asr_concurrency"] = int(base["asr_concurrency"])

    try:
        merged["llm_concurrency"] = max(
            0, int(merged.get("llm_concurrency") or 0)
        )
    except Exception:
        merged["llm_concurrency"] = int(base["llm_concurrency"])

    try:
        merged["heavy_concurrency"] = max(
            0, int(merged.get("heavy_concurrency") or 0)
        )
    except Exception:
        merged["heavy_concurrency"] = int(base["heavy_concurrency"])

    try:
        merged["llm_timeout_seconds"] = max(
            5, int(merged.get("llm_timeout_seconds") or 0)
        )
    except Exception:
        merged["llm_timeout_seconds"] = int(base["llm_timeout_seconds"])

    merged["asr_device"] = str(
        merged.get("asr_device") or base["asr_device"]
    ).strip()
    merged["asr_compute_type"] = str(
        merged.get("asr_compute_type") or base["asr_compute_type"]
    ).strip()

    merged["asr_model"] = str(
        merged.get("asr_model") or os.getenv("ASR_MODEL", "small")
    ).strip()

    return merged


def apply_runtime_preferences(prefs: Dict[str, Any]) -> Dict[str, Any]:
    eff = get_effective_runtime_preferences(prefs)

    _asr_limiter.set_max_value(int(eff.get("asr_concurrency") or 0))
    _llm_limiter.set_max_value(int(eff.get("llm_concurrency") or 0))
    _heavy_limiter.set_max_value(int(eff.get("heavy_concurrency") or 0))

    os.environ["LLM_REQUEST_TIMEOUT_SECONDS"] = str(
        int(eff.get("llm_timeout_seconds") or 600)
    )
    if str(eff.get("asr_device") or "").strip():
        os.environ["ASR_DEVICE"] = str(eff.get("asr_device") or "").strip()
    if str(eff.get("asr_compute_type") or "").strip():
        os.environ["ASR_COMPUTE_TYPE"] = str(
            eff.get("asr_compute_type") or ""
        ).strip()

    if isinstance(prefs, dict) and "asr_model" in prefs:
        raw_model = str(prefs.get("asr_model") or "").strip()
        if raw_model:
            os.environ["ASR_MODEL"] = raw_model
        else:
            os.environ.pop("ASR_MODEL", None)

    return eff


def refresh_runtime_preferences() -> Dict[str, Any]:
    from .repo import get_default_runtime_preferences

    return apply_runtime_preferences(get_default_runtime_preferences())


@contextmanager
def limit_asr(timeout_seconds: Optional[float] = None) -> Iterator[None]:
    if not _asr_limiter.acquire(timeout_seconds=timeout_seconds):
        raise RuntimeError("ASR_CONCURRENCY_TIMEOUT")
    try:
        yield
    finally:
        _asr_limiter.release()


@contextmanager
def limit_llm(timeout_seconds: Optional[float] = None) -> Iterator[None]:
    if not _llm_limiter.acquire(timeout_seconds=timeout_seconds):
        raise RuntimeError("LLM_CONCURRENCY_TIMEOUT")
    try:
        yield
    finally:
        _llm_limiter.release()


@contextmanager
def limit_heavy(timeout_seconds: Optional[float] = None) -> Iterator[None]:
    if not _heavy_limiter.acquire(timeout_seconds=timeout_seconds):
        raise RuntimeError("HEAVY_CONCURRENCY_TIMEOUT")
    try:
        yield
    finally:
        _heavy_limiter.release()


def get_concurrency_diagnostics() -> Dict[str, Any]:
    return {
        "limiters": {
            "asr": _asr_limiter.snapshot(),
            "llm": _llm_limiter.snapshot(),
            "heavy": _heavy_limiter.snapshot(),
        },
        "timeouts": {
            "asr": get_asr_concurrency_timeout_seconds(),
            "llm": get_llm_concurrency_timeout_seconds(),
            "heavy": get_heavy_concurrency_timeout_seconds(),
        },
    }
