# PROJECT_STATUS

> 作用：记录当前项目进度、下一步计划、待改进点与测试备忘。

## 项目目标（当前阶段）

- MVP-1（Backend）：导入本地视频 → 抽音频 → ASR 分段转写（可断点续跑）→ 转写落盘 → 可播放字幕导出（SRT/VTT）→ 查询/列表/任务管理。
- 隐私优先：默认所有处理本地进行。
- 可选云摘要：默认关闭，必须显式确认联网（`confirm_send=true`）。

## 当前完成情况（已落地到代码）

### Backend

- FastAPI + SQLite（WAL）
- 视频导入：根据文件路径计算 hash，去重入库
- JobRunner：本地 worker 线程轮询执行 `transcribe` 任务
- 分段转写：chunk + overlap，按 JSONL 逐段落盘，支持断点续跑
- 任务工程性：
  - 重启恢复：`running -> pending`（jobs），`processing -> pending`（videos）
  - 原子 claim：避免多 worker 重复执行
  - 取消：可在 chunk 边界安全停止
  - 重试：支持保留转写续跑或从头重新转写
- 导出：
  - `GET /videos/{video_id}/subtitles/srt`
  - `GET /videos/{video_id}/subtitles/vtt`
  - 行为约束：未生成转写（transcript 不存在或为空）时导出返回 `404 TRANSCRIPT_NOT_FOUND`
- 列表：
  - `GET /videos`
  - `GET /jobs`

### MVP-2：文本知识库（Chunk/Embedding/Index/Search/Chat）

- Chunking：基于转写 segments 的时间窗聚合分块（支持 overlap + 轻量自然边界）
- Embedding：提供本地可用的 embedding（当前默认 `hash` fallback，维度 `384`）
- 向量库：ChromaDB 持久化存储（用于视频 chunks 的向量检索）
- 新增 Job 类型：`index`（分块 → embedding → upsert 到向量库；支持取消/重试/重启恢复）
- 新增接口：
  - `POST /videos/{video_id}/index`：创建/复用 index job
  - `GET /videos/{video_id}/index`：查看 index 状态
  - `GET /videos/{video_id}/chunks`：查看 chunk 列表
  - `GET /search`：向量检索（若未完成索引会自动触发 index，并返回 `202 + job_id`）
  - `POST /chat`：无 LLM（retrieval-only）问答，返回 `answer + citations`（同样支持自动触发索引）
- Windows PowerShell 兼容性：JSON 响应强制 `charset=utf-8`，避免中文转写/检索结果乱码

### 实时进度推送（已新增接口）

- SSE：`GET /jobs/{job_id}/events`
  - 基于 DB 轮询 + `jobs.updated_at` 变更检测
  - 事件：`event: job`（包含最新 job row）
- WebSocket：`GET ws://127.0.0.1:8001/ws/jobs/{job_id}`
  - 同样基于 `jobs.updated_at` 的变更推送

### 自动化验证脚本（PowerShell，一键）

- `scripts/cancel_retry_test.ps1`：自动创建 job → 等待 running → cancel → 确认 cancelled → retry → 等待完成并导出 artifacts
- `scripts/restart_recovery_test.ps1`：模拟后端 crash/restart，验证 running→pending 恢复、继续转写并最终完成
- `scripts/list_pagination_test.ps1`：严格断言 `/videos` 与 `/jobs` 的 filter/limit/offset/sort 行为
- `scripts/export_error_test.ps1`：严格断言导出与错误码（FILE_NOT_FOUND/VIDEO_NOT_FOUND/JOB_NOT_FOUND/UNSUPPORTED_SUBTITLE_FORMAT/TRANSCRIPT_NOT_FOUND 等）
- `scripts/cloud_summary_toggle_test.ps1`：严格断言 `ENABLE_CLOUD_SUMMARY=0/1` 以及 `confirm_send` 强制确认逻辑
- `scripts/index_search_chat_test.ps1`：回归验证 `/index`、`/search`、`/chat`：
  - 索引进行中允许 `202`，并严格断言 `job_id` 复用（去重策略）
  - 若索引完成过快允许直接 `200`

## API 一览（MVP-1 + MVP-2）

- `GET /health`
- `POST /videos/import`
- `GET /videos/{video_id}`
- `GET /videos`（可带 `status`）
- `POST /videos/{video_id}/index`
- `GET /videos/{video_id}/index`
- `GET /videos/{video_id}/chunks`
- `POST /jobs/transcribe`
- `GET /jobs/{job_id}`
- `GET /jobs`（可带 `status/video_id/job_type`）
- `POST /jobs/{job_id}/cancel`
- `POST /jobs/{job_id}/retry`（`from_scratch` 可选）
- `GET /videos/{video_id}/transcript`
- `GET /videos/{video_id}/subtitles/{srt|vtt}`
- `GET /search`
- `POST /chat`
- `POST /summaries/cloud`（可选，默认关闭）

## 待办（下一步任务）

- 按 Architecture_Design 的里程碑推进（建议顺序）：
  - MVP-2：工程性收尾与质量提升
    - 完成：为 `/index`、`/search`、`/chat` 增加回归脚本（PowerShell）并覆盖竞态（200/202）
    - 完成：统一 ChromaDB 异常包装为 `VectorStoreUnavailable`，提升 worker/API 稳定性
    - 完成：完善 `/search`、`/chat` 的 index job 去重逻辑（优先复用 pending/running job）
    - 完成：引入并跑通静态检查（mypy/pyright），补齐 `backend/pyrightconfig.json`，并新增 `backend/requirements-dev.txt`、`backend/.flake8`
    - 完成：将质量检查纳入 CI（GitHub Actions：flake8 + mypy + pyright + pytest）
    - 完成：补最小 pytest 回归（`TestClient`）覆盖 `/health`、`/index`、`/search`、`/chat` 关键分支与错误码
  - MVP-2：本地 LLM 推理引擎接入（RAG）
    - 优先 `llama.cpp`（`llama-cpp-python` 或 `llama-server`）
    - 支持流式输出（SSE/WebSocket/HTTP chunked）
    - Prompt 组装与引用格式规范（时间戳可解析，前端可跳转）
  - MVP-3：层级摘要（Map-Reduce）与大纲结构 + 导出
  - MVP-4：关键帧提取（固定间隔/场景切换）+ 索引存储（SQLite）+ 与章节/时间戳对齐
  - 桌面端（Electron/React）接入：视频列表/任务进度（SSE/WS）/断线重连/状态恢复
  - 打包与分发：PyInstaller + Electron Builder；模型下载/导入向导；数据目录迁移/备份

## 备忘 / 待验证事项（重要）

- 后端核心功能已通过一键脚本回归验证（见“自动化验证脚本”）。
- 以下测试步骤默认针对 **Windows PowerShell**：
  - PowerShell 中 `curl` 通常是 `Invoke-WebRequest` 的别名，行为与 curl 不同。
  - 建议显式使用 `curl.exe`，或使用 `Invoke-RestMethod (irm)`。
- SSE/WS 相关：
  - SSE 建议用浏览器或 `curl.exe -N` 验证；WS 建议用 Node/Python 客户端脚本验证。

## 详细测试步骤（PowerShell）

> 说明：以下示例以本机 `127.0.0.1:8001` 为例。路径中的视频文件请替换为你电脑上真实存在的文件。

### 0. 启动服务

- 在项目 `backend` 目录下：

```powershell
# 建议先创建并激活虚拟环境（可选）
python -m venv .venv
.\.venv\Scripts\Activate.ps1

pip install -r requirements.txt

# 启动 FastAPI
python -m uvicorn app.main:app --host 127.0.0.1 --port 8001 --reload
```

### 1. 健康检查

```powershell
curl.exe http://127.0.0.1:8001/health
```

### 2. 导入视频

```powershell
$body = @{ file_path = "F:\\TEST\\Edge-AI-Video-Summarizer\\Vedio\\test_vedio.mp4" } | ConvertTo-Json
curl.exe -X POST http://127.0.0.1:8001/videos/import -H "Content-Type: application/json" -d $body
```

记录返回里的 `video_id`。

### 3. 创建转写 Job

```powershell
$body = @{ video_id = "<VIDEO_ID>"; segment_seconds = 60; overlap_seconds = 3 } | ConvertTo-Json
curl.exe -X POST http://127.0.0.1:8001/jobs/transcribe -H "Content-Type: application/json" -d $body
```

记录返回里的 `job_id`。

### 4. 普通轮询查看进度

```powershell
curl.exe http://127.0.0.1:8001/jobs/<JOB_ID>
```

### 5. SSE 实时订阅（推荐）

```powershell
# -N 让 curl 不要缓冲输出
curl.exe -N http://127.0.0.1:8001/jobs/<JOB_ID>/events
```

你会持续看到 `event: job` 的 data（JSON）。

### 6. WebSocket 验证（推荐用脚本）

> PowerShell 纯命令行不太方便直接跑 WS 客户端，建议用 Node.js 或 Python 写一个 10 行小脚本。

#### Node.js 示例（需要你本机装 Node）

```javascript
// 保存为 ws_test.js
import WebSocket from "ws";

const jobId = process.argv[2];
const ws = new WebSocket(`ws://127.0.0.1:8001/ws/jobs/${jobId}`);
ws.on("message", (msg) => console.log(msg.toString()));
ws.on("open", () => console.log("connected"));
```

PowerShell 运行：

```powershell
node .\ws_test.js <JOB_ID>
```

### 7. 导出字幕（可播放）

```powershell
curl.exe http://127.0.0.1:8001/videos/<VIDEO_ID>/subtitles/vtt
curl.exe http://127.0.0.1:8001/videos/<VIDEO_ID>/subtitles/srt
```

> 注意：如果该视频尚未完成转写/无 transcript，导出将返回 `404 TRANSCRIPT_NOT_FOUND`。

### 8. 取消与重试

```powershell
# 取消
curl.exe -X POST http://127.0.0.1:8001/jobs/<JOB_ID>/cancel

# 重试（续跑）
curl.exe -X POST http://127.0.0.1:8001/jobs/<JOB_ID>/retry -H "Content-Type: application/json" -d '{"from_scratch": false}'

# 重试（从头）
curl.exe -X POST http://127.0.0.1:8001/jobs/<JOB_ID>/retry -H "Content-Type: application/json" -d '{"from_scratch": true}'
```

### 9. 索引 / 检索 / 问答（MVP-2）

```powershell
# 创建/复用索引任务（未完成索引会返回 202 + job_id）
curl.exe -X POST http://127.0.0.1:8001/videos/<VIDEO_ID>/index -H "Content-Type: application/json" -d '{"from_scratch": false}'

# 查询索引状态
curl.exe http://127.0.0.1:8001/videos/<VIDEO_ID>/index

# 列出 chunks（需索引完成）
curl.exe http://127.0.0.1:8001/videos/<VIDEO_ID>/chunks?limit=5

# 向量检索（GET；若未索引完成同样会返回 202 + job_id）
curl.exe "http://127.0.0.1:8001/search?video_id=<VIDEO_ID>&query=%E8%AE%B2%E4%BA%86%E4%BB%80%E4%B9%88&top_k=5"

# 无 LLM 问答（retrieval-only；返回 answer + citations；必要时会先触发索引）
$body = @{ video_id = "<VIDEO_ID>"; query = "这段视频主要讲了什么？"; top_k = 5 } | ConvertTo-Json
curl.exe -X POST http://127.0.0.1:8001/chat -H "Content-Type: application/json" -d $body
```

## 开发质量工具（本地）

- 一键：

```powershell
./scripts/run_quality_checks.ps1
```

- flake8：

```powershell
cd backend
.
.venv\Scripts\flake8.exe app
```

- mypy：

```powershell
cd backend
.
.venv\Scripts\python.exe -m mypy app --ignore-missing-imports --show-error-codes
```

- pyright：

```powershell
cd backend
powershell -NoProfile -Command "& 'F:\\TEST\\Edge-AI-Video-Summarizer\\backend\\.venv\\Scripts\\pyright.exe' -p 'F:\\TEST\\Edge-AI-Video-Summarizer\\backend'"
```

> 说明：`backend/pyrightconfig.json` 已排除 `.venv`，避免扫描虚拟环境导致分析卡顿。

---

## 变更记录（手动维护）

- 2026-01-09：新增 SSE/WS job 进度推送；新增 PROJECT_STATUS 文档与更详细测试步骤。
- 2026-01-10：补齐并通过一键验证脚本（列表分页/导出与错误处理/云摘要开关）；字幕导出增加 transcript 必需校验（无 transcript 返回 `TRANSCRIPT_NOT_FOUND`）。
- 2026-01-10：MVP-2 索引/检索/问答接口落地（`/videos/{video_id}/index`、`/videos/{video_id}/chunks`、`/search`、`/chat`）；修复 Windows PowerShell 中文 JSON 乱码（强制 `charset=utf-8`）。
- 2026-01-11：新增 `/index`、`/search`、`/chat` 回归脚本（竞态容忍 200/202 且严格断言索引 job 去重复用）；完善 `scripts/run_backend_dev.ps1` 以强制使用 `backend/.venv` Python 并修复参数名冲突；统一 ChromaDB 异常包装为 `VectorStoreUnavailable`；引入并跑通 mypy/pyright，新增 `backend/pyrightconfig.json`、`backend/requirements-dev.txt`、`backend/.flake8`。
- 2026-01-11：新增 GitHub Actions CI（`.github/workflows/quality.yml`：flake8/mypy/pyright/pytest）；初始化并推送 GitHub 仓库；根目录 `.gitignore` 忽略 `demo/`、`artifacts/`、`backend/.venv/`。
