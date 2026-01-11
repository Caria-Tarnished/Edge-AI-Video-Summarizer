import os
import tempfile
from typing import Generator

import pytest
from fastapi.testclient import TestClient

os.environ["EDGE_VIDEO_AGENT_DISABLE_WORKER"] = "1"
os.environ.setdefault(
    "EDGE_VIDEO_AGENT_DATA_DIR",
    tempfile.mkdtemp(prefix="edge-video-agent-test-"),
)

from app.main import app


@pytest.fixture()
def client() -> Generator[TestClient, None, None]:
    with TestClient(app) as c:
        yield c
