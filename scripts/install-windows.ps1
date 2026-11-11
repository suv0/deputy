# Start deputy's watcher at every Windows logon, with no console window, and start it now.
#   powershell -ExecutionPolicy Bypass -File scripts\install-windows.ps1
#   ... -Config C:\path\to\deputy.config.json   (otherwise deputy finds ~\.deputy\config.json)
# Uses a per-user scheduled task (no admin needed) that runs `conhost --headless node deputy.mjs start`.
param(
  [string]$Config = "",
  [string]$TaskName = "deputy PR review watcher",
  [switch]$NoStart
)
$ErrorActionPreference = 'Stop'

$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { throw "Node.js 20 or newer is needed: https://nodejs.org" }
$deputy = Join-Path (Split-Path $PSScriptRoot -Parent) 'bin\deputy.mjs'
$state = if ($env:DEPUTY_HOME) { $env:DEPUTY_HOME } else { Join-Path $env:USERPROFILE '.deputy' }

& $node $deputy doctor
if ($LASTEXITCODE -ne 0) { Write-Warning "deputy doctor found problems; the watcher may not work until they're fixed." }

$arguments = "--headless `"$node`" `"$deputy`" start"
if ($Config) { $arguments += " --config `"$((Resolve-Path $Config).Path)`"" }

$action = New-ScheduledTaskAction -Execute "$env:WINDIR\System32\conhost.exe" -Argument $arguments -WorkingDirectory $state
$trigger = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 5)
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited

New-Item -ItemType Directory -Force $state | Out-Null
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force | Out-Null
Write-Host "Registered '$TaskName': deputy starts at every logon."

if (-not $NoStart) {
  Start-ScheduledTask -TaskName $TaskName
  Start-Sleep -Seconds 3
  & $node $deputy status
}
