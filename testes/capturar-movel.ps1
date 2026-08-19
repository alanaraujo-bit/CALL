# Fotografa o aplicativo de celular em cada tela, para conferir o desenho.
#
#   powershell -File testes/capturar-movel.ps1
#   powershell -File testes/capturar-movel.ps1 -Cenas conversa,call
#
# As imagens saem em testes/capturas/movel-*.png.

param([string[]]$Cenas = @())

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Set-Location (Split-Path $PSScriptRoot -Parent)

if ($Cenas.Count -eq 0) {
  $Cenas = @("portal", "grupos", "grupo", "conversa", "emojis", "convite", "chamada", "tira", "voce", "voz", "perfil")
}

Get-Process node -ErrorAction SilentlyContinue | Stop-Process -Force
Get-Process sinalizacao -ErrorAction SilentlyContinue | Stop-Process -Force

$dados = Join-Path $env:TEMP ("call-cena-" + (Get-Random))
New-Item -ItemType Directory -Force $dados | Out-Null
$env:DADOS = $dados
New-Item -ItemType Directory -Force "testes\capturas" | Out-Null

Start-Process "target\release\sinalizacao.exe" -ArgumentList "8899" -WindowStyle Hidden
Start-Process node -ArgumentList "testes/servir.mjs" -WindowStyle Hidden
Start-Sleep -Seconds 2

$edge = "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
if (-not (Test-Path $edge)) { $edge = "C:\Program Files\Microsoft\Edge\Application\msedge.exe" }

foreach ($cena in $Cenas) {
  $perfil = Join-Path $env:TEMP ("call-cena-perfil-" + (Get-Random))
  $saida = Join-Path (Get-Location) "testes\capturas\movel-$cena.png"
  Remove-Item $saida -ErrorAction SilentlyContinue

  $processo = Start-Process $edge -PassThru -Wait -ArgumentList @(
    "--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
    "--hide-scrollbars", "--force-device-scale-factor=1",
    "--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream",
    "--autoplay-policy=no-user-gesture-required",
    "--screenshot=`"$saida`"",
    "--window-size=390,844",
    "--user-data-dir=`"$perfil`"",
    "http://127.0.0.1:8123/testes/cena-movel.html?cena=$cena"
  )

  if (Test-Path $saida) { Write-Output "  movel-$cena.png" }
  else { Write-Output "  FALHOU: $cena" }
  Remove-Item $perfil -Recurse -Force -ErrorAction SilentlyContinue
}

Get-Process node -ErrorAction SilentlyContinue | Stop-Process -Force
Get-Process sinalizacao -ErrorAction SilentlyContinue | Stop-Process -Force
Remove-Item $dados -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item Env:\DADOS -ErrorAction SilentlyContinue

Write-Output ""
Write-Output "Capturas em testes/capturas/"
