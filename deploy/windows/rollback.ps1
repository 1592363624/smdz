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

# Robocopy exit codes 0-7 are success; >= 8 means failure.
function Test-RoboExit {
    return ($LASTEXITCODE -lt 8)
}

function Remove-TreeBestEffort {
    param([Parameter(Mandatory = $true)][string]$Path)
    if (-not (Test-Path -LiteralPath $Path)) { return $true }
    $emptyDir = Join-Path ([System.IO.Path]::GetTempPath()) ("robocopy_empty_" + [System.Guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $emptyDir -Force | Out-Null
    robocopy $emptyDir $Path /MIR /R:1 /W:1 /NFL /NDL /NJH /NP | Out-Null
    $roboOk = Test-RoboExit
    Remove-Item -LiteralPath $emptyDir -Force -ErrorAction SilentlyContinue
    if (Test-Path -LiteralPath $Path) {
        Remove-Item -LiteralPath $Path -Recurse -Force -ErrorAction SilentlyContinue
    }
    return ($roboOk -and -not (Test-Path -LiteralPath $Path))
}

# Wait until the service answers HTTP on the given port (max ~120s).
function Test-RollbackHealth {
    param([int]$Port)
    for ($i = 0; $i -lt 24; $i++) {
        Start-Sleep -Seconds 5
        try {
            $resp = Invoke-WebRequest -Uri "http://127.0.0.1:$Port/api/docs" -UseBasicParsing -TimeoutSec 5
            Write-Host "[CI Rollback] Health check passed after rollback (HTTP $($resp.StatusCode))"
            return $true
        } catch {
            Write-Host "[CI Rollback] Service not ready yet (attempt $($i+1)/24)"
        }
    }
    return $false
}

# Read the service port from server/.env (fallback 3333).
function Get-RollbackServicePort {
    $envFile = Join-Path $ServerDirectory '.env'
    if (Test-Path -LiteralPath $envFile -PathType Leaf) {
        $envContent = Get-Content -LiteralPath $envFile -Raw
        $match = [regex]::Match($envContent, 'PORT\s*=\s*(\d+)')
        if ($match.Success) {
            return [int]$match.Groups[1].Value
        }
    }
    return 3333
}

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
    Remove-TreeBestEffort $ServerDirectory | Out-Null
    Write-Host "[CI Rollback] Removed failed server/"
}
if (Test-Path -LiteralPath $WebDirectory -PathType Container) {
    Remove-TreeBestEffort $WebDirectory | Out-Null
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
$rollbackOk = $false
if (Test-Path -LiteralPath $ServerDirectory -PathType Container) {
    $ecosystemFile = Join-Path $ServerDirectory 'ecosystem.config.js'
    if (Test-Path -LiteralPath $ecosystemFile -PathType Leaf) {
        # The backup may lack dist/main.js (e.g. an incomplete previous backup).
        # Rebuild from the restored source so PM2 has an entry script to run
        # instead of failing with "Script not found" (seen on 2026-09-04).
        $entryScript = Join-Path $ServerDirectory 'dist\main.js'
        if (-not (Test-Path -LiteralPath $entryScript -PathType Leaf)) {
            Write-Host "[CI Rollback] dist\main.js missing in restored backup, rebuilding from source..."
            Set-Location -LiteralPath $ServerDirectory
            & npm run build
            if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $entryScript -PathType Leaf)) {
                Write-Host "[CI Rollback] FAILED: entry script $entryScript still missing after rebuild."
            }
        }

        if (Test-Path -LiteralPath $entryScript -PathType Leaf) {
            Set-Location -LiteralPath $ServerDirectory
            Write-Host "[CI Rollback] Restarting previous version via PM2..."
            pm2 start ecosystem.config.js --name $AppName
            if ($LASTEXITCODE -ne 0) {
                Write-Host "[CI Rollback] pm2 start exited with code $LASTEXITCODE"
            }
            pm2 save

            $servicePort = Get-RollbackServicePort
            if (Test-RollbackHealth -Port $servicePort) {
                $rollbackOk = $true
                Write-Host "[CI Rollback] Previous version restarted via PM2"
            } else {
                Write-Host "[CI Rollback] Restore finished but service did not become healthy."
            }
        }
    } else {
        Write-Warning "[CI Rollback] ecosystem.config.js not found in backup; cannot auto-restart"
    }
}

# Clean up backup (best-effort; a locked file must not mask the rollback result)
if (Test-Path -LiteralPath $BackupDir -PathType Container) {
    Remove-TreeBestEffort $BackupDir | Out-Null
    Write-Host "[CI Rollback] Backup directory cleaned"
}

if ($rollbackOk) {
    Write-Host "[CI Rollback] Rollback completed"
    exit 0
} else {
    Write-Host "[CI Rollback] Rollback could not bring the service back up. Please check manually."
    exit 1
}
