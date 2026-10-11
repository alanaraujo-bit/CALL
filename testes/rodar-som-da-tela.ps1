# Mede o tocador do som da tela no próprio motor Chromium, sob a CSP do
# aplicativo: o worklet carrega, toca sem faltar com a interface engasgando, e
# a reserva não descola o som da imagem.

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Set-Location (Split-Path $PSScriptRoot -Parent)

$resultado = Join-Path (Get-Location) "testes\resultado.json"
Remove-Item -LiteralPath $resultado -ErrorAction SilentlyContinue

$estatico = Start-Process node -ArgumentList "testes/servir.mjs" -WindowStyle Hidden -PassThru
$navegador = $null
$perfil = Join-Path $env:TEMP ("call-som-da-tela-" + (Get-Random))

try {
  Start-Sleep -Seconds 1
  $edge = "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
  if (-not (Test-Path -LiteralPath $edge)) {
    $edge = "C:\Program Files\Microsoft\Edge\Application\msedge.exe"
  }
  $navegador = Start-Process $edge -PassThru -ArgumentList @(
    "--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
    "--autoplay-policy=no-user-gesture-required",
    # O headless trata a página como oculta e segura os `setTimeout` por até
    # um segundo. O produtor deste ensaio anda por timer; no aplicativo, os
    # pedaços chegam pelo IPC e não dependem de timer nenhum. Sem isto o ensaio
    # mede o estrangulamento do Edge, e não o tocador.
    "--disable-background-timer-throttling", "--disable-renderer-backgrounding",
    "--user-data-dir=$perfil",
    "http://127.0.0.1:8123/testes/som-da-tela.html"
  )

  $limite = (Get-Date).AddSeconds(40)
  while (-not (Test-Path -LiteralPath $resultado) -and (Get-Date) -lt $limite) {
    Start-Sleep -Milliseconds 300
  }
  if (-not (Test-Path -LiteralPath $resultado)) { throw "O ensaio do som da tela não produziu relatório." }
  $resumo = Get-Content -LiteralPath $resultado -Raw | ConvertFrom-Json
  foreach ($linha in $resumo.relatorio) {
    Write-Output ("  {0} {1}" -f $(if ($linha.ok) { "ok   " } else { "FALHA" }), $linha.descricao)
  }
  if ($resumo.falhas -ne 0) { throw "Som da tela: $($resumo.falhas) falha(s)." }
  Write-Output "Som da tela: todos os testes passaram."
} finally {
  if ($navegador) { Stop-Process -Id $navegador.Id -Force -ErrorAction SilentlyContinue }
  Stop-Process -Id $estatico.Id -Force -ErrorAction SilentlyContinue
  $perfilAbsoluto = [IO.Path]::GetFullPath($perfil)
  $tempAbsoluto = [IO.Path]::GetFullPath($env:TEMP).TrimEnd("\") + "\"
  if ($perfilAbsoluto.StartsWith($tempAbsoluto) -and (Test-Path -LiteralPath $perfilAbsoluto)) {
    Remove-Item -LiteralPath $perfilAbsoluto -Recurse -Force -ErrorAction SilentlyContinue
  }
}
