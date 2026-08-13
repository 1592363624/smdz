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

    # 恢复数据库备份（如果部署时备份了）
    $DatabaseBackup = Join-Path $BackupDir 'smdz.db'
    if (Test-Path -LiteralPath $DatabaseBackup -PathType Leaf) {
        $DatabaseFile = Join-Path $DeploymentRoot 'smdz.db'
        Write-Host "==> Restoring database file from backup"
        Copy-Item -LiteralPath $DatabaseBackup -Destination $DatabaseFile -Force
        Remove-Item -LiteralPath $DatabaseBackup -Force
    }

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
function Test-AppHealth {
    param([int]$Port)

    Write-Host "==> Health check: Waiting for service to start (port $Port)"

    for ($i = 0; $i -lt 12; $i++) {
        Start-Sleep -Seconds 5

        try {
            $client = New-Object System.Net.Sockets.TcpClient
            $connect = $client.BeginConnect('localhost', $Port, $null, $null)
            $wait = $connect.AsyncWaitHandle.WaitOne(3000, $false)
            if ($wait -and $client.Connected) {
                $client.Close()
                Write-Host "Health check passed: port $Port is ready"
                return $true
            }
            $client.Close()
        } catch {
            Write-Host "Port $Port not ready (attempt $($i+1)/12)"
        }
    }

    Write-Error "Health check failed: service did not start within 60 seconds"
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

# ---------- Resolve database file path from .env ----------
function Get-DatabaseFilePath {
    param([string]$EnvFilePath)

    # 缺省：部署根目录下的 smdz.db（server/ 之外，安全位置）
    $default = Join-Path $DeploymentRoot 'smdz.db'
    if (-not (Test-Path -LiteralPath $EnvFilePath -PathType Leaf)) {
        return $default
    }

    $envContent = Get-Content -LiteralPath $EnvFilePath -Raw
    $match = [regex]::Match($envContent, 'DATABASE_URL\s*=\s*"?([^"\r\n]+)"?')
    if (-not $match.Success) {
        return $default
    }

    # 去掉 file: 前缀和首尾空白
    $path = ($match.Groups[1].Value.Trim()) -replace '^file:', ''
    $path = $path.Trim()
    if ([string]::IsNullOrWhiteSpace($path)) {
        return $default
    }

    # 相对路径(如 file:../smdz.db)由 Prisma 相对 schema 目录(server/prisma)解析
    if (-not [System.IO.Path]::IsPathRooted($path) -and -not ($path -match '^[A-Za-z]:')) {
        $schemaDir = Join-Path $ServerDirectory 'prisma'
        return [System.IO.Path]::GetFullPath((Join-Path $schemaDir $path))
    }

    # 绝对路径：统一为 Windows 反斜杠形式
    return $path.Replace('/', '\')
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

    # ---------- Step 3: Backup database file ----------
    # 数据库文件位置完全由 server/.env 的 DATABASE_URL 决定，
    # 这里解析该配置得到唯一真实路径后备份，防止部署删除 server/ 时丢失数据。
    # 用 try/catch 兜底：即使解析函数缺失或抛错，也回退到缺省路径，
    # 保证 $DatabaseFile 始终有值，避免严格模式下"变量未定义"报错。
    try {
        $DatabaseFile = Get-DatabaseFilePath -EnvFilePath (Join-Path $ServerDirectory '.env')
    } catch {
        $DatabaseFile = Join-Path $DeploymentRoot 'smdz.db'
    }
    $DatabaseBackup = Join-Path $BackupDir 'smdz.db'
    $dbRestored = $false
    if (Test-Path -LiteralPath $DatabaseFile -PathType Leaf) {
        Write-Host "==> Backing up database file: $DatabaseFile"
        if (-not (Test-Path -LiteralPath $BackupDir -PathType Container)) {
            New-Item -ItemType Directory -Path $BackupDir -Force | Out-Null
        }
        Copy-Item -LiteralPath $DatabaseFile -Destination $DatabaseBackup -Force
        $dbRestored = $true
        Write-Host "Database backed up to $DatabaseBackup"
    } else {
        Write-Host "No database file found at $DatabaseFile, will create new one"
    }

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

    # ---------- Step 5b: 将 DATABASE_URL 改写为指向部署根目录(server/ 之外)的绝对路径 ----------
    # 无论 .env 里写的是相对路径还是绝对路径，都统一改写为指向
    # $DeploymentRoot\smdz.db，保证数据库文件位于 server/ 之外，
    # 部署删除/重建 server/ 时不会丢失；且与备份/恢复解析逻辑一致。
    $EnvTarget = Join-Path $ServerDirectory '.env'
    if (-not (Test-Path -LiteralPath $EnvTarget -PathType Leaf)) {
        throw "server/.env not found, cannot normalize DATABASE_URL"
    }
    $absDbPath = (Join-Path $DeploymentRoot 'smdz.db').Replace('\', '/')
    $newDbUrl = "file:$absDbPath"
    $envLines = Get-Content -LiteralPath $EnvTarget
    $envLines = $envLines | ForEach-Object {
        if ($_ -match '^\s*DATABASE_URL\s*=') {
            "DATABASE_URL=`"$newDbUrl`""
        } else {
            $_
        }
    }
    # 使用无 BOM 的 UTF-8 写入，避免头部 BOM 影响 .env 解析
    $envContent = $envLines -join [Environment]::NewLine
    [System.IO.File]::WriteAllText($EnvTarget, $envContent, (New-Object System.Text.UTF8Encoding($false)))
    Write-Host "==> Normalized DATABASE_URL to $newDbUrl"

    # ---------- Step 5c: Restore database file ----------
    # 恢复目标同样由(改写后)server/.env 的 DATABASE_URL 解析，保证与运行路径一致。
    # 兜底：解析失败时恢复目标回退到部署根目录的 smdz.db。
    try {
        $restoreTarget = Get-DatabaseFilePath -EnvFilePath $EnvTarget
    } catch {
        $restoreTarget = Join-Path $DeploymentRoot 'smdz.db'
    }
    if ($dbRestored -and (Test-Path -LiteralPath $DatabaseBackup -PathType Leaf)) {
        Write-Host "==> Restoring database file from backup to $restoreTarget"
        $restoreDir = Split-Path -Parent $restoreTarget
        if (-not (Test-Path -LiteralPath $restoreDir -PathType Container)) {
            New-Item -ItemType Directory -Path $restoreDir -Force | Out-Null
        }
        Copy-Item -LiteralPath $DatabaseBackup -Destination $restoreTarget -Force
        Write-Host "Database restored to $restoreTarget"
        Remove-Item -LiteralPath $DatabaseBackup -Force
    } else {
        Write-Host "No database backup to restore, will create new database"
    }

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

    # ---------- Step 8: Database migration ----------
    Set-Location -LiteralPath $ServerDirectory
    Invoke-CheckedCommand npx 'Running database migrations' 'prisma' 'migrate' 'deploy'

    # ---------- Step 9: Seed data (idempotent) ----------
    Write-Host "==> Seeding data (idempotent upsert)"
    Invoke-CheckedCommand npx 'Seeding data' 'prisma' 'db' 'seed'

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