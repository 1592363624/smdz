[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateNotNullOrEmpty()]
    [string]$DeploymentRoot,

    [Parameter(Mandatory = $true)]
    [ValidatePattern('^[A-Za-z0-9._-]+$')]
    [string]$AppName,

    [Parameter(Mandatory = $false)]
    [string]$EnvSource
)

# ---------- Force UTF-8 output ----------
[System.Console]::OutputEncoding = [System.Text.Encoding]::UTF8
[System.Console]::InputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8
$PSDefaultParameterValues['*:Encoding'] = 'utf8'
# chcp 65001 > $null  # optional, may be removed

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Invoke-CheckedCommand {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Command,
        [Parameter(Mandatory = $true)]
        [string]$Description,
        [Parameter(ValueFromRemainingArguments = $true)]
        [string[]]$Arguments
    )
    Write-Host "==> $Description"
    & $Command @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "$Description failed with exit code $LASTEXITCODE."
    }
}

# ---------- Global paths ----------
$DeploymentRoot = [System.IO.Path]::GetFullPath($DeploymentRoot)
$SourceArchive = Join-Path $DeploymentRoot 'source.tar.gz'
$ServerDirectory = Join-Path $DeploymentRoot 'server'
$WebDirectory = Join-Path $DeploymentRoot 'web'
$PidFile = Join-Path $ServerDirectory 'app.pid'
$BackupDir = Join-Path $DeploymentRoot '.rollback-backup'
$ServerBackup = Join-Path $BackupDir 'server'
$WebBackup = Join-Path $BackupDir 'web'

# ---------- Rollback function ----------
function Invoke-Rollback {
    Write-Host "===== ROLLBACK: Rolling back to previous version ====="

    Write-Host "==> Stopping new process (if any)"
    try {
        pm2 delete $AppName 2>$null | Out-Null
    } catch {
        Write-Host "pm2 delete error (ignored, app may not be running): $($_.Exception.Message)"
    }

    Write-Host "==> Removing failed deployment files"
    if (Test-Path -LiteralPath $ServerDirectory -PathType Container) {
        Remove-Item -LiteralPath $ServerDirectory -Recurse -Force -ErrorAction SilentlyContinue
    }
    if (Test-Path -LiteralPath $WebDirectory -PathType Container) {
        Remove-Item -LiteralPath $WebDirectory -Recurse -Force -ErrorAction SilentlyContinue
    }

    # DB is remote MySQL: no local database file to restore.
    $restoredSomething = $false
    if (Test-Path -LiteralPath $ServerBackup -PathType Container) {
        Write-Host "==> Restoring server/ from backup"
        Move-Item -LiteralPath $ServerBackup -Destination $ServerDirectory -Force
        $restoredSomething = $true
    }
    if (Test-Path -LiteralPath $WebBackup -PathType Container) {
        Write-Host "==> Restoring web/ from backup"
        Move-Item -LiteralPath $WebBackup -Destination $WebDirectory -Force
        $restoredSomething = $true
    }

    if ($restoredSomething -and (Test-Path -LiteralPath $ServerDirectory -PathType Container)) {
        $ecosystemFile = Join-Path $ServerDirectory 'ecosystem.config.js'
        if (Test-Path -LiteralPath $ecosystemFile -PathType Leaf) {
            Set-Location -LiteralPath $ServerDirectory
            Write-Host "==> Restarting previous version via PM2"
            pm2 start ecosystem.config.js --name $AppName
            pm2 save
            Write-Host "===== Rollback completed ====="
        } else {
            Write-Warning "ecosystem.config.js not found in backup, cannot auto-restart. Please check manually."
        }
    } else {
        Write-Warning "No backup available to rollback. Please fix manually."
    }

    if (Test-Path -LiteralPath $BackupDir -PathType Container) {
        Remove-Item -LiteralPath $BackupDir -Recurse -Force -ErrorAction SilentlyContinue
    }
}

# ---------- Health check function ----------
# NOTE: Use 127.0.0.1 (IPv4) instead of 'localhost' — on Windows 'localhost' may
# resolve to the IPv6 loopback (::1) while the service binds IPv4, which would make
# TCP probing falsely fail even though the service is up. On success we also do an
# HTTP GET to confirm the service actually answers requests (not just the port).
function Test-AppHealth {
    param([int]$Port)

    Write-Host "==> Health check: waiting for service to start (127.0.0.1:$Port)"

    for ($i = 0; $i -lt 24; $i++) {
        Start-Sleep -Seconds 5

        # 1) TCP-level probe (fast, useful early signal)
        $tcpOk = $false
        try {
            $client = New-Object System.Net.Sockets.TcpClient
            $connect = $client.BeginConnect('127.0.0.1', $Port, $null, $null)
            $wait = $connect.AsyncWaitHandle.WaitOne(5000, $false)
            if ($wait -and $client.Connected) {
                $tcpOk = $true
            }
            $client.Close()
        } catch {
            $tcpOk = $false
        }

        if ($tcpOk) {
            # 2) HTTP probe to confirm the app answers (not just the port open)
            try {
                $resp = Invoke-WebRequest -Uri "http://127.0.0.1:$Port/api/docs" -UseBasicParsing -TimeoutSec 5
                Write-Host "Health check passed: service is responding (HTTP $($resp.StatusCode))"
                return $true
            } catch {
                # HTTP not ready yet but port is open — keep waiting (app still booting)
                Write-Host "Port $Port is open but HTTP not ready yet (attempt $($i+1)/24)"
            }
        } else {
            Write-Host "Port $Port not reachable (attempt $($i+1)/24)"
        }
    }

    # ---- Diagnostic dump before giving up ----
    Write-Host "==> Health check FAILED. Dumping diagnostics:"
    Write-Host "--- netstat for 0.0.0.0/$Port and 127.0.0.1/$Port ---"
    Get-NetTCPConnection -LocalPort $Port -ErrorAction SilentlyContinue |
        Select-Object LocalAddress, LocalPort, State, OwningProcess | Format-Table -AutoSize

    $envFile = Join-Path $ServerDirectory 'out.log'
    Write-Host "--- tail of server/out.log (if present) ---"
    if (Test-Path -LiteralPath $envFile -PathType Leaf) {
        Get-Content -LiteralPath $envFile -Tail 20
    } else {
        Write-Host "(no out.log found)"
    }

    Write-Error "Health check failed: service did not start within 120 seconds"
    return $false
}

# ---------- Get service port ----------
function Get-ServicePort {
    $defaultPort = 3333
    $envFile = Join-Path $ServerDirectory '.env'

    if (Test-Path -LiteralPath $envFile -PathType Leaf) {
        $envContent = Get-Content -LiteralPath $envFile -Raw
        $match = [regex]::Match($envContent, 'PORT\s*=\s*(\d+)')
        if ($match.Success) {
            return [int]$match.Groups[1].Value
        }
    }
    return $defaultPort
}

# ============================================================
#  Main flow
# ============================================================
try {
    if (-not (Test-Path -LiteralPath $DeploymentRoot -PathType Container)) {
        throw "Deployment directory does not exist: $DeploymentRoot"
    }
    if (-not (Test-Path -LiteralPath $SourceArchive -PathType Leaf)) {
        throw "Source archive not uploaded: $SourceArchive"
    }

    Write-Host "Deployment root: $DeploymentRoot"
    Write-Host "App name: $AppName"

    # ---------- Step 1: Stop old process ----------
    Write-Host "==> Stopping old PM2 process (if exists)"
    try {
        pm2 delete $AppName 2>$null | Out-Null
    } catch {
        Write-Host "pm2 delete error (ignored, app may not be running): $($_.Exception.Message)"
    }

    if (Test-Path -LiteralPath $PidFile -PathType Leaf) {
        $oldPid = (Get-Content -LiteralPath $PidFile -Raw).Trim()
        if ($oldPid -and $oldPid -match '^\d+$') {
            $process = Get-Process -Id $oldPid -ErrorAction SilentlyContinue
            if ($process) {
                Write-Host "==> Stopping old process (PID: $oldPid)"
                Stop-Process -Id $oldPid -Force
                Start-Sleep -Seconds 1
            }
        }
        Remove-Item -LiteralPath $PidFile -Force
    }

    # ---------- Step 2: Backup current version ----------
    $hasBackup = $false
    if (Test-Path -LiteralPath $BackupDir -PathType Container) {
        Remove-Item -LiteralPath $BackupDir -Recurse -Force
    }
    if (Test-Path -LiteralPath $ServerDirectory -PathType Container) {
        Write-Host "==> Backing up current server/ to $BackupDir"
        New-Item -ItemType Directory -Path $BackupDir -Force | Out-Null
        Copy-Item -LiteralPath $ServerDirectory -Destination $ServerBackup -Recurse -Force
        $hasBackup = $true
        Write-Host "server/ backed up"
    } else {
        Write-Host "server/ does not exist, skipping backup"
    }
    if (Test-Path -LiteralPath $WebDirectory -PathType Container) {
        Write-Host "==> Backing up current web/ to $BackupDir"
        if (-not (Test-Path -LiteralPath $BackupDir -PathType Container)) {
            New-Item -ItemType Directory -Path $BackupDir -Force | Out-Null
        }
        Copy-Item -LiteralPath $WebDirectory -Destination $WebBackup -Recurse -Force
        Write-Host "web/ backed up"
    } else {
        Write-Host "web/ does not exist, skipping backup"
    }

    # ---------- Step 3: Database backup ----------
    # NOTE: The application uses a remote MySQL 8.0 database (see server/.env
    # DATABASE_URL). The database lives on the remote server, not in a local file,
    # so no local file backup/restore is needed here. Delete server/ freely.
    $dbRestored = $false
    Write-Host "DB is remote MySQL: skipping local database file backup."

    # ---------- Step 4: Remove old directories ----------
    if (Test-Path -LiteralPath $ServerDirectory -PathType Container) {
        Remove-Item -LiteralPath $ServerDirectory -Recurse -Force
        Write-Host "Removed old server/"
    }
    if (Test-Path -LiteralPath $WebDirectory -PathType Container) {
        Remove-Item -LiteralPath $WebDirectory -Recurse -Force
        Write-Host "Removed old web/"
    }

    # ---------- Step 4: Extract source ----------
    Set-Location -LiteralPath $DeploymentRoot
    Invoke-CheckedCommand tar.exe 'Extracting source archive' '-xzf' $SourceArchive
    Remove-Item -LiteralPath $SourceArchive -Force

    if (-not (Test-Path -LiteralPath $ServerDirectory -PathType Container)) {
        throw "Source archive does not contain server/ directory: $ServerDirectory"
    }
    if (-not (Test-Path -LiteralPath $WebDirectory -PathType Container)) {
        throw "Source archive does not contain web/ directory: $WebDirectory"
    }

    # ---------- Step 5: Overwrite .env ----------
    if ($EnvSource) {
        if (-not (Test-Path -LiteralPath $EnvSource -PathType Leaf)) {
            throw "Environment file not found: $EnvSource"
        }
        $EnvTarget = Join-Path $ServerDirectory '.env'
        Copy-Item -LiteralPath $EnvSource -Destination $EnvTarget -Force
        Write-Host "==> Written server/.env"
        Remove-Item -LiteralPath $EnvSource -Force
    }

    # ---------- Step 5b: Verify server/.env exists ----------
    # The remote MySQL connection string in server/.env is used as-is; it is not
    # rewritten to a local path (the database lives on the remote server).
    $EnvTarget = Join-Path $ServerDirectory '.env'
    if (-not (Test-Path -LiteralPath $EnvTarget -PathType Leaf)) {
        throw "server/.env not found, cannot run the service"
    }
    Write-Host "==> server/.env found; keeping remote MySQL DATABASE_URL as-is."

    # ---------- Step 6: Build server ----------
    Set-Location -LiteralPath $ServerDirectory
    Invoke-CheckedCommand npm 'Installing server dependencies' 'ci'
    Invoke-CheckedCommand npx 'Generating Prisma client' 'prisma' 'generate'

    $tsConfigPath = Join-Path $ServerDirectory 'tsconfig.build.json'
    if (-not (Test-Path -LiteralPath $tsConfigPath -PathType Leaf)) {
        $tsConfigPath = Join-Path $ServerDirectory 'tsconfig.json'
    }
    if (-not (Test-Path -LiteralPath $tsConfigPath -PathType Leaf)) {
        throw "tsconfig.build.json or tsconfig.json not found in $ServerDirectory"
    }

    $tsConfig = Get-Content -LiteralPath $tsConfigPath -Raw | ConvertFrom-Json
    $outDir = $tsConfig.compilerOptions.outDir
    if (-not $outDir) {
        $tsConfigJson = Join-Path $ServerDirectory 'tsconfig.json'
        if (Test-Path -LiteralPath $tsConfigJson -PathType Leaf) {
            $tsConfigBase = Get-Content -LiteralPath $tsConfigJson -Raw | ConvertFrom-Json
            $outDir = $tsConfigBase.compilerOptions.outDir
        }
        if (-not $outDir) { $outDir = 'dist' }
    }

    if (-not [System.IO.Path]::IsPathRooted($outDir)) {
        $outDirFull = Join-Path $ServerDirectory $outDir
    } else {
        $outDirFull = $outDir
    }
    Write-Host "[DIAG] Build output directory: $outDirFull"

    Invoke-CheckedCommand npm 'Building server' 'run' 'build'

    $mainJsCandidates = @(
        (Join-Path $outDirFull 'main.js'),
        (Join-Path $outDirFull 'src\main.js')
    )
    $builtMainScript = $null
    foreach ($candidate in $mainJsCandidates) {
        if (Test-Path -LiteralPath $candidate -PathType Leaf) {
            $builtMainScript = $candidate
            break
        }
    }

    if (-not $builtMainScript) {
        Write-Host "[DIAG] main.js not found, attempting tsc fallback..."
        Invoke-CheckedCommand npx 'Building server (tsc fallback)' 'tsc' '-p' $tsConfigPath
        foreach ($candidate in $mainJsCandidates) {
            if (Test-Path -LiteralPath $candidate -PathType Leaf) {
                $builtMainScript = $candidate
                break
            }
        }
    }

    if (-not $builtMainScript) {
        throw "Build did not produce main.js, check output directory: $outDirFull"
    }
    Write-Host "[DIAG] Entry script: $builtMainScript"

    # ---------- Step 7: Build web ----------
    Set-Location -LiteralPath $WebDirectory
    Invoke-CheckedCommand npm 'Installing frontend dependencies' 'ci'
    Invoke-CheckedCommand npm 'Building frontend' 'run' 'build'

    # ---------- Step 1b: Sync database schema ----------
    # NOTE: This project initializes the DB via hand-built early tables and
    # does NOT rely on a linear migration history. `prisma db push`
    # synchronizes the schema to schema.prisma without requiring migration
    # records. Using `migrate deploy` here would fail with P3005 (non-empty DB, no history).
    # Since the data-layering reform, fixed game config tables (monsters/items/
    # equipment/familiars/etc.) are now JSON-driven at runtime (StaticDataService)
    # and were removed from schema.prisma. Their historical DB tables are safe to
    # drop (all data is preserved in prisma/data/*.json), so we pass
    # --accept-data-loss to drop them; dynamic tables (Player/GameMap/GameVehicle/
    # GameShopItem/Channel/ChatMessage/CommandLog/Command/SystemConfig) keep data.
    Set-Location -LiteralPath $ServerDirectory
    Invoke-CheckedCommand npx 'Synchronizing database schema (dropping legacy fixed-config tables)' 'prisma' 'db' 'push' '--skip-generate' '--accept-data-loss'

    # ---------- Step 9: Seed data
    Write-Host "==> Seeding data (full import: seed.ts + seed-data.ts + seed-import-all.ts)"
    Invoke-CheckedCommand npm 'Seeding full data' 'run' 'seed:all'

    # ---------- Step 10: Create logs directory ----------
    $logDir = Join-Path $ServerDirectory 'logs'
    New-Item -ItemType Directory -Path $logDir -Force | Out-Null

    # ---------- Step 11: Start new process via PM2 ----------
    Set-Location -LiteralPath $ServerDirectory

    if (-not (Test-Path -LiteralPath $builtMainScript -PathType Leaf)) {
        throw "Entry script does not exist: $builtMainScript"
    }

    Write-Host "==> PM2 starting $AppName (node $builtMainScript)"
    $env:NODE_ENV = 'production'
    pm2 start ecosystem.config.js --name $AppName
    if ($LASTEXITCODE -ne 0) {
        throw "PM2 start failed with exit code: $LASTEXITCODE."
    }
    pm2 save
    Write-Host "==> PM2 started application: $AppName"

    # ---------- Step 12: Health check ----------
    $servicePort = Get-ServicePort
    $healthOk = Test-AppHealth -Port $servicePort
    if (-not $healthOk) {
        throw "Health check failed, service did not start properly"
    }

    # ---------- Step 13: Cleanup backup ----------
    if (Test-Path -LiteralPath $BackupDir -PathType Container) {
        Write-Host "==> Deployment successful, cleaning backup"
        Remove-Item -LiteralPath $BackupDir -Recurse -Force
    }

    Write-Host '===== Deployment completed successfully ====='
}
catch {
    Write-Error "Deployment failed: $($_.Exception.Message)"
    Write-Error $_.ScriptStackTrace

    Invoke-Rollback

    exit 1
}