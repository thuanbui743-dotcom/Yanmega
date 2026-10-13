# Dragonfly launcher: runs the official starter with the Dragonfly agent and restarts it if it ever exits.
# Automatic restarts and reconnections are allowed by the Official Rules (section 4); the agent's behaviour
# is unchanged by a restart, and the starter resumes any game in progress.
#
# Usage (PowerShell):
#   .\runtime\run-agent.ps1                       # tournament and Testing games
#   .\runtime\run-agent.ps1 -Mode tournament      # tournament games only
#   .\runtime\run-agent.ps1 -Starter D:\path\to\altruagent-starter
param(
  [string]$Starter = (Join-Path $PSScriptRoot '..\..\vgc-ext\starter'),
  [ValidateSet('both', 'tournament', 'match')][string]$Mode = 'both'
)

$ErrorActionPreference = 'Continue'
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$Starter = (Resolve-Path $Starter).Path
$python = Join-Path $Starter '.venv\Scripts\python.exe'
if (-not (Test-Path $python)) { Write-Host "Starter venv not found at $python (see README: Running on the platform)"; exit 1 }
if (-not (Test-Path (Join-Path $Starter '.env'))) { Write-Host "Missing $Starter\.env with ALTRUAGENT_OFFICIAL_AGENT_KEY"; exit 1 }

# Only one copy may run with the key (two copies split games and fight over seat leases).
$running = Get-CimInstance Win32_Process -Filter "Name='python.exe'" | Where-Object { $_.CommandLine -match '-m agent' }
if ($running) { Write-Host "Dragonfly agent already running (pid $($running.ProcessId -join ', ')). Not starting a second copy."; exit 1 }

$flags = switch ($Mode) { 'both' { @('--tournament', '--match') } 'tournament' { @('--tournament') } 'match' { @('--match') } }
$logDir = Join-Path $repo 'logs'
New-Item -ItemType Directory -Force $logDir | Out-Null
$env:PYTHONPATH = Join-Path $repo 'runtime'
$env:PYTHONUNBUFFERED = '1'

$delay = 5
while ($true) {
  $log = Join-Path $logDir ("runtime-{0}.log" -f (Get-Date -Format 'yyyyMMdd'))
  $started = Get-Date
  "$(Get-Date -Format s) starting agent ($Mode)" | ForEach-Object { $_; Add-Content -Path $log -Value $_ -Encoding UTF8 }
  Push-Location $Starter
  try {
    & $python -m agent @flags --agent dragonfly_agent 2>&1 | ForEach-Object { "$_" } | ForEach-Object { $_; Add-Content -Path $log -Value $_ -Encoding UTF8 }
  } finally {
    Pop-Location
  }
  $code = $LASTEXITCODE
  # Back off if it keeps dying quickly; reset after a healthy run.
  if (((Get-Date) - $started).TotalMinutes -gt 5) { $delay = 5 } else { $delay = [Math]::Min($delay * 2, 120) }
  "$(Get-Date -Format s) agent exited (code $code); restarting in $delay s" | ForEach-Object { $_; Add-Content -Path $log -Value $_ -Encoding UTF8 }
  Start-Sleep -Seconds $delay
}
