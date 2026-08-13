[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateNotNullOrEmpty()]
    [string]$DeploymentRoot,

    [Parameter(Mandatory = $true)]
    [ValidatePattern('^[A-Za-z0-9._-]+$')]
    [string]$AppName
)

# ---------- Force UTF-8 output ----------
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

Write-Host "[CI Rollback] Checking rollback backup..."

if (-not (Test-Path -LiteralPath $BackupDir -PathType Container)) {
    Write-Host "[CI Rollback] Backup directory '$BackupDir' not found; deploy.ps1 probably rolled back already."
    exit 0
}

Write-Host "[CI Rollback] Backup found, starting restore..."

# Stop any new process (pm2 may error if the app is not running; ignore explicitly)
Write-Host "[CI Rollback] Stopping new process (if any)"
try {
    pm2 delete $AppName 2>$null | Out-Null
} catch {
    Write-Host "[CI Rollback] pm2 delete error (ignored): $($_.Exception.Message)"
}

# Remove the failed extraction
if (Test-Path -LiteralPath $ServerDirectory -PathType Container) {
    Remove-Item -LiteralPath $ServerDirectory -Recurse -Force
    Write-Host "[CI Rollback] Removed failed server/"
}
if (Test-Path -LiteralPath $WebDirectory -PathType Container) {
    Remove-Item -LiteralPath $WebDirectory -Recurse -Force
    Write-Host "[CI Rollback] Removed failed web/"
}

# Restore from backup
if (Test-Path -LiteralPath $ServerBackup -PathType Container) {
    Move-Item -LiteralPath $ServerBackup -Destination $ServerDirectory -Force
    Write-Host "[CI Rollback] Restored server/"
}
if (Test-Path -LiteralPath $WebBackup -PathType Container) {
    Move-Item -LiteralPath $WebBackup -Destination $WebDirectory -Force
    Write-Host "[CI Rollback] Restored web/"
}

# Restart the previous version
if (Test-Path -LiteralPath $ServerDirectory -PathType Container) {
    Set-Location -LiteralPath $ServerDirectory
    $ecosystemFile = Join-Path $ServerDirectory 'ecosystem.config.js'
    if (Test-Path -LiteralPath $ecosystemFile -PathType Leaf) {
        Write-Host "[CI Rollback] Restarting previous version via PM2..."
        pm2 start ecosystem.config.js --name $AppName
        pm2 save
        Write-Host "[CI Rollback] Previous version restarted via PM2"
    } else {
        Write-Warning "[CI Rollback] ecosystem.config.js not found in backup; cannot auto-restart"
    }
}

# Clean up backup
Remove-Item -LiteralPath $BackupDir -Recurse -Force
Write-Host "[CI Rollback] Backup directory cleaned"
Write-Host "[CI Rollback] Rollback completed"