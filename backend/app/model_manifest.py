import json
import os
from typing import Any, Dict

from .settings import settings


def _manifest_path() -> str:
    return os.path.join(settings.data_dir, "models", "manifest.json")


def default_manifest() -> Dict[str, Any]:
    return {
        "version": 1,
        "llm_local_models": [],
        "asr_models": ["small", "large-v3"],
    }


def load_manifest() -> Dict[str, Any]:
    path = _manifest_path()
    try:
        with open(path, "r", encoding="utf-8") as f:
            obj = json.load(f)
        if isinstance(obj, dict):
            return obj
    except Exception:
        pass
    return default_manifest()


def save_manifest(manifest: Dict[str, Any]) -> Dict[str, Any]:
    payload = manifest if isinstance(manifest, dict) else {}
    path = _manifest_path()
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=2)
    return load_manifest()
