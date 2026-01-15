import os

import uvicorn

from app.main import app


def _get_env_int(keys: list[str], default: int) -> int:
    for k in keys:
        v = str(os.getenv(k, "") or "").strip()
        if not v:
            continue
        try:
            return int(v)
        except Exception:
            continue
    return int(default)


def main() -> None:
    host = str(os.getenv("EDGE_VIDEO_AGENT_HOST", "127.0.0.1") or "127.0.0.1")
    port = _get_env_int(
        [
            "EDGE_VIDEO_AGENT_BACKEND_PORT",
            "EDGE_VIDEO_AGENT_PORT",
            "PORT",
        ],
        8001,
    )
    uvicorn.run(app, host=host, port=port)


if __name__ == "__main__":
    main()
