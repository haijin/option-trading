# Registers a Windows Task Scheduler job that runs `pnpm cli ingest --all` once a day.
# It is NOT run by the build: review it, then run it yourself from an elevated PowerShell in the repo root.
#   .\scripts\register-ingest-task.ps1 -At 18:30
# US closes 16:00 ET (04:00-05:00 HKT next day), HK closes 16:00 HKT: pick a time after both if you scan before the HK open.
param(
  [string]$At = '18:30',
  [string]$TaskName = 'OptionTrading-Ingest'
)
$repo = Split-Path -Parent $PSScriptRoot
$pnpm = (Get-Command pnpm -ErrorAction Stop).Source
$action = New-ScheduledTaskAction -Execute $pnpm -Argument 'cli ingest --all' -WorkingDirectory $repo
$trigger = New-ScheduledTaskTrigger -Weekly -DaysOfWeek Monday,Tuesday,Wednesday,Thursday,Friday -At $At
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Minutes 30)
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Description 'Fetch prices, fundamentals, US chains, events and FX for the sell-put scanner'
Write-Host "Registered '$TaskName' for weekdays at $At. Ingest exits non-zero when any step fails, so the task history shows failures."
