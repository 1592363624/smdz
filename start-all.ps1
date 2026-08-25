# ============================================================
# 使魔大战3 网页版 · 本地一键启动脚本
# 功能：自动安装前后端依赖、生成 Prisma Client，并分别启动
#       后端(NestJS, 端口 3333)与前端(Vite, 端口 5173)。
# 用法：在项目根目录执行  .\start-all.ps1
#       首次运行或需要重建数据库时加  -InitDb 参数。
# ============================================================
[CmdletBinding()]
param(
    # 是否同步数据库结构并写入种子数据（首次运行或表结构变更时使用）
    [switch]$InitDb
)

# ---------- 强制 UTF-8 输出，避免中文乱码 ----------
[System.Console]::OutputEncoding = [System.Text.Encoding]::UTF8
[System.Console]::InputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8
$PSDefaultParameterValues['*:Encoding'] = 'utf8'

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# ---------- 关键路径 ----------
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$ServerDir = Join-Path $Root 'server'
$WebDir = Join-Path $Root 'web'

# ---------- 工具函数 ----------
function Invoke-CheckedCommand {
    param(
        [Parameter(Mandatory = $true)][string]$Command,
        [Parameter(Mandatory = $true)][string]$Description,
        [Parameter(ValueFromRemainingArguments = $true)][string[]]$Arguments
    )
    Write-Host "==> $Description"
    & $Command @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "$Description 失败（exit code: $LASTEXITCODE）"
    }
}

# 校验目录结构存在
foreach ($dir in @($ServerDir, $WebDir)) {
    if (-not (Test-Path -LiteralPath $dir -PathType Container)) {
        throw "缺少必要的目录：$dir"
    }
}

Write-Host "==== 检查 Node.js 环境 ===="
$node = Get-Command node -ErrorAction SilentlyContinue
$npm = Get-Command npm -ErrorAction SilentlyContinue
if (-not $node -or -not $npm) {
    throw '未检测到 Node.js / npm，请先安装 Node.js 20+'
}
node -v
npm -v

# ---------- 后端依赖与初始化 ----------
Write-Host "`n==== 后端 ($ServerDir) ===="
Set-Location -LiteralPath $ServerDir
if (-not (Test-Path -LiteralPath (Join-Path $ServerDir 'node_modules') -PathType Container)) {
    Invoke-CheckedCommand npm '安装后端依赖（首次运行，可能较慢）' 'install'
} else {
    Write-Host '(后端依赖已存在，跳过 npm install)'
}

# 生成 Prisma Client（依赖安装或版本变更后需执行）
Invoke-CheckedCommand npx '生成 Prisma Client' 'prisma' 'generate'

# 首次同步数据库结构并写入种子数据（可选，由 -InitDb 触发）
if ($InitDb) {
    Invoke-CheckedCommand npx '同步数据库结构（db push）' 'prisma' 'db' 'push' '--skip-generate' '--accept-data-loss'
    Invoke-CheckedCommand npm '写入种子数据' 'run' 'seed:all'
} else {
    Write-Host '(跳过数据库同步，如需初始化数据库请加 -InitDb 参数)'
}

# ---------- 前端依赖 ----------
Write-Host "`n==== 前端 ($WebDir) ===="
Set-Location -LiteralPath $WebDir
if (-not (Test-Path -LiteralPath (Join-Path $WebDir 'node_modules') -PathType Container)) {
    Invoke-CheckedCommand npm '安装前端依赖（首次运行，可能较慢）' 'install'
} else {
    Write-Host '(前端依赖已存在，跳过 npm install)'
}

# ---------- 启动前后端（各开独立新窗口，避免相互阻塞） ----------
Write-Host "`n==== 启动服务 ===="
Set-Location -LiteralPath $ServerDir
Start-Process -FilePath 'cmd.exe' -ArgumentList '/k', 'npm run dev' -WorkingDirectory $ServerDir

Set-Location -LiteralPath $WebDir
Start-Process -FilePath 'cmd.exe' -ArgumentList '/k', 'npm run dev' -WorkingDirectory $WebDir

Write-Host '==== 前后端已启动 ===='
Write-Host '  后端:  http://localhost:3333/api/docs  (Swagger)'
Write-Host '  前端:  http://localhost:5173'
Write-Host '  关闭：直接关闭弹出的两个命令行窗口即可。'

# 回到项目根目录，方便继续执行其他命令
Set-Location -LiteralPath $Root