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
  - `POST /chat`：问答（retrieval-only / 本地 LLM RAG），返回 `answer + citations`（同样支持自动触发索引）
- Windows PowerShell 兼容性：JSON 响应强制 `charset=utf-8`，避免中文转写/检索结果乱码

### MVP-2：本地 LLM 推理引擎（已跑通）

- 本地 `llama.cpp` 的 `llama-server`（OpenAI-compatible `/v1/chat/completions`）
- 后端 provider：`openai_local`
- 默认偏好持久化：`PUT /llm/preferences/default`
- 新增：默认偏好支持 `output_language`（`zh/en/auto`），用于控制 Chat/摘要/大纲/云摘要输出语言
- 已验证：
  - `/chat` 非流式 `200` 返回真实 LLM 输出
  - `/chat` SSE 流式 `event: token` + `event: done`
  - 索引完成后 RAG 正常返回 `answer + citations`
  - 非流式超时风险已缓解：可通过 `LLM_REQUEST_TIMEOUT_SECONDS` 调整

### MVP-3：层级摘要（Map-Reduce）与大纲结构 + 导出（已验证）

- 新增 Job 类型：`summarize`
- Map-Reduce：按时间窗聚合 transcript segments → 分段摘要（map）→ 汇总摘要（reduce）→ 生成结构化大纲
- 结果持久化：`video_summaries`（summary/outline/segment_summaries/params/transcript_hash）
- 已验证：
  - `outline` 输出为结构化 JSON 数组（不再是 `{ "raw": ... }`）
  - `export/markdown` 返回完整 Markdown（不再出现明显截断）

### MVP-4：关键帧提取（已完成并验证）

- 新增 Job 类型：`keyframes`
- Stage 1（固定间隔抽帧）：
  - `ffmpeg` 抽帧输出 JPG（支持 `target_width`）
  - SQLite 落盘：`video_keyframe_indexes` / `video_keyframes`
  - keyframe metadata：`timestamp_ms`、`width/height`
- Stage 2（场景切换检测）：
  - `ffmpeg select=gt(scene,thr)` 检测候选帧
  - `score` 落库（`video_keyframes.score`）
  - 与大纲对齐时优先高分帧，并支持 `min_gap` 去重
  - 可选章节兜底：`fallback=nearest`（章节内不足时按章节中点最近补齐；默认关闭）

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
- `scripts/local_llm_e2e_test.ps1`：端到端验证本地 LLM（llama-server）+ 设置默认 LLM 偏好 + index + `/chat` 非流式与 SSE
- `scripts/run_llama_server.ps1`：一键启动本地 `llama-server`（含 `/v1/models` 健康检查与日志落盘）
- `scripts/run_local_stack.ps1`：一键启动 llama-server + backend，并可选自动运行 `local_llm_e2e_test.ps1`（支持 `-ForceReindex`，并尽量复用已运行服务）
- `scripts/stop_local_stack.ps1`：停止 `run_local_stack.ps1` 启动的进程（读取 `artifacts/*.pid` 与 `artifacts/local_stack_pids.json`）

### 桌面端（Electron/React）开发环境（已跑通）

- 一键启动：双击 `start_dev.cmd`（默认启动 llama-server + backend + Electron 前端）
- 启动脚本：
  - `scripts/run_dev.ps1`：后端健康检查（避免重复启动）、前端注入 `VITE_BACKEND_BASE_URL`、可选/默认启动 llama-server
  - `scripts/stop_dev.ps1`：按 `artifacts/dev_pids.json` 停止前端/llama-server，并通过端口兜底释放 backend 端口
- Electron-Vite：显式配置 main/preload/renderer entry 与 build 输出，renderer dev server 绑定 `127.0.0.1`
- Electron main：
  - dev 模式等待 renderer dev server ready 后再加载
  - preload 输出兼容 `.js` / `.mjs`（当前 dev 使用 CommonJS `index.js`）
  - dev 模式关闭 `webSecurity`（仅开发期）以规避 CORS 阻断导致的 `Failed to fetch`
- Renderer：
  - Settings 页已联通后端 API（runtime profile / LLM preferences / llama-server status），并将中文 UI 文案替换为 Unicode escape，避免源码文件被 GBK/GB2312 编码保存时出现乱码
  - 新增：全局 UI 语言切换（中文/English，localStorage 持久化）；默认 LLM 偏好新增 `output_language`（`zh/en/auto`）并持久化到 `/llm/preferences/default`，用于控制 Chat/摘要/大纲/云摘要输出语言
  - Library（视频库）：
    - `GET /videos` 视频列表 + 刷新
    - Electron 文件选择器导入视频（`POST /videos/import`），导入后自动刷新列表
    - 点击视频进入详情页
  - Video Detail（视频详情）：
    - 展示基础视频信息
    - 播放器（HTML5 video）：
      - 视频播放：`GET /videos/{video_id}/file`
      - 字幕：默认挂载自动生成 VTT（`GET /videos/{video_id}/subtitles/vtt`），并提供“字幕开/关”按钮避免与视频自带字幕冲突
      - 控制：`-15s/+15s` 跳转、倍速、复制当前时间戳
      - 联动：点击转写段落 / 大纲 / 引用 / 关键帧可跳转到对应时间戳
    - 转写（transcribe）：参数面板（segment_seconds/overlap_seconds/from_scratch）+ SSE 进度订阅 + transcript 预览（`GET /videos/{id}/transcript`）
    - 索引/摘要/关键帧：SSE 进度订阅 + 结果预览
      - index：`GET /videos/{id}/index`
      - summary：`GET /videos/{id}/summary` + outline（可选）`GET /videos/{id}/outline`
      - keyframes：`GET /videos/{id}/keyframes/index` + 缩略图列表 `GET /videos/{id}/keyframes`
    - Notes（摘要/大纲侧栏，Tab）：
      - 摘要：轻量 markdown 渲染（标题/列表/代码块）+ 展开/收起（按高度折叠）
      - 大纲：支持自动展开开关；节点可折叠 + 全部展开/全部收起；点击标题栏可跳转播放
      - aligned keyframes：缩略图时间戳 overlay、数量展示、空态/加载态更清晰；并对请求做去重/合并避免重复刷新
    - AI 助手（Chat 侧栏，Tab）：
      - `/chat` SSE streaming：支持取消、confirm_send 确认提示；索引未就绪自动等待并重试
      - 回答：轻量 markdown 渲染；引用列表增强（显示更多/收起、一键跳转到时间戳）
      - 快捷键：Ctrl/Cmd + Enter 发送；支持清空结果
    - 修复：避免预览区因 React effect 依赖导致的重复请求风暴与偶发 “Failed to fetch”

### 桌面端打包与发布（Windows，已跑通）

- 后端发布态：使用 PyInstaller 产出 onedir exe（含 `_internal/`），Electron 主进程优先启动 exe，并保留自动端口选择 + `/health` 探测 + 关闭时清理进程
- 目录约定：后端发布物通过 staging 放入 `frontend/resources/backend/edge-video-agent-backend/`
  - staging 脚本：`scripts/stage_backend_for_frontend.ps1`
- 打包工具：`electron-builder`
  - 将 `frontend/resources/backend/**` 作为 `extraResources` 打入 `win-unpacked/resources/backend/`
  - 产物输出目录按版本号隔离，避免 Windows 文件锁导致的覆盖失败
- Release 目录分流：根据版本号是否包含 `-`，自动输出到 `release/stable/<version>/` 或 `release/beta/<version>/`
- Windows 文件锁规避：`npm run dist/pack` 前自动停止从 `release/**/win-unpacked` 运行的进程（避免 `resources/app.asar` 被占用）
  - 脚本：`scripts/stop_release_apps.ps1`
- 已发布：`v0.0.1-beta.1` 预发布版（GitHub Releases，Windows installer + portable zip）

## API 一览（MVP-1 + MVP-2 + MVP-3 + MVP-4）

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
- `POST /videos/{video_id}/summarize`
- `GET /videos/{video_id}/summary`
- `GET /videos/{video_id}/outline`
- `GET /videos/{video_id}/export/markdown`
- `POST /videos/{video_id}/keyframes`
- `GET /videos/{video_id}/keyframes/index`
- `GET /videos/{video_id}/keyframes`
- `GET /videos/{video_id}/keyframes/nearest`
- `GET /videos/{video_id}/keyframes/aligned`
- `GET /videos/{video_id}/keyframes/{keyframe_id}/image`

## 待办（下一步任务）

- 按 Architecture_Design 的里程碑推进（建议顺序）：
  - MVP-2：工程性收尾与质量提升
    - 完成：为 `/index`、`/search`、`/chat` 增加回归脚本（PowerShell）并覆盖竞态（200/202）
    - 完成：统一 ChromaDB 异常包装为 `VectorStoreUnavailable`，提升 worker/API 稳定性
    - 完成：完善 `/search`、`/chat` 的 index job 去重逻辑（优先复用 pending/running job）
    - 完成：引入并跑通静态检查（mypy/pyright），补齐 `backend/pyrightconfig.json`，并新增 `backend/requirements-dev.txt`、`backend/.flake8`
    - 完成：将质量检查纳入 CI（GitHub Actions：flake8 + mypy + pyright + pytest）
    - 完成：补最小 pytest 回归（`TestClient`）覆盖 `/health`、`/index`、`/search`、`/chat` 关键分支与错误码
  - 质量与性能（下一步，建议优先）：
    - Runtime Profiles（CPU 友好 / 均衡 / GPU 推荐）后端落地（settings + API + worker 读取）
    - 并发控制：默认限制为 `1 ASR + 1 LLM`（避免同时跑多个重任务导致卡顿/超时）
    - Embedding：替换默认 `hash` fallback（或至少将其降级为 fallback，仅在真实 embedding 不可用时启用）
    - 最小 pytest 覆盖与稳定性回归：覆盖 `/summarize`、`/keyframes`（interval/scene/aligned）关键分支与错误码
    - 自动化脚本补齐（可选）：新增 keyframes 端到端验证脚本（类比 `index_search_chat_test.ps1`）
  - 桌面端（可选增强）：
    - 任务中心（全局 jobs 列表 + 取消/重试 + 进度订阅）
  - 打包与分发（下一步，建议进入 P3）：
    - Release 工程化：CI 构建产物（Windows）+ 自动发布 GitHub Release（含校验文件）
    - 自动更新策略（可选）：electron-updater / 手动检查更新（二选一）
    - 安装包体验：数据目录选择/迁移、首次运行向导（模型/llama-server/whisper 模型可用性检测）
    - 多平台（可选）：macOS/Linux 打包与签名（如需要）

## 备忘 / 待验证事项（重要）

- 后端核心功能已通过一键脚本回归验证（见“自动化验证脚本”）。
- 以下测试步骤默认针对 **Windows PowerShell**：
  - PowerShell 中 `curl` 通常是 `Invoke-WebRequest` 的别名，行为与 curl 不同。
  - 建议显式使用 `curl.exe`，或使用 `Invoke-RestMethod (irm)`。
- SSE/WS 相关：
  - SSE 建议用浏览器或 `curl.exe -N` 验证；WS 建议用 Node/Python 客户端脚本验证。

### P3-3：模型热替换 / 管理（待验证，暂不阻塞 P3-4）

> 目标：支持在不重启后端的情况下切换 ASR 模型（以及切换默认 LLM 模型偏好），并具备“可回滚”的数据结构。

- **后端已实现**：
  - `PUT /runtime/profile` 支持 `asr_model`，并通过环境变量 `ASR_MODEL` 驱动 ASR 加载。
  - ASR 加载逻辑支持热切换：当 `asr_model / asr_device / asr_compute_type` 变化时会自动卸载并在下一次转写时重载。
  - `GET/PUT /models/manifest`：模型清单（落盘到 `${data_dir}/models/manifest.json`）。
  - `POST /models/activate`：切换 `asr_model` / `llm_model`，返回 `previous` 和 `current`，用于回滚。

- **建议验证步骤**：
  - **ASR 状态**：
    - Settings -> Runtime Profile：填写 `asr_model=small` 或 `asr_model=large-v3` 并保存。
    - 点击 “刷新 ASR 状态”，确认显示的 `model/repo_id` 跟随变化。
  - **ASR 真正热切换**：
    - 切换 `asr_model` 后，创建一次 `transcribe` job（任意视频）。
    - 预期：任务可正常完成，且切换后首次转写会触发 ASR 模型按新配置重载。
  - **LLM 模型候选（本地 llama-server）**：
    - Settings -> “本地 llama-server 状态”：刷新。
    - 若 `/v1/models` 返回 `models` 列表，Default LLM Preferences 里应出现下拉，选择后保存生效。
  - **回滚**：
    - 调用 `POST /models/activate` 得到 `previous`。
    - 将 `previous.runtime.asr_model` 与 `previous.llm.model` 再提交一次，确认可回到上一状态。

- **备注（ASR 缓存文件）**：
  - Faster-Whisper 运行通常只需要 `model.bin + config.json`。
  - UI 若显示缺失 `tokenizer.json/vocabulary.json/...` 等文件，多数属于“可选文件”，不应阻止使用。

### MVP-4：scene_threshold 调参备忘（场景切换抽帧）

- `scene_threshold` 的含义：`ffmpeg` 的 `scene` 检测是一个 0~1 的“镜头切换强度”评分，过滤条件是 `scene_score > scene_threshold`。
  - 阈值 **越低**：候选帧 **越多**（更敏感，可能引入噪声）
  - 阈值 **越高**：候选帧 **越少**（更保守，可能某些章节没有帧）
- 建议的调参流程（先保证“有帧”，再控制“质量/密度”）：
  - 第一次建议从 `0.3` 开始（默认推荐值）。
  - 若 `GET /videos/{id}/keyframes?method=scene` 返回数量过少：逐步降低阈值，例如 `0.3 -> 0.2 -> 0.15 -> 0.1`。
  - 若候选过多/太密：提高阈值，例如 `0.3 -> 0.4 -> 0.5`，并配合增大 `min_gap_seconds`。
- 搭配参数（优先级建议）：
  - **`min_gap_seconds`**：用于去重/控密度。想要“每章 2 张但不要太近”，优先调它（常用 `2~5` 秒）。
  - **`max_frames`**：上限保护，避免过多抽帧导致 CPU/IO 时间过长（常用 `20~60`）。
  - **`target_width`**：降低图片宽度可显著减少存储与 IO（例如 `640`）。
- 快速观察与决策（PowerShell）：

```powershell
$BaseUrl = "http://127.0.0.1:8001"
$VideoId = "<VIDEO_ID>"

# 观察 scene 抽帧数量与 score 分布
$scene = Invoke-RestMethod -Method Get -Uri "$BaseUrl/videos/$VideoId/keyframes?method=scene&limit=200"
($scene.items | Measure-Object).Count
$scene.items | Select-Object -First 5 id,timestamp_ms,score

# 若章节内不足 per_section，可开启兜底（不改阈值也能先产出“每章都有图”）
$aligned = Invoke-RestMethod -Method Get -Uri "$BaseUrl/videos/$VideoId/keyframes/aligned?method=scene&per_section=2&min_gap_seconds=2.0&fallback=nearest"
$aligned | ConvertTo-Json -Depth 50
```

## 详细测试步骤（PowerShell）

> 说明：以下示例以本机 `127.0.0.1:8001` 为例。路径中的视频文件请替换为你电脑上真实存在的文件。

### 0. 启动服务

- 推荐（本地栈一键启动 llama-server + backend）：在仓库根目录：

```powershell
./scripts/run_local_stack.ps1
```

- 桌面端开发（推荐，启动 llama-server + backend + Electron 前端）：双击仓库根目录 `start_dev.cmd`

- 手动启动 backend（仅后端，不包含 llama-server）：在项目 `backend` 目录下：

```powershell
# 建议先创建并激活虚拟环境（可选）
python -m venv .venv
.\.venv\Scripts\Activate.ps1

pip install -r requirements.txt

# 启动 FastAPI
python -m uvicorn app.main:app --host 127.0.0.1 --port 8001
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

### 10. 摘要与大纲（MVP-3）

```powershell
$BaseUrl = "http://127.0.0.1:8001"
$VideoId = "<VIDEO_ID>"

# 创建/复用 summarize 任务
$resp = Invoke-RestMethod -Method Post -Uri "$BaseUrl/videos/$VideoId/summarize" `
  -ContentType "application/json; charset=utf-8" `
  -Body (@{ from_scratch = $false } | ConvertTo-Json)

$JobId = $resp.job_id
while ($true) {
  $j = Invoke-RestMethod -Method Get -Uri "$BaseUrl/jobs/$JobId"
  Write-Host ("status={0} progress={1} message={2}" -f $j.status, $j.progress, $j.message)
  if ($j.status -in @("completed","failed","cancelled")) { break }
  Start-Sleep -Milliseconds 800
}

# 获取 summary / outline / export
Invoke-RestMethod -Method Get -Uri "$BaseUrl/videos/$VideoId/summary" | ConvertTo-Json -Depth 20
Invoke-RestMethod -Method Get -Uri "$BaseUrl/videos/$VideoId/outline" | ConvertTo-Json -Depth 50
Invoke-RestMethod -Method Get -Uri "$BaseUrl/videos/$VideoId/export/markdown"
```

### 11. 关键帧（MVP-4）

```powershell
$BaseUrl = "http://127.0.0.1:8001"
$VideoId = "<VIDEO_ID>"

# A) 固定间隔抽帧（interval）
$req = @{ from_scratch = $true; mode = "interval"; interval_seconds = 10; max_frames = 60; target_width = 640 }
$resp = Invoke-RestMethod -Method Post -Uri "$BaseUrl/videos/$VideoId/keyframes" `
  -ContentType "application/json; charset=utf-8" `
  -Body ($req | ConvertTo-Json)

$JobId = $resp.job_id
while ($true) {
  $j = Invoke-RestMethod -Method Get -Uri "$BaseUrl/jobs/$JobId"
  Write-Host ("status={0} progress={1} message={2}" -f $j.status, $j.progress, $j.message)
  if ($j.status -in @("completed","failed","cancelled")) { break }
  Start-Sleep -Milliseconds 800
}

# 列表与二进制图片
$list = Invoke-RestMethod -Method Get -Uri "$BaseUrl/videos/$VideoId/keyframes?method=interval&limit=5"
$list | ConvertTo-Json -Depth 30

# B) 场景切换抽帧（scene + score）
$req = @{ from_scratch = $true; mode = "scene"; scene_threshold = 0.3; min_gap_seconds = 2.0; max_frames = 30; target_width = 640 }
$resp = Invoke-RestMethod -Method Post -Uri "$BaseUrl/videos/$VideoId/keyframes" `
  -ContentType "application/json; charset=utf-8" `
  -Body ($req | ConvertTo-Json)

$JobId = $resp.job_id
while ($true) {
  $j = Invoke-RestMethod -Method Get -Uri "$BaseUrl/jobs/$JobId"
  Write-Host ("status={0} progress={1} message={2}" -f $j.status, $j.progress, $j.message)
  if ($j.status -in @("completed","failed","cancelled")) { break }
  Start-Sleep -Milliseconds 800
}

$scene = Invoke-RestMethod -Method Get -Uri "$BaseUrl/videos/$VideoId/keyframes?method=scene&limit=10"
$scene | ConvertTo-Json -Depth 30

# aligned：章节内优先高分 + min_gap 去重（返回 score）
$aligned = Invoke-RestMethod -Method Get -Uri "$BaseUrl/videos/$VideoId/keyframes/aligned?method=scene&per_section=2&min_gap_seconds=2.0"
$aligned | ConvertTo-Json -Depth 50

# 可选章节兜底（默认关闭）：章节内不足 per_section 时按章节中点最近补齐
$aligned2 = Invoke-RestMethod -Method Get -Uri "$BaseUrl/videos/$VideoId/keyframes/aligned?method=scene&per_section=2&min_gap_seconds=2.0&fallback=nearest"
$aligned2 | ConvertTo-Json -Depth 50
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

## 发布与更新说明模板（维护者）

### Release Notes（模板）

- Version：`vX.Y.Z`（stable）或 `vX.Y.Z-beta.N`（beta）
- Date：YYYY-MM-DD
- Channel：stable / beta
- Highlights：
  - 
- Breaking changes（如有）：
  - 
- Known issues（如有）：
  - 
- Assets（Windows，推荐上传）：
  - `Edge Video Agent Setup <version>.exe`
  - `Edge Video Agent Setup <version>.exe.blockmap`
  - `Edge Video Agent-<version>-win.zip`
  - `SHA256SUMS.txt`

### 升级 / 回滚指引（模板）

- 升级：
  - 建议先关闭正在运行的应用程序后再安装新版
  - 若涉及数据目录变更/迁移，需在此说明迁移步骤
- 数据目录与兼容性：
  - 说明默认数据目录位置与是否向后兼容
  - 说明是否需要一次性迁移、是否可回滚
- 回滚：
  - 若新版存在问题，可卸载并安装旧版本
  - 若数据目录有变更，需在此说明如何恢复旧数据目录

---

## 变更记录（手动维护）

- 2026-01-09：新增 SSE/WS job 进度推送；新增 PROJECT_STATUS 文档与更详细测试步骤。
- 2026-01-10：补齐并通过一键验证脚本（列表分页/导出与错误处理/云摘要开关）；字幕导出增加 transcript 必需校验（无 transcript 返回 `TRANSCRIPT_NOT_FOUND`）。
- 2026-01-10：MVP-2 索引/检索/问答接口落地（`/videos/{video_id}/index`、`/videos/{video_id}/chunks`、`/search`、`/chat`）；修复 Windows PowerShell 中文 JSON 乱码（强制 `charset=utf-8`）。
- 2026-01-11：新增 `/index`、`/search`、`/chat` 回归脚本（竞态容忍 200/202 且严格断言索引 job 去重复用）；完善 `scripts/run_backend_dev.ps1` 以强制使用 `backend/.venv` Python 并修复参数名冲突；统一 ChromaDB 异常包装为 `VectorStoreUnavailable`；引入并跑通 mypy/pyright，新增 `backend/pyrightconfig.json`、`backend/requirements-dev.txt`、`backend/.flake8`。
- 2026-01-11：新增 GitHub Actions CI（`.github/workflows/quality.yml`：flake8/mypy/pyright/pytest）；初始化并推送 GitHub 仓库；根目录 `.gitignore` 忽略 `demo/`、`artifacts/`、`backend/.venv/`。
- 2026-01-13：MVP-3：新增 `summarize` job + summary/outline/export API；增强 JSON 大纲解析与修复逻辑；提高 reduce/outline 阶段 `max_tokens` 默认值，避免导出 Markdown/大纲被截断；端到端验证通过（outline 为结构化数组，export/markdown 成功落盘）。
- 2026-01-13：MVP-4：新增 `keyframes` job 与 SQLite 落盘（interval/scene）；scene 模式写入 `score`；aligned 支持 scene 优先高分并可返回 `score`，可选 `fallback=nearest`。
- 2026-01-13：桌面端开发环境跑通：一键启动/停止脚本完善（含默认启动 llama-server）；修复 Electron-Vite entry/host 与 dev server 等待逻辑；dev 模式 CORS 绕过；前端中文 UI 文案改为 Unicode escape，避免 GBK/GB2312 编码导致乱码。
- 2026-01-14：桌面端联调：完成 Library/Video Detail 页面（导入/列表/导航）；转写参数面板 + SSE 进度 + transcript 预览；索引/摘要/关键帧 SSE 进度订阅与结果预览；修复预览区重复请求风暴导致的后端日志刷屏与偶发 “Failed to fetch”。
- 2026-01-14：桌面端体验增强（Video Detail）：Notes/Chat 侧栏 Tab 落地并优化阅读体验（摘要 markdown 渲染、大纲可折叠与自动展开开关、aligned keyframes 缩略图与去重）；Chat 支持答案 markdown、引用跳转与快捷键；播放器增加 `-15s/+15s`、倍速、复制时间戳与自动字幕开关，并优化转录高亮与自动滚动。
- 2026-01-14：国际化与输出语言：新增全局 UI 语言切换（中文/English，localStorage 持久化）；Settings 新增 LLM 输出语言 `output_language`（`zh/en/auto`），并在 Chat/摘要/大纲/云摘要全链路生效；修复 `SettingsPage.tsx` 文件编码为 UTF-8 以便继续迭代 UI 文案。
- 2026-01-15：Windows 打包与发布：后端 PyInstaller onedir exe 集成到 Electron；引入 electron-builder 并将后端作为 extraResources；release 目录按 stable/beta 分流并按版本隔离输出；增加构建前自动停止 release/win-unpacked 进程以规避 `app.asar` 文件锁；已创建并上传 `v0.0.1-beta.1` GitHub 预发布版资产。
