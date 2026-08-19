# Fotografa o aplicativo de desktop em cada cena de testes/cena.html, para
# conferir o desenho sem precisar compilar e clicar na janela real.
#
#   powershell -File testes/capturar-desktop.ps1
#   powershell -File testes/capturar-desktop.ps1 -Cenas voz,voz-chat
#
# As imagens saem em testes/capturas/desktop-*.png.

param([string[]]$Cenas = @())

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Set-Location (Split-Path $PSScriptRoot -Parent)

if ($Cenas.Count -eq 0) {
  $Cenas = @("entrada", "login", "cadastro", "editor", "grupo", "voz", "voz-chat", "cartao")
}

Get-Process node -ErrorAction SilentlyContinue | Stop-Process -Force
Get-Process sinalizacao -ErrorAction SilentlyContinue | Stop-Process -Force

# Sem DADOS: este servidor nao deve deixar grupo nenhum gravado em disco.
Start-Process "target\release\sinalizacao.exe" -ArgumentList "8898" -WindowStyle Hidden
Start-Process node -ArgumentList "testes/servir.mjs" -WindowStyle Hidden
Start-Sleep -Seconds 2
New-Item -ItemType Directory -Force "testes\capturas" | Out-Null

$edge = "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
if (-not (Test-Path $edge)) { $edge = "C:\Program Files\Microsoft\Edge\Application\msedge.exe" }

foreach ($cena in $Cenas) {
  $perfil = Join-Path $env:TEMP ("call-cena-desktop-" + (Get-Random))
  $saida = Join-Path (Get-Location) "testes\capturas\desktop-$cena.png"
  Remove-Item $saida -ErrorAction SilentlyContinue

  Start-Process $edge -PassThru -Wait -ArgumentList @(
    "--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
    "--hide-scrollbars", "--force-device-scale-factor=1",
    "--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream",
    "--autoplay-policy=no-user-gesture-required",
    "--screenshot=`"$saida`"",
    "--window-size=1180,780",
    "--user-data-dir=`"$perfil`"",
    "http://127.0.0.1:8123/testes/cena.html?cena=$cena"
  ) | Out-Null

  if (Test-Path $saida) { Write-Output "  desktop-$cena.png" }
  else { Write-Output "  FALHOU: $cena" }
  Remove-Item $perfil -Recurse -Force -ErrorAction SilentlyContinue
}

Get-Process node -ErrorAction SilentlyContinue | Stop-Process -Force
Get-Process sinalizacao -ErrorAction SilentlyContinue | Stop-Process -Force

Write-Output ""
Write-Output "Capturas em testes/capturas/"
