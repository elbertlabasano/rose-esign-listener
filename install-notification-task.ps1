# Run once as Administrator from the installed listener folder.
[CmdletBinding()]
param(
    [string]$NodePath = 'C:\Program Files\nodejs\node.exe',
    [string]$TaskName = 'Rose Esign Notifications'
)
$ErrorActionPreference = 'Stop'
if (-not (Test-Path -LiteralPath $NodePath -PathType Leaf)) { throw "Node not found: $NodePath" }
$launcher = Join-Path $PSScriptRoot 'notification-agent.vbs'
if (-not (Test-Path -LiteralPath $launcher -PathType Leaf)) { throw "Missing helper: $launcher" }
if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
    throw "Task '$TaskName' already exists. Edit it or remove it explicitly before installing again."
}
$action = New-ScheduledTaskAction -Execute "$env:SystemRoot\System32\wscript.exe" -Argument ('"{0}" "{1}"' -f $launcher, $NodePath) -WorkingDirectory $PSScriptRoot
$trigger = New-ScheduledTaskTrigger -AtLogOn
# Group principal runs in the session of the user who logs on, not Session 0.
$principal = New-ScheduledTaskPrincipal -GroupId 'S-1-5-32-545' -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -MultipleInstances Parallel -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Description 'Show e-sign notifications in each logged-in user session; does not process PDFs.' | Out-Null
Write-Host "Installed '$TaskName'. Sign out and back in, or run node notification-agent.js in each existing user session to start immediately."
Write-Host 'Keep the separate Rose Esign Listener startup task running as SYSTEM.'
