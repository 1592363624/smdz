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

# ---------- Robocopy helpers ----------
# Windows PowerShell Copy-Item/Remove-Item are unreliable on large node_modules
# trees (MAX_PATH limits, files locked by AV/indexer), which caused both the
# "access denied" cleanup failure and an incomplete rollback backup. Robocopy
# handles long paths and locked files far better, so all recursive directory
# copy/delete operations go through robocopy instead.
# Robocopy exit codes 0-7 are success (bit flags); >= 8 means failure.
function Invoke-RoboCopyTree {
    param(
        [Parameter(Mandatory = $true)][string]$Source,
        [Parameter(Mandatory = $true)][string]$Destination
    )
    robocopy $Source $Destination /E /COPY:DAT /DCOPY:DAT /R:1 /W:1 /NFL /NDL /NJH /NP | Out-Null
    return ($LASTEXITCODE -lt 8)
}

function Remove-TreeBestEffort {
    param([Parameter(Mandatory = $true)][string]$Path)
    if (-not (Test-Path -LiteralPath $Path)) { return $true }
    # /MIR against an empty dir is the most reliable recursive delete on Windows
    $emptyDir = Join-Path ([System.IO.Path]::GetTempPath()) ("robocopy_empty_" + [System.Guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $emptyDir -Force | Out-Null
    robocopy $emptyDir $Path /MIR /R:1 /W:1 /NFL /NDL /NJH /NP | Out-Null
    $roboOk = ($LASTEXITCODE -lt 8)
    Remove-Item -LiteralPath $emptyDir -Force -ErrorAction SilentlyContinue
    if (Test-Path -LiteralPath $Path) {
        Remove-Item -LiteralPath $Path -Recurse -Force -ErrorAction SilentlyContinue
    }
    return ($roboOk -and -not (Test-Path -LiteralPath $Path))
}

# ---------- Maintenance flag helpers ----------
# The running app polls for server/maintenance.flag (see
# server/src/maintenance/maintenance.middleware.ts). While the flag exists the
# app serves a maintenance page to browsers and returns 503 (code=MAINTENANCE)
# for API requests, instead of serving the game. This keeps players informed
# during the whole deployment instead of facing a dead port.
function Enable-Maintenance {
    param([Parameter(Mandatory = $true)][string]$ServerDir)
    $flagPath = Join-Path $ServerDir 'maintenance.flag'
    Set-Content -LiteralPath $flagPath -Value (Get-Date -Format o) -Force
    Write-Host "==> Maintenance mode ENABLED ($flagPath)"
}

function Disable-Maintenance {
    param([Parameter(Mandatory = $true)][string]$ServerDir)
    $flagPath = Join-Path $ServerDir 'maintenance.flag'
    if (Test-Path -LiteralPath $flagPath -PathType Leaf) {
        # Best-effort by design: at cutover-success time the deployment is already
        # healthy. A failed flag removal (ACL/AV hiccup) must NEVER throw here,
        # otherwise the catch block would roll back a perfectly good build. Worst
        # case the maintenance page lingers and players must refresh manually.
        Remove-Item -LiteralPath $flagPath -Force -ErrorAction SilentlyContinue
        if (Test-Path -LiteralPath $flagPath -PathType Leaf) {
            Write-Warning "Could not remove maintenance.flag (file locked?). Players may need a manual refresh."
        } else {
            Write-Host "==> Maintenance mode DISABLED ($flagPath)"
        }
    }
}

# ---------- Move with retry ----------
# Rename/move on Windows fails while ANY process holds a handle on the tree
# (the moving shell's own working directory, AV/indexer scans, lingering npm
# children). Retry a few times to ride out transient locks.
function Invoke-MoveWithRetry {
    param(
        [Parameter(Mandatory = $true)][string]$Source,
        [Parameter(Mandatory = $true)][string]$Destination
    )
    for ($attempt = 1; $attempt -le 5; $attempt++) {
        try {
            Move-Item -LiteralPath $Source -Destination $Destination -Force -ErrorAction Stop
            return $true
        } catch {
            Write-Host "Move attempt $attempt/5 failed: $($_.Exception.Message)"
            Start-Sleep -Seconds 3
        }
    }
    return $false
}

# ---------- Global paths ----------
$DeploymentRoot = [System.IO.Path]::GetFullPath($DeploymentRoot)
$SourceArchive = Join-Path $DeploymentRoot 'source.tar.gz'
$ServerDirectory = Join-Path $DeploymentRoot 'server'
$WebDirectory = Join-Path $DeploymentRoot 'web'
$StagingDirectory = Join-Path $DeploymentRoot '.staging'
$StagingServerDirectory = Join-Path $StagingDirectory 'server'
$StagingWebDirectory = Join-Path $StagingDirectory 'web'
$BackupDir = Join-Path $DeploymentRoot '.rollback-backup'
$ServerBackup = Join-Path $BackupDir 'server'
$WebBackup = Join-Path $BackupDir 'web'

# ---------- Health check function ----------
# NOTE: Use 127.0.0.1 (IPv4) instead of 'localhost' — on Windows 'localhost' may
# resolve to the IPv6 loopback (::1) while the service binds IPv4, which would make
# TCP probing falsely fail even though the service is up. On success we also do an
# HTTP GET to confirm the service actually answers requests (not just the port).
# /api/docs is exempt from maintenance mode inside the app, so the health check
# works even while the maintenance flag is present.
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

    # NOTE: Do NOT use Write-Error here. With $ErrorActionPreference='Stop' it
    # raises a new terminating error that bypasses the remaining catch-block
    # logic in the caller (historically this skipped Invoke-Rollback entirely).
    Write-Host "Health check failed: service did not start within 120 seconds"
    return $false
}

# ---------- Get service port ----------
function Get-ServicePort {
    param([Parameter(Mandatory = $true)][string]$ServerDir)
    $defaultPort = 3333
    $envFile = Join-Path $ServerDir '.env'

    if (Test-Path -LiteralPath $envFile -PathType Leaf) {
        $envContent = Get-Content -LiteralPath $envFile -Raw
        $match = [regex]::Match($envContent, 'PORT\s*=\s*(\d+)')
        if ($match.Success) {
            return [int]$match.Groups[1].Value
        }
    }
    return $defaultPort
}

# ---------- Backup restore ----------
# robocopy /E /MOVE merges the backup INTO any leftover partial directory and
# removes the backup source as it goes. This is deliberately NOT Move-Item:
# if the delete of the failed deployment left a partial tree behind,
# Move-Item would move the backup INSIDE it (creating server\server\...)
# instead of replacing it, and the restored layout would be wrong.
function Restore-FromBackup {
    param(
        [Parameter(Mandatory = $true)][string]$BackupPath,
        [Parameter(Mandatory = $true)][string]$DestPath,
        [Parameter(Mandatory = $true)][string]$Label
    )
    if (-not (Test-Path -LiteralPath $BackupPath -PathType Container)) { return $false }
    Write-Host "==> Restoring $Label from backup"
    robocopy $BackupPath $DestPath /E /MOVE /COPY:DAT /DCOPY:DAT /R:1 /W:1 /NFL /NDL /NJH /NP | Out-Null
    if ($LASTEXITCODE -ge 8) {
        Write-Warning "Robocopy restore of $Label failed (exit code $LASTEXITCODE)."
        return $false
    }
    # /MOVE empties the backup; clear any residual empty directories.
    Remove-Item -LiteralPath $BackupPath -Recurse -Force -ErrorAction SilentlyContinue
    return (Test-Path -LiteralPath $DestPath -PathType Container)
}

# ---------- Rollback function ----------
# Restores the pristine pre-deployment backup (taken BEFORE maintenance mode was
# enabled, so it never contains the flag), clears the maintenance flag, and
# restarts the previous version via PM2.
function Invoke-Rollback {
    Write-Host "===== ROLLBACK: Rolling back to previous version ====="

    # MANDATORY FIRST STEP: the failure may have left this shell cd'd INSIDE a
    # directory we are about to delete or move below (Step 10 does
    # Set-Location $ServerDirectory right before its entry-script validation).
    # Windows refuses to delete/rename any process's working directory, so a
    # leftover cwd makes Remove-TreeBestEffort leave a partial tree behind and
    # Move-Item then nest the backup INSIDE it (server\server\...) — exactly
    # how the 2026-09-04 second rollback lost its PM2 restart.
    Set-Location -LiteralPath $DeploymentRoot

    Write-Host "==> Stopping new process (if any)"
    try {
        pm2 delete $AppName 2>$null | Out-Null
    } catch {
        Write-Host "pm2 delete error (ignored, app may not be running): $($_.Exception.Message)"
    }

    Write-Host "==> Removing failed deployment files"
    if (Test-Path -LiteralPath $ServerDirectory -PathType Container) {
        Remove-TreeBestEffort $ServerDirectory | Out-Null
    }
    if (Test-Path -LiteralPath $WebDirectory -PathType Container) {
        Remove-TreeBestEffort $WebDirectory | Out-Null
    }

    # DB is remote MySQL: no local database file to restore.
    $restoredSomething = $false
    if (Restore-FromBackup -BackupPath $ServerBackup -DestPath $ServerDirectory -Label 'server/') {
        $restoredSomething = $true
    }
    if (Restore-FromBackup -BackupPath $WebBackup -DestPath $WebDirectory -Label 'web/') {
        $restoredSomething = $true
    }

    # The backup is pristine (taken before the flag was written), but remove the
    # flag defensively so the restored app always serves the game again.
    if (Test-Path -LiteralPath $ServerDirectory -PathType Container) {
        Disable-Maintenance -ServerDir $ServerDirectory
    }

    if ($restoredSomething -and (Test-Path -LiteralPath $ServerDirectory -PathType Container)) {
        $ecosystemFile = Join-Path $ServerDirectory 'ecosystem.config.js'
        if (-not (Test-Path -LiteralPath $ecosystemFile -PathType Leaf)) {
            # Diagnostic: show what the restore actually produced so a wrong
            # layout is visible in the CI log instead of a silent dead end.
            Write-Warning "ecosystem.config.js not found after restore; restored server/ root contains:"
            Get-ChildItem -LiteralPath $ServerDirectory -ErrorAction SilentlyContinue |
                Select-Object -First 20 | ForEach-Object { Write-Host "  - $($_.Name)" }
        }

        # The backup may lack dist/main.js (e.g. an incomplete previous backup).
        # Rebuild from the restored source (node_modules ships with the backup)
        # so PM2 has an entry script to run instead of failing with
        # "Script not found". This must be checked INDEPENDENTLY of
        # ecosystem.config.js: skipping the restart because one file is
        # missing leaves production fully down (2026-09-04, second failure).
        $entryScript = Join-Path $ServerDirectory 'dist\main.js'
        if (-not (Test-Path -LiteralPath $entryScript -PathType Leaf)) {
            Write-Host "==> dist\main.js missing in restored backup, rebuilding from source..."
            Set-Location -LiteralPath $ServerDirectory
            & npm run build
            if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $entryScript -PathType Leaf)) {
                Write-Host "ROLLBACK INCOMPLETE: entry script $entryScript still missing after rebuild. Please check manually."
                return
            }
        }

        Set-Location -LiteralPath $ServerDirectory
        Write-Host "==> Restarting previous version via PM2"
        if (Test-Path -LiteralPath $ecosystemFile -PathType Leaf) {
            pm2 start ecosystem.config.js --name $AppName
        } else {
            # Emergency fallback: even without ecosystem.config.js, starting
            # the entry script directly is better than leaving the game down.
            Write-Warning "Starting dist\main.js directly (ecosystem.config.js unavailable)"
            pm2 start dist\main.js --name $AppName
        }
        if ($LASTEXITCODE -ne 0) {
            Write-Host "ROLLBACK WARNING: pm2 start exited with code $LASTEXITCODE. Please check manually."
        }
        pm2 save

        # Verify the rolled-back version actually serves traffic; do not claim
        # success otherwise.
        $servicePort = Get-ServicePort -ServerDir $ServerDirectory
        if (Test-AppHealth -Port $servicePort) {
            Write-Host "===== Rollback completed, service healthy ====="
        } else {
            Write-Host "Rollback restore finished but health check failed. Please check manually."
        }
    } else {
        Write-Warning "No backup available to rollback. Please check manually."
    }

    if (Test-Path -LiteralPath $BackupDir -PathType Container) {
        Remove-TreeBestEffort $BackupDir | Out-Null
    }
}

# ============================================================
#  Main flow
# ============================================================
# Staging-build deployment with a player-facing maintenance page:
#   1. Backup the current version (pristine, before any modification).
#   2. Enable maintenance mode on the RUNNING app: players now see the
#      maintenance page and APIs return 503, but the app stays alive.
#   3. Extract the uploaded archive into .staging/ and build there COMPLETELY
#      (npm ci, prisma generate, server build, web build, db push, seed).
#   4. Cutover: stop the old process, swap the staged directories in, start
#      the new version (a seconds-long window instead of minutes).
#   5. Health check, then remove the maintenance flag so every open
#      maintenance page auto-reloads into the new game.
# Any failure from step 2 onwards rolls back to the pristine backup.
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

    # ---------- Step 1: Backup current version (pristine, BEFORE any change) ----------
    if (Test-Path -LiteralPath $BackupDir -PathType Container) {
        # Best-effort: a leftover backup with locked files must not abort the new
        # deployment; robocopy below overwrites the copy destinations anyway.
        if (-not (Remove-TreeBestEffort $BackupDir)) {
            Write-Warning "Stale .rollback-backup could not be fully removed; continuing."
        }
    }
    if (Test-Path -LiteralPath $ServerDirectory -PathType Container) {
        Write-Host "==> Backing up current server/ to $BackupDir"
        New-Item -ItemType Directory -Path $BackupDir -Force | Out-Null
        if (-not (Invoke-RoboCopyTree $ServerDirectory $ServerBackup)) {
            throw "Backing up server/ failed (robocopy exit code >= 8)."
        }
        Write-Host "server/ backed up"
    } else {
        Write-Host "server/ does not exist, skipping backup"
    }
    if (Test-Path -LiteralPath $WebDirectory -PathType Container) {
        Write-Host "==> Backing up current web/ to $BackupDir"
        if (-not (Test-Path -LiteralPath $BackupDir -PathType Container)) {
            New-Item -ItemType Directory -Path $BackupDir -Force | Out-Null
        }
        if (-not (Invoke-RoboCopyTree $WebDirectory $WebBackup)) {
            throw "Backing up web/ failed (robocopy exit code >= 8)."
        }
        Write-Host "web/ backed up"
    } else {
        Write-Host "web/ does not exist, skipping backup"
    }

    # ---------- Step 2: Enable maintenance mode on the running app ----------
    # From this point players see the maintenance page instead of the game.
    if (Test-Path -LiteralPath $ServerDirectory -PathType Container) {
        Enable-Maintenance -ServerDir $ServerDirectory
    } else {
        Write-Host "==> No live server/ directory, skipping maintenance mode (first deployment)"
    }

    # ---------- Step 3: Extract source into staging ----------
    if (Test-Path -LiteralPath $StagingDirectory -PathType Container) {
        if (-not (Remove-TreeBestEffort $StagingDirectory)) {
            throw "Could not remove leftover staging directory: $StagingDirectory"
        }
    }
    New-Item -ItemType Directory -Path $StagingDirectory -Force | Out-Null
    Set-Location -LiteralPath $DeploymentRoot
    Invoke-CheckedCommand tar.exe 'Extracting source archive into staging' '-xzf' $SourceArchive '-C' $StagingDirectory

    if (-not (Test-Path -LiteralPath $StagingServerDirectory -PathType Container)) {
        throw "Source archive does not contain server/ directory: $StagingServerDirectory"
    }
    if (-not (Test-Path -LiteralPath $StagingWebDirectory -PathType Container)) {
        throw "Source archive does not contain web/ directory: $StagingWebDirectory"
    }

    # ---------- Step 4: Write .env into staging server ----------
    # The remote MySQL connection string in server/.env is used as-is; it is not
    # rewritten to a local path (the database lives on the remote server).
    if ($EnvSource) {
        if (-not (Test-Path -LiteralPath $EnvSource -PathType Leaf)) {
            throw "Environment file not found: $EnvSource"
        }
        $EnvTarget = Join-Path $StagingServerDirectory '.env'
        Copy-Item -LiteralPath $EnvSource -Destination $EnvTarget -Force
        Write-Host "==> Written staging server/.env"
        Remove-Item -LiteralPath $EnvSource -Force
    }
    $EnvTarget = Join-Path $StagingServerDirectory '.env'
    if (-not (Test-Path -LiteralPath $EnvTarget -PathType Leaf)) {
        throw "server/.env not found, cannot run the service"
    }
    Write-Host "==> staging server/.env found; keeping remote MySQL DATABASE_URL as-is."

    # ---------- Step 5: Build server in staging ----------
    Set-Location -LiteralPath $StagingServerDirectory
    Invoke-CheckedCommand npm 'Installing server dependencies' 'ci'
    Invoke-CheckedCommand npx 'Generating Prisma client' 'prisma' 'generate'

    $tsConfigPath = Join-Path $StagingServerDirectory 'tsconfig.build.json'
    if (-not (Test-Path -LiteralPath $tsConfigPath -PathType Leaf)) {
        $tsConfigPath = Join-Path $StagingServerDirectory 'tsconfig.json'
    }
    if (-not (Test-Path -LiteralPath $tsConfigPath -PathType Leaf)) {
        throw "tsconfig.build.json or tsconfig.json not found in $StagingServerDirectory"
    }

    $tsConfig = Get-Content -LiteralPath $tsConfigPath -Raw | ConvertFrom-Json
    $outDir = $tsConfig.compilerOptions.outDir
    if (-not $outDir) {
        $tsConfigJson = Join-Path $StagingServerDirectory 'tsconfig.json'
        if (Test-Path -LiteralPath $tsConfigJson -PathType Leaf) {
            $tsConfigBase = Get-Content -LiteralPath $tsConfigJson -Raw | ConvertFrom-Json
            $outDir = $tsConfigBase.compilerOptions.outDir
        }
        if (-not $outDir) { $outDir = 'dist' }
    }

    if (-not [System.IO.Path]::IsPathRooted($outDir)) {
        $outDirFull = Join-Path $StagingServerDirectory $outDir
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

    # ---------- Step 6: Build web in staging ----------
    Set-Location -LiteralPath $StagingWebDirectory
    Invoke-CheckedCommand npm 'Installing frontend dependencies' 'ci'
    Invoke-CheckedCommand npm 'Building frontend' 'run' 'build'

    # ---------- Step 7: Sync database schema ----------
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
    # The old app is in maintenance mode (game APIs return 503 before reaching
    # any service), so concurrent DB access during schema sync is minimal.
    Set-Location -LiteralPath $StagingServerDirectory
    Invoke-CheckedCommand npx 'Synchronizing database schema (dropping legacy fixed-config tables)' 'prisma' 'db' 'push' '--skip-generate' '--accept-data-loss'

    # ---------- Step 8: Seed data ----------
    Write-Host "==> Seeding data (full import: seed.ts + seed-data.ts)"
    Invoke-CheckedCommand npm 'Seeding full data' 'run' 'seed:all'

    # ---------- Step 9: Cutover (the ONLY stop-the-world window) ----------
    Write-Host "==> Stopping old PM2 process (cutover begins)"
    try {
        pm2 delete $AppName 2>$null | Out-Null
    } catch {
        Write-Host "pm2 delete error (ignored, app may not be running): $($_.Exception.Message)"
    }
    # Give Windows a moment to release the dying process's file handles
    # (log streams, memory-mapped files) before deleting its directory;
    # a transient lock here would abort cutover and force a rollback.
    Start-Sleep -Seconds 3

    if (Test-Path -LiteralPath $ServerDirectory -PathType Container) {
        if (-not (Remove-TreeBestEffort $ServerDirectory)) {
            throw "Could not remove old server/ (files locked); aborting before cutover."
        }
        Write-Host "Removed old server/"
    }
    if (Test-Path -LiteralPath $WebDirectory -PathType Container) {
        if (-not (Remove-TreeBestEffort $WebDirectory)) {
            throw "Could not remove old web/ (files locked); aborting before cutover."
        }
        Write-Host "Removed old web/"
    }

    # Leave the staging tree BEFORE moving it: Windows refuses to move/rename a
    # directory that is any process's current working directory — including
    # this very shell, which was cd'd into .staging\server for the build/seed
    # steps (this exact failure occurred on 2026-09-04: "item in use").
    Set-Location -LiteralPath $DeploymentRoot

    if (-not (Invoke-MoveWithRetry -Source $StagingServerDirectory -Destination $ServerDirectory)) {
        throw "Could not move staged server/ into place (source locked)."
    }
    if (-not (Invoke-MoveWithRetry -Source $StagingWebDirectory -Destination $WebDirectory)) {
        throw "Could not move staged web/ into place (source locked)."
    }
    Write-Host "==> Staged build moved into place (server/, web/)"

    # Keep maintenance mode through the new app's boot so players never see a
    # half-started app. /api/docs is exempt inside the app, so the health check
    # below still works.
    Enable-Maintenance -ServerDir $ServerDirectory

    # ---------- Step 10: Start new process via PM2 ----------
    Set-Location -LiteralPath $ServerDirectory

    # The entry script was located under .staging\server during the build;
    # after the cutover move that path no longer exists (the tree now lives at
    # server\). Remap it to the live tree — the stale path here is what failed
    # the 2026-09-04 second deployment ("Entry script does not exist").
    $stagingPrefix = [regex]::Escape($StagingServerDirectory)
    $builtMainScript = $builtMainScript -replace $stagingPrefix, $ServerDirectory
    if (-not (Test-Path -LiteralPath $builtMainScript -PathType Leaf)) {
        # Fallback probe of the standard output locations in the live tree.
        $builtMainScript = $null
        foreach ($candidate in @(
            (Join-Path $ServerDirectory 'dist\main.js'),
            (Join-Path $ServerDirectory 'dist\src\main.js')
        )) {
            if (Test-Path -LiteralPath $candidate -PathType Leaf) {
                $builtMainScript = $candidate
                break
            }
        }
    }
    if (-not $builtMainScript) {
        throw "Entry script not found in live server/ after cutover"
    }

    Write-Host "==> PM2 starting $AppName (node $builtMainScript)"
    $env:NODE_ENV = 'production'
    pm2 start ecosystem.config.js --name $AppName
    if ($LASTEXITCODE -ne 0) {
        throw "PM2 start failed with exit code: $LASTEXITCODE."
    }
    pm2 save
    Write-Host "==> PM2 started application: $AppName"

    # ---------- Step 11: Health check ----------
    $servicePort = Get-ServicePort -ServerDir $ServerDirectory
    $healthOk = Test-AppHealth -Port $servicePort
    if (-not $healthOk) {
        throw "Health check failed, service did not start properly"
    }

    # ---------- Step 12: Disable maintenance (players auto-reload into game) ----------
    Disable-Maintenance -ServerDir $ServerDirectory

    # ---------- Step 13: Cleanup (best-effort) ----------
    # The new version is already healthy and serving traffic at this point.
    # Cleanup is pure housekeeping: a locked file (AV/indexer/PM2 daemon)
    # must NEVER fail the deployment and trigger a pointless rollback of a
    # healthy build. Any leftover is purged by the next deployment.
    if (Test-Path -LiteralPath $StagingDirectory -PathType Container) {
        Write-Host "==> Cleaning staging leftovers (best-effort)"
        Remove-TreeBestEffort $StagingDirectory | Out-Null
    }
    if (Test-Path -LiteralPath $SourceArchive -PathType Leaf) {
        Remove-Item -LiteralPath $SourceArchive -Force -ErrorAction SilentlyContinue
    }
    if (Test-Path -LiteralPath $BackupDir -PathType Container) {
        Write-Host "==> Deployment successful, cleaning backup (best-effort)"
        if (-not (Remove-TreeBestEffort $BackupDir)) {
            Write-Warning "Backup cleanup incomplete (some files are locked); leftover .rollback-backup will be purged on next deployment."
        }
    }

    Write-Host '===== Deployment completed successfully ====='
}
catch {
    # NOTE: Do NOT use Write-Error here. With $ErrorActionPreference='Stop' it
    # raises a NEW terminating error inside the catch block, which skips
    # Invoke-Rollback entirely (this exact bug turned a healthy deployment into
    # a rollback on 2026-09-04). Print diagnostics via Write-Host, roll back,
    # then exit non-zero.
    Write-Host "Deployment failed: $($_.Exception.Message)"
    Write-Host $_.ScriptStackTrace

    Invoke-Rollback

    exit 1
}
