<#
.SYNOPSIS
  Registers a Windows Scheduled Task that runs the MeemX Tally Connector
  incremental sync every 15 minutes and at user logon.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\connector\register-scheduled-task.ps1 -IntervalMinutes 15
#>

param(
  [int]$IntervalMinutes = 15,
  [string]$TaskName = "MeemX-Tally-AutoSync",
  [string]$NodePath = ""
)

$ErrorActionPreference = "Stop"

$ConnectorDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepoRoot = Split-Path -Parent $ConnectorDir
$EnvFile = Join-Path $ConnectorDir ".env"

if (-not (Test-Path $EnvFile)) {
  $RootEnv = Join-Path $RepoRoot ".env"
  if (-not (Test-Path $RootEnv)) {
    throw "Missing .env configuration file. Copy connector/.env.example to connector/.env and fill in TALLY_COMPANY, SUPABASE_URL, and SUPABASE_SERVICE_ROLE_KEY."
  }
}

if (-not $NodePath) {
  $NodeCmd = Get-Command node -ErrorAction SilentlyContinue
  if (-not $NodeCmd) {
    throw "Node.js executable not found in PATH. Install Node.js 20+ or pass -NodePath."
  }
  $NodePath = $NodeCmd.Source
}

$ScriptPath = Join-Path $ConnectorDir "sync.mjs"
$LogFile = Join-Path $ConnectorDir "sync-task.log"

$CmdArgs = "/c `"`"$NodePath`" `"$ScriptPath`" incremental >> `"$LogFile`" 2>&1`""
$Action = New-ScheduledTaskAction -Execute "cmd.exe" -Argument $CmdArgs -WorkingDirectory $RepoRoot

$TriggerRepeat = New-ScheduledTaskTrigger -Once -At (Get-Date).Date `
  -RepetitionInterval (New-TimeSpan -Minutes $IntervalMinutes) `
  -RepetitionDuration (New-TimeSpan -Days 3650)

$TriggerLogon = New-ScheduledTaskTrigger -AtLogOn

$Settings = New-ScheduledTaskSettingsSet `
  -StartWhenAvailable `
  -DontStopIfGoingOnBatteries `
  -AllowStartIfOnBatteries `
  -MultipleInstances IgnoreNew `
  -ExecutionTimeLimit (New-TimeSpan -Minutes 30)

Register-ScheduledTask `
  -TaskName $TaskName `
  -Action $Action `
  -Trigger @($TriggerRepeat, $TriggerLogon) `
  -Settings $Settings `
  -Description "MeemX ERP automatic Tally Prime -> Supabase incremental sync" `
  -Force | Out-Null

Write-Host "Registered scheduled task '$TaskName' (every $IntervalMinutes min)."
Write-Host "Logs will be written to: $LogFile"
