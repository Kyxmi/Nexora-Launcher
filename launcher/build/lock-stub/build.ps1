# Compile build\lock-stub.exe avec le compilateur .NET Framework présent sur tous les Windows 10 et 11.
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$csc = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
& $csc /nologo /target:winexe /optimize+ /codepage:65001 /win32icon:"$here\..\icon.ico" /out:"$here\..\lock-stub.exe" "$here\LockStub.cs"
if ($LASTEXITCODE -ne 0) { throw 'Compilation échouée' }
Get-Item "$here\..\lock-stub.exe" | Select-Object Name, Length
