@echo off
rem Build (if needed) and launch the MultiGrokState desktop GUI.
rem Requires the .NET SDK (8.0 or newer). The GUI talks to the CLI in this
rem repository, so it always matches the source you built it from.
setlocal
pushd "%~dp0MultiGrokStateGui" || exit /b 1

set "EXE=bin\Release\net8.0\MultiGrokStateGui.exe"
if not exist "%EXE%" (
  echo Building MultiGrokState GUI...
  dotnet build -c Release -v minimal || (popd & exit /b 1)
)

start "" "%EXE%"
popd
endlocal
