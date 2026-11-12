# Stop deputy (the guard first, so it doesn't bring the core back) and stop it starting at logon.
# Your config and state in ~\.deputy are kept.
param([string]$TaskName = "deputy PR review watcher")
$state = if ($env:DEPUTY_HOME) { $env:DEPUTY_HOME } else { Join-Path $env:USERPROFILE '.deputy' }
foreach ($name in 'guard.pid', 'watcher.pid') {
  $pidFile = Join-Path $state $name
  if (Test-Path $pidFile) {
    $id = [int](Get-Content $pidFile)
    Stop-Process -Id $id -ErrorAction SilentlyContinue
    Remove-Item $pidFile -ErrorAction SilentlyContinue
    Write-Host "Stopped $($name -replace '\.pid$', '') (pid $id)."
  }
}
if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
  Write-Host "Removed '$TaskName'."
}
