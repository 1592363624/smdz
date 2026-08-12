[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateNotNullOrEmpty()]
    [string]$DeploymentRoot,

    [Parameter(Mandatory = $true)]
    [ValidatePattern('^[A-Za-z0-9._-]+$')]
    [string]$AppName
)

# ---------- 强制 UTF-8 输出 ----------
[System.Console]::OutputEncoding = [System.Text.Encoding]::UTF8
[System.Console]::InputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8
$PSDefaultParameterValues['*:Encoding'] = 'utf8'
chcp 65001 > $null

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$DeploymentRoot = [System.IO.Path]::GetFullPath($DeploymentRoot)
$BackupDir = Join-Path $DeploymentRoot '.rollback-backup'
$ServerBackup = Join-Path $BackupDir 'server'
$WebBackup = Join-Path $BackupDir 'web'
$ServerDirectory = Join-Path $DeploymentRoot 'server'
$WebDirectory = Join-Path $DeploymentRoot 'web'

Write-Host "[CI Rollback] 开始检查回滚备份..."

if (-not (Test-Path -LiteralPath $BackupDir -PathType Container)) {
    Write-Host "[CI Rollback] 未找到备份目录 '$BackupDir'，deploy.ps1 可能已自行回滚。"
    exit 0
}

Write-Host "[CI Rollback] 发现备份目录，开始恢复..."

# 停止可能的新进程（pm2 可能因应用未启动而报错，这里显式忽略）
Write-Host "[CI Rollback] 停止新进程 (if any)"
try {
    pm2 delete $AppName 2>$null | Out-Null
} catch {
    Write-Host "[CI Rollback] pm2 delete 报错（已忽略）: $($_.Exception.Message)"
}

# 删除失败的解压
if (Test-Path -LiteralPath $ServerDirectory -PathType Container) {
    Remove-Item -LiteralPath $ServerDirectory -Recurse -Force
    Write-Host "[CI Rollback] 已删除失败的 server/"
}
if (Test-Path -LiteralPath $WebDirectory -PathType Container) {
    Remove-Item -LiteralPath $WebDirectory -Recurse -Force
    Write-Host "[CI Rollback] 已删除失败的 web/"
}

# 从备份恢复
if (Test-Path -LiteralPath $ServerBackup -PathType Container) {
    Move-Item -LiteralPath $ServerBackup -Destination $ServerDirectory -Force
    Write-Host "[CI Rollback] 已恢复 server/"
}
if (Test-Path -LiteralPath $WebBackup -PathType Container) {
    Move-Item -LiteralPath $WebBackup -Destination $WebDirectory -Force
    Write-Host "[CI Rollback] 已恢复 web/"
}

# 重启旧版本
if (Test-Path -LiteralPath $ServerDirectory -PathType Container) {
    Set-Location -LiteralPath $ServerDirectory
    $ecosystemFile = Join-Path $ServerDirectory 'ecosystem.config.js'
    if (Test-Path -LiteralPath $ecosystemFile -PathType Leaf) {
        Write-Host "[CI Rollback] 通过 PM2 重启旧版本..."
        pm2 start ecosystem.config.js --name $AppName
        pm2 save
        Write-Host "[CI Rollback] 旧版本已通过 PM2 重启"
    } else {
        Write-Warning "[CI Rollback] 备份中未找到 ecosystem.config.js，无法自动重启"
    }
}

# 清理备份
Remove-Item -LiteralPath $BackupDir -Recurse -Force
Write-Host "[CI Rollback] 备份目录已清理"
Write-Host "[CI Rollback] 回滚完成"