import os
import tempfile
from typing import Generator

import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

os.environ["EDGE_VIDEO_AGENT_DISABLE_WORKER"] = "1"
os.environ.setdefault(
    "EDGE_VIDEO_AGENT_DATA_DIR",
    tempfile.mkdtemp(prefix="edge-video-agent-test-"),
)

_backend_dir = Path(__file__).resolve().parents[1]
if str(_backend_dir) not in sys.path:
    sys.path.insert(0, str(_backend_dir))

from app.main import app


@pytest.fixture()
def client() -> Generator[TestClient, None, None]:
    with TestClient(app) as c:
        yield c
