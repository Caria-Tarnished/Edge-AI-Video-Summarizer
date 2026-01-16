# API

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

更完整 API 与 PowerShell 示例见：`PROJECT_STATUS.md`。
