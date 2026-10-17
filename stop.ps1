$ErrorActionPreference = 'SilentlyContinue'

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$ports = @(8000, 5173)

function Stop-Tree {
    param([int]$TargetId)
    if ($TargetId -gt 0 -and $TargetId -ne $PID) {
        & taskkill.exe /PID $TargetId /T /F *> $null
    }
}

Write-Host 'Stopping CardArts services...'

# 1) Launcher windows opened by start.bat (cmd /k "..." keeps the title).
& taskkill.exe /FI 'WINDOWTITLE eq CardArts Backend*' /T /F *> $null
& taskkill.exe /FI 'WINDOWTITLE eq CardArts Frontend*' /T /F *> $null

# 2) Any process whose command line points at this project.
$rootPattern = [regex]::Escape($root)
$keywordPattern = '(uvicorn|app\.main:app|npm-cli\.js|vite|esbuild)'

Get-CimInstance Win32_Process |
    Where-Object {
        $_.ProcessId -ne $PID -and
        $_.CommandLine -and
        $_.CommandLine -match $rootPattern -and
        $_.CommandLine -match $keywordPattern
    } |
    ForEach-Object {
        Write-Host ("  stop PID {0}" -f $_.ProcessId)
        Stop-Tree -TargetId $_.ProcessId
    }

# 3) Fallback: whatever still listens on our ports (kill parent first so the
#    uvicorn reloader cannot respawn its worker).
foreach ($port in $ports) {
    $listenerIds = @()

    $connections = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
    if ($connections) {
        $listenerIds = @($connections | Select-Object -ExpandProperty OwningProcess -Unique)
    } else {
        $rows = & netstat.exe -ano | Select-String -Pattern ":$port\s" | Select-String -Pattern 'LISTENING'
        foreach ($row in $rows) {
            $fields = $row.ToString().Trim() -split '\s+'
            $listenerIds += [int]$fields[-1]
        }
    }

    foreach ($listenerId in $listenerIds) {
        if (-not $listenerId) { continue }
        $proc = Get-CimInstance Win32_Process -Filter "ProcessId=$listenerId"
        if (-not $proc) { continue }

        $parentId = [int]$proc.ParentProcessId
        $parent = Get-CimInstance Win32_Process -Filter "ProcessId=$parentId"
        if ($parent -and $parent.CommandLine -match '(python|uvicorn|cmd\.exe|node|npm)') {
            Stop-Tree -TargetId $parentId
        }
        Stop-Tree -TargetId $listenerId
    }
}

# 4) Verify the ports are released.
Start-Sleep -Milliseconds 800

$busy = @()
foreach ($port in $ports) {
    $still = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
    if ($still) { $busy += $port }
}

if ($busy.Count -gt 0) {
    Write-Host ("[WARN] Port(s) still listening: {0}" -f ($busy -join ', '))
    exit 1
}

Write-Host 'OK: CardArts services stopped.'
exit 0
