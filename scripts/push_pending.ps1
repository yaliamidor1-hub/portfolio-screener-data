# push_pending.ps1 — pushes commits that the Cowork task made locally (its sandbox can read GitHub but not write to it).
# Run by a Windows scheduled task (see docs/setup-automation.md) every 30 minutes; it can also be run by hand.
# Safe by design: no --force, nothing is pushed unless the local branch is ahead, a rebase conflict aborts and logs instead of guessing,
# and a stale empty index.lock (no git process running, older than 2 minutes) is removed.
$ErrorActionPreference = 'Continue'
$repo = Split-Path -Parent $PSScriptRoot
Set-Location $repo
$log = Join-Path $repo '.work\push.log'
New-Item -ItemType Directory -Force (Split-Path $log) | Out-Null
function Log($m) { Add-Content -Path $log -Value ("{0} {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $m) }

$lock = Join-Path $repo '.git\index.lock'
if (Test-Path $lock) {
  $age = (Get-Date) - (Get-Item $lock).LastWriteTime
  if ($age.TotalMinutes -gt 2 -and -not (Get-Process git -ErrorAction SilentlyContinue)) { Remove-Item $lock -Force; Log 'removed a stale index.lock' }
  else { Log 'index.lock present, git is busy - skipped'; exit 0 }
}
git fetch origin main 2>&1 | Out-Null
$ahead = (git rev-list --count origin/main..HEAD 2>$null)
if (-not $ahead -or [int]$ahead -eq 0) { exit 0 }
git pull --rebase origin main 2>&1 | ForEach-Object { Log "pull: $_" }
if ($LASTEXITCODE -ne 0) { git rebase --abort 2>&1 | Out-Null; Log 'REBASE FAILED - aborted, nothing pushed (needs a look)'; exit 1 }
git push origin HEAD:main 2>&1 | ForEach-Object { Log "push: $_" }
if ($LASTEXITCODE -ne 0) { Log 'PUSH FAILED'; exit 1 }
Log "pushed $ahead commit(s)"
