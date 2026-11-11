# Stop deputy's watcher and stop it starting at logon. Your config and state in ~\.deputy are kept.
param([string]$TaskName = "deputy PR review watcher")
$state = if ($env:DEPUTY_HOME) { $env:DEPUTY_HOME } else { Join-Path $env:USERPROFILE '.deputy' }
$pidFile = Join-Path $state 'watcher.pid'
if (Test-Path $pidFile) {
  $id = [int](Get-Content $pidFile)
  Stop-Process -Id $id -ErrorAction SilentlyContinue
  Write-Host "Stopped the watcher (pid $id)."
}
if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
  Write-Host "Removed '$TaskName'."
}
