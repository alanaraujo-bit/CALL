# Fotografa a pagina de apresentacao com o seletor de plataforma aberto,
# no desktop e num quadro do tamanho de um celular.
#
#   powershell -File testes/capturar-site.ps1
#
# O quadro existe porque o Chromium headless ignora a meta viewport: fotografar
# a janela em 390 px direto sai com o layout de desktop recortado, e nao com a
# pagina como ela aparece num telefone.

$ErrorActionPreference = "Continue"
Set-Location (Split-Path $PSScriptRoot -Parent)
Get-Process node -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Process node -ArgumentList "testes/servir.mjs" -WindowStyle Hidden
Start-Sleep -Seconds 2
$edge = "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
$raiz = (Get-Location).Path
foreach ($alvo in @(
  @{ nome = "site-escolha"; url = "http://127.0.0.1:8123/docs/index.html#baixar"; tam = "1200,900" },
  @{ nome = "site-escolha-celular"; url = "http://127.0.0.1:8123/testes/cena-site.html"; tam = "390,844" }
)) {
  $perfil = Join-Path $env:TEMP ("call-site-" + (Get-Random))
  Start-Process $edge -PassThru -Wait -ArgumentList @(
    "--headless=new","--disable-gpu","--no-first-run","--hide-scrollbars","--force-device-scale-factor=1",
    "--screenshot=`"$raiz\testes\capturas\$($alvo.nome).png`"",
    "--window-size=$($alvo.tam)","--user-data-dir=`"$perfil`"", $alvo.url
  ) | Out-Null
  Remove-Item $perfil -Recurse -Force -ErrorAction SilentlyContinue
  Write-Output "  $($alvo.nome).png"
}
Get-Process node -ErrorAction SilentlyContinue | Stop-Process -Force
