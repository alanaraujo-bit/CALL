# Mede, nesta máquina, o custo de cada codec de vídeo para uma tela 1080p60
# no motor Chromium: encoder de hardware ou de software, tempo por quadro,
# quadros por segundo e banda. Não é aprovado/reprovado — é a medida que
# decide o codec dos perfis de transmissão (ver `src/rtc.js`).
#
# Roda com GPU ligada (sem `--disable-gpu`), porque é exatamente o encoder de
# hardware que está sendo medido.

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Set-Location (Split-Path $PSScriptRoot -Parent)

$resultado = Join-Path (Get-Location) "testes\resultado.json"
Remove-Item -LiteralPath $resultado -ErrorAction SilentlyContinue

$estatico = Start-Process node -ArgumentList "testes/servir.mjs" -WindowStyle Hidden -PassThru
$navegador = $null
$perfil = Join-Path $env:TEMP ("call-codecs-" + (Get-Random))

try {
  Start-Sleep -Seconds 1
  $edge = "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
  if (-not (Test-Path -LiteralPath $edge)) {
    $edge = "C:\Program Files\Microsoft\Edge\Application\msedge.exe"
  }
  $navegador = Start-Process $edge -PassThru -ArgumentList @(
    "--headless=new", "--no-first-run", "--no-default-browser-check",
    "--disable-background-timer-throttling", "--disable-renderer-backgrounding",
    "--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream",
    "--user-data-dir=$perfil",
    "http://127.0.0.1:8123/testes/codecs.html"
  )

  $limite = (Get-Date).AddSeconds(90)
  while (-not (Test-Path -LiteralPath $resultado) -and (Get-Date) -lt $limite) {
    Start-Sleep -Milliseconds 500
  }
  if (-not (Test-Path -LiteralPath $resultado)) { throw "A medição dos codecs não produziu relatório." }
  $r = Get-Content -LiteralPath $resultado -Raw | ConvertFrom-Json
  Write-Output $r.navegador
  $r.medidas | Format-Table codec, suportado, implementacao, hardware, quadrosPorSegundo, msPorQuadro, mbps, qpMedio, resolucao, limitadoPor -AutoSize | Out-String -Width 220
} finally {
  if ($navegador) { Stop-Process -Id $navegador.Id -Force -ErrorAction SilentlyContinue }
  Stop-Process -Id $estatico.Id -Force -ErrorAction SilentlyContinue
  $perfilAbsoluto = [IO.Path]::GetFullPath($perfil)
  $tempAbsoluto = [IO.Path]::GetFullPath($env:TEMP).TrimEnd("\") + "\"
  if ($perfilAbsoluto.StartsWith($tempAbsoluto) -and (Test-Path -LiteralPath $perfilAbsoluto)) {
    Remove-Item -LiteralPath $perfilAbsoluto -Recurse -Force -ErrorAction SilentlyContinue
  }
}
