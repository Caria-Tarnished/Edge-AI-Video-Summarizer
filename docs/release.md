# Release (Desktop, Maintainers)

## 版本与渠道

- `x.y.z`：stable（正式版）
- `x.y.z-...`：beta（预发布版，例如 `0.0.1-beta.1`）
- Git tag：建议使用 `v<version>`（例如 `v0.0.1-beta.1`）

桌面端打包产物输出目录：

- stable：`release/stable/<version>/`
- beta：`release/beta/<version>/`

## 推荐上传的 Release 资产（Windows）

- `Edge Video Agent Setup <version>.exe`
- `Edge Video Agent Setup <version>.exe.blockmap`
- `Edge Video Agent-<version>-win.zip`
- `SHA256SUMS.txt`（推荐）

不建议上传：

- `win-unpacked/`（体积大且在 Windows 上更容易出现文件占用导致删除/覆盖失败）
- `builder-debug.yml` / `builder-effective-config.yaml`

## 生成 SHA256SUMS（PowerShell）

在仓库根目录：

```powershell
$ver = "0.0.1-beta.1"
$dir = "release\beta\$ver"

Get-FileHash -Algorithm SHA256 `
  "$dir\Edge Video Agent Setup $ver.exe", `
  "$dir\Edge Video Agent Setup $ver.exe.blockmap", `
  "$dir\Edge Video Agent-$ver-win.zip" |
  ForEach-Object { "$($_.Hash)  $($_.Path | Split-Path -Leaf)" } |
  Set-Content -Encoding ASCII "$dir\SHA256SUMS.txt"
```

## 创建/上传 GitHub 预发布版（PowerShell）

```powershell
$ver = "0.0.1-beta.1"
$tag = "v$ver"
$dir = "release\beta\$ver"

gh release create $tag `
  "$dir\Edge Video Agent Setup $ver.exe" `
  "$dir\Edge Video Agent Setup $ver.exe.blockmap" `
  "$dir\Edge Video Agent-$ver-win.zip" `
  "$dir\SHA256SUMS.txt" `
  --repo "Caria-Tarnished/Edge-AI-Video-Summarizer" `
  --title "$tag" `
  --notes "Beta prerelease ($tag). Windows installer + portable zip." `
  --prerelease
```

若 release 已存在，改用 `upload`：

```powershell
$ver = "0.0.1-beta.1"
$dir = "release\beta\$ver"

gh release upload "v$ver" `
  "$dir\Edge Video Agent Setup $ver.exe" `
  "$dir\Edge Video Agent Setup $ver.exe.blockmap" `
  "$dir\Edge Video Agent-$ver-win.zip" `
  "$dir\SHA256SUMS.txt" `
  --repo "Caria-Tarnished/Edge-AI-Video-Summarizer" `
  --clobber
```

## CI

- Tag push（`refs/tags/v*`）会触发 Windows 构建，并自动创建/更新 GitHub Release。
- workflow 位于：`.github/workflows/release.yml`
