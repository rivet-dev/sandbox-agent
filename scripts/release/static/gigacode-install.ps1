#!/usr/bin/env pwsh

$ErrorActionPreference = 'Stop'

[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

# Create bin directory for gigacode
$BinDir = $env:BIN_DIR
$GigacodeInstall = if ($BinDir) {
	$BinDir
} else {
	"${Home}\.gigacode\bin"
}

if (!(Test-Path $GigacodeInstall)) {
	New-Item $GigacodeInstall -ItemType Directory | Out-Null
}

$GigacodeExe = "$GigacodeInstall\gigacode.exe"
$Version = '__VERSION__'
$FileName = 'gigacode-x86_64-pc-windows-gnu.exe'

Write-Host
Write-Host "> Installing gigacode ${Version}"

# Download binary
$DownloadUrl = "https://releases.rivet.dev/sandbox-agent/${Version}/binaries/${FileName}"
Write-Host
Write-Host "> Downloading ${DownloadUrl}"
Invoke-WebRequest $DownloadUrl -OutFile $GigacodeExe -UseBasicParsing

# Install to PATH
Write-Host
Write-Host "> Installing gigacode"
$User = [System.EnvironmentVariableTarget]::User
$Path = [System.Environment]::GetEnvironmentVariable('Path', $User)
if (!(";${Path};".ToLower() -like "*;${GigacodeInstall};*".ToLower())) {
	[System.Environment]::SetEnvironmentVariable('Path', "${Path};${GigacodeInstall}", $User)
	$Env:Path += ";${GigacodeInstall}"
    Write-Host "Please restart your PowerShell session or run the following command to refresh the environment variables:"
    Write-Host "[System.Environment]::SetEnvironmentVariable('Path', '${Path};${GigacodeInstall}', [System.EnvironmentVariableTarget]::Process)"
}

Write-Host
Write-Host "> Checking installation"
gigacode.exe --version

Write-Host
Write-Host "gigacode was installed successfully to ${GigacodeExe}."
Write-Host "Run 'gigacode --help' to get started."
Write-Host
