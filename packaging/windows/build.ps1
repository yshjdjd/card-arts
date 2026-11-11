$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '../..')).Path
Set-Location -LiteralPath $root
$env:PYTHONUTF8 = '1'
$env:CARDARTS_BUILD_CONSOLE = '0'
$env:PYINSTALLER_CONFIG_DIR = Join-Path $root '.test-results/pyinstaller-cache'
$python = Join-Path $root '.desktop-build-env/Scripts/python.exe'
if (-not (Test-Path -LiteralPath $python)) {
    python -m venv .desktop-build-env
    if ($LASTEXITCODE -ne 0) { throw '创建独立构建环境失败' }
}
& $python -m pip install -r packaging/windows/requirements.lock.txt
if ($LASTEXITCODE -ne 0) { throw '安装桌面构建依赖失败' }
if (-not (Test-Path -LiteralPath 'frontend/node_modules')) {
    npm --prefix frontend ci
    if ($LASTEXITCODE -ne 0) { throw '安装前端依赖失败' }
}
npm --prefix frontend run build
if ($LASTEXITCODE -ne 0) { throw '前端构建失败' }
& $python -m PyInstaller CardArts.spec --noconfirm --distpath release --workpath .test-results/desktop-build
if ($LASTEXITCODE -ne 0) { throw 'Windows 打包失败；请先关闭旧的 CardArts 进程' }
Copy-Item -LiteralPath packaging/windows/使用说明.txt -Destination release/CardArts/使用说明.txt
Compress-Archive -LiteralPath release/CardArts -DestinationPath release/CardArts-Windows-x64.zip -Force
Write-Host '完成：release/CardArts/CardArts.exe 和 release/CardArts-Windows-x64.zip'
