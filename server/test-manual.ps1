$ErrorActionPreference = 'Stop'
$base = 'http://localhost:3333/api'
$user = 'lrtest' + (Get-Random -Maximum 9999)

# 1. 登录（自动创建账号）
$login = Invoke-RestMethod -Uri "$base/auth/dev/login" -Method Post -ContentType "application/json" -Body (ConvertTo-Json @{ username = $user })
$token = if ($login.accessToken) { $login.accessToken } else { $login.token }
$headers = @{ Authorization = "Bearer $token" }
Write-Host ("[账号] $user")
Write-Host ""

# 2. 选择使魔，确保 player.type 存在
try {
  $sel = Invoke-RestMethod -Uri "$base/commands/execute" -Method Post -ContentType "application/json" -Headers $headers -Body (ConvertTo-Json @{ command = '选择使魔 狼' })
  Write-Host ("[选择使魔] " + ($sel.data | Out-String).Trim())
} catch { Write-Host "[选择使魔 失败] $_" }
Write-Host ""

# 3. 查看使魔
$r = Invoke-RestMethod -Uri "$base/commands/execute" -Method Post -ContentType "application/json" -Headers $headers -Body (ConvertTo-Json @{ command = '查看使魔' })
Write-Host "===== 查看使魔 ====="
Write-Host ($r.data | Out-String)