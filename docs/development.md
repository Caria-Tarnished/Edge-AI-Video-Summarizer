# Development (Windows / PowerShell)

## 1) 创建虚拟环境并安装依赖

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

## 2) 启动后端 / 本地栈

方式 0（推荐，启动本地栈）：一键启动 llama-server + backend

```powershell
./scripts/run_local_stack.ps1
```

停止本地栈：

```powershell
./scripts/stop_local_stack.ps1 -ForceStop
```

方式 A：直接用 uvicorn

```powershell
python -m uvicorn app.main:app --host 127.0.0.1 --port 8001
```

方式 B：使用脚本（会强制使用 `backend/.venv` 的 python）

```powershell
./scripts/run_backend_dev.ps1
```

## 2.5) 启动桌面端（Electron / 前后端联调）

推荐方式：在仓库根目录直接双击：`start_dev.cmd`

- 默认行为：自动启动 `llama-server` + 后端 + Electron 前端
- 可选：你也可以在 PowerShell 中运行（便于看日志/传参）：

```powershell
./start_dev.cmd
```

停止桌面端：

```powershell
./scripts/stop_dev.ps1 -ForceStop
```

## 2.6) 桌面端打包（Windows）

在 `frontend/` 目录：

```powershell
npm run dist
```

- `dist` 会自动执行后端 staging、构建与 electron-builder 打包
- 产物会根据版本号自动分流到：
  - 版本号不包含 `-`：`release/stable/<version>/`
  - 版本号包含 `-`：`release/beta/<version>/`

如需手动指定渠道：

```powershell
npm run dist:stable
npm run dist:beta
```

Windows 文件锁说明：若你曾从 `release/**/win-unpacked` 直接运行过程序，`resources/app.asar` 可能被占用导致删除/覆盖失败。构建脚本已在 `dist/pack` 前自动停止相关进程（见 `scripts/stop_release_apps.ps1`）。必要时可手动运行：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\stop_release_apps.ps1
```

## 3) 健康检查

```powershell
curl.exe http://127.0.0.1:8001/health
```

## 自动化脚本（PowerShell）

- `scripts/index_search_chat_test.ps1`：回归验证 `/index`、`/search`、`/chat`
- `scripts/local_llm_e2e_test.ps1`：端到端验证本地 LLM（llama-server）+ 设置默认 LLM 偏好 + index + `/chat`
- `scripts/run_llama_server.ps1`：一键启动本地 `llama-server`（含 `/v1/models` 健康检查与日志落盘）
- `scripts/run_local_stack.ps1`：一键启动 llama-server + backend
- `scripts/stop_local_stack.ps1`：停止本地栈
- `scripts/restart_recovery_test.ps1`：验证重启恢复
- `scripts/cancel_retry_test.ps1`：验证取消/重试
- `scripts/run_quality_checks.ps1`：一键运行 flake8/mypy/pyright/pytest
