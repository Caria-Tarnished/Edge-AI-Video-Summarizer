# Edge-AI-Video-Summarizer

![Backend Quality](https://github.com/Caria-Tarnished/Edge-AI-Video-Summarizer/actions/workflows/quality.yml/badge.svg)

本项目是一个 **本地优先（local-first）** 的视频处理与检索后端：

- 导入本地视频
- 抽取音频并进行 ASR 分段转写（支持断点续跑）
- 导出可播放字幕（SRT/VTT）
- 对转写内容进行分块、Embedding、向量索引
- 提供检索（`/search`）与问答（`/chat`）接口：支持 retrieval-only，也支持接入本地 LLM（RAG）

后端基于 **FastAPI + SQLite**，向量库使用 **ChromaDB**。

> 说明：仓库中的 `demo/` 内容用于其他平台（如 ModelScope）展示，因此本 GitHub 仓库默认忽略 `demo/`（见根目录 `.gitignore`）。

---

## 功能概览

### MVP-1：转写与字幕导出

- 本地视频导入与去重入库
- 任务系统（Job）：转写任务、取消、重试、重启恢复
- 转写结果按 JSONL 分段落盘，支持断点续跑
- 字幕导出：`SRT` / `VTT`
- 列表查询：视频列表、任务列表

### MVP-2：文本知识库（Index/Search/Chat）

- Chunking：按时间窗聚合转写 segments，支持 overlap
- Embedding：默认提供本地可用的 `hash` embedding（`384` 维）
- 向量库：ChromaDB 持久化
- Index Job：分块 → embedding → upsert 到向量库
- 搜索：`GET /search`
- 问答：`POST /chat`
  - retrieval-only：返回 `answer + citations`
  - 本地 LLM（RAG）：返回 `answer + citations`，LLM provider 通过 `/llm/preferences/default` 配置
- 索引过期检测：基于 transcript 文件 hash 判断 stale index，并自动触发重建
- Chroma collection 版本化：按 `embed_model + embed_dim` 隔离，避免维度冲突；必要时对 legacy collection 做兼容回退

### MVP-2：本地 LLM（llama-server）

- 支持 `llama.cpp` 的 `llama-server`（OpenAI-compatible `/v1/chat/completions`）
- 后端通过 provider `openai_local` 调用本地 LLM
- 支持非流式与 SSE 流式输出

### 实时进度推送

- SSE：`GET /jobs/{job_id}/events`
- WebSocket：`GET ws://127.0.0.1:8001/ws/jobs/{job_id}`

---

## 目录结构

- `backend/`：FastAPI 后端源码、测试与开发工具配置
- `scripts/`：PowerShell 自动化验证/质量检查脚本
- `artifacts/`：脚本输出与导出文件（默认忽略）
- `Architecture_Design.md`：架构与里程碑规划
- `PROJECT_STATUS.md`：项目进度、测试备忘、变更记录

---

## 快速开始（Windows / PowerShell）

### 1) 创建虚拟环境并安装依赖

在 `backend/` 目录：

```powershell
python -m venv .venv
.\.venv\Scripts\Activate.ps1

pip install -r requirements.txt
```

如需开发质量工具（flake8/mypy/pyright/pytest）：

```powershell
pip install -r requirements-dev.txt
```

### 2) 启动后端

方式 A：直接用 uvicorn

```powershell
python -m uvicorn app.main:app --host 127.0.0.1 --port 8001 --reload
```

方式 B：使用脚本（会强制使用 `backend/.venv` 的 python）

```powershell
./scripts/run_backend_dev.ps1
```

### 3) 健康检查

```powershell
curl.exe http://127.0.0.1:8001/health
```

---

## 常用接口

- `POST /videos/import`
- `POST /jobs/transcribe`
- `GET /jobs` / `GET /videos`
- `GET /videos/{video_id}/subtitles/srt`
- `GET /videos/{video_id}/subtitles/vtt`
- `POST /videos/{video_id}/index`
- `GET /search?video_id=...&query=...&top_k=...`
- `POST /chat`
- `GET /llm/providers`
- `GET /llm/preferences/default`
- `PUT /llm/preferences/default`

更完整 API 与 PowerShell 示例见：`PROJECT_STATUS.md`。

---

## 自动化脚本（PowerShell）

- `scripts/index_search_chat_test.ps1`：回归验证 `/index`、`/search`、`/chat`（含 200/202 竞态容忍与 job_id 复用断言）
- `scripts/local_llm_e2e_test.ps1`：端到端验证本地 LLM（llama-server）+ 设置默认 LLM 偏好 + index + `/chat` 非流式与 SSE
- `scripts/restart_recovery_test.ps1`：验证重启恢复
- `scripts/cancel_retry_test.ps1`：验证取消/重试
- `scripts/run_quality_checks.ps1`：一键运行 flake8/mypy/pyright/pytest

---

## CI（GitHub Actions）

已接入 GitHub Actions：`.github/workflows/quality.yml`

- flake8
- mypy
- pyright
- pytest

---

## 环境变量（部分）

- `EDGE_VIDEO_AGENT_DATA_DIR`：数据目录（SQLite/转写/索引等）
- `EDGE_VIDEO_AGENT_DISABLE_WORKER`：禁用后台 worker（测试用）
- `ENABLE_CLOUD_SUMMARY`：是否允许云摘要（默认关闭）
- `LLM_LOCAL_BASE_URL`：本地 llama-server 的 OpenAI API base url（默认 `http://127.0.0.1:8080/v1`）
- `LLM_LOCAL_MODEL`：本地 llama-server 的默认 model id（默认 `llama`）
- `LLM_REQUEST_TIMEOUT_SECONDS`：后端调用 LLM 的 HTTP 超时（秒），用于非流式请求（默认 `600`）

更多配置项请参考：`backend/app/settings.py`。

---

## 许可证

如需添加 License 或贡献指南（CONTRIBUTING），可以在后续补齐。
