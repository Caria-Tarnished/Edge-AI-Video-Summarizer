# Overview

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
- 默认 LLM 偏好支持 `output_language`（`zh/en/auto`），用于控制 Chat/摘要/大纲/云摘要输出语言

### MVP-3：层级摘要（Map-Reduce）与大纲结构 + 导出

- 新增 `summarize` job：Map-Reduce 生成分段摘要与最终摘要
- 输出结构化大纲（JSON）与导出 Markdown
- 相关接口：`/videos/{video_id}/summarize`、`/videos/{video_id}/summary`、`/videos/{video_id}/outline`、`/videos/{video_id}/export/markdown`

### MVP-4：关键帧提取（interval / scene）

- 新增 `keyframes` job
- Stage 1（固定间隔抽帧）：`ffmpeg` 抽帧输出 JPG，支持 `target_width`，并写入 SQLite（含 `timestamp_ms`、`width/height`）
- Stage 2（场景切换检测）：`ffmpeg select=gt(scene,thr)` 检测候选帧并写入 `score`
- 与大纲对齐：`/videos/{video_id}/keyframes/aligned`
  - `method=scene`：优先高分帧并支持 `min_gap_seconds` 去重
  - 可选兜底：`fallback=nearest`（章节内不足时按章节中点最近补齐；默认关闭）

### 实时进度推送

- SSE：`GET /jobs/{job_id}/events`
- WebSocket：`GET ws://127.0.0.1:8001/ws/jobs/{job_id}`

## 目录结构

- `backend/`：FastAPI 后端源码、测试与开发工具配置
- `frontend/`：Electron + Vite + React 桌面端
- `scripts/`：PowerShell 自动化验证/质量检查脚本
- `artifacts/`：脚本输出与导出文件（默认忽略）
- `release/`：桌面端打包产物输出目录（默认忽略）
  - `release/stable/<version>/`：正式版产物
  - `release/beta/<version>/`：预发布版产物（版本号包含 `-`）
- `start_dev.cmd`：桌面端开发一键启动
- `Architecture_Design.md`：架构与里程碑规划
- `PROJECT_STATUS.md`：项目进度、测试备忘、变更记录
