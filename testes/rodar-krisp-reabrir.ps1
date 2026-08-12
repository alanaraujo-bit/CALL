# Exercita a supressão neural quando o microfone é reaberto no meio da call —
# trocar de microfone, mexer nos filtros do sistema, ou a recaptura automática
# depois de o filtro perder a licença. O filtro segue vivo enquanto a trilha
# que ele tratava é parada e outra entra no lugar.
#
# Usa o dispositivo falso do Chromium de propósito. O filtro neural aplica
# constraints de dispositivo e recusa trilhas do Web Audio, então o ensaio
# grande (`rodar-motor-audio.ps1`, que troca o getUserMedia) não alcança este
# ramo; e depender de um microfone físico deixaria o resultado à mercê de um
# fone sem fio desligar no meio.

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Set-Location (Split-Path $PSScriptRoot -Parent)

$resultado = Join-Path (Get-Location) "testes\resultado.json"
if (Test-Path -LiteralPath $resultado) { [IO.File]::Delete($resultado) }

$estatico = Start-Process node -ArgumentList "testes/servir.mjs" -WindowStyle Hidden -PassThru
$navegador = $null
$perfil = Join-Path $env:TEMP ("call-krisp-reabrir-" + (Get-Random))

try {
  Start-Sleep -Seconds 1
  $edge = "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
  if (-not (Test-Path -LiteralPath $edge)) {
    $edge = "C:\Program Files\Microsoft\Edge\Application\msedge.exe"
  }
  $argumentos = @(
    "--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
    "--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream",
    "--autoplay-policy=no-user-gesture-required", "--user-data-dir=$perfil",
    "http://127.0.0.1:8123/testes/krisp-reabrir.html"
  )
  $navegador = Start-Process $edge -PassThru -ArgumentList $argumentos

  $limite = (Get-Date).AddSeconds(60)
  while (-not (Test-Path -LiteralPath $resultado) -and (Get-Date) -lt $limite) {
    Start-Sleep -Milliseconds 300
  }
  if (-not (Test-Path -LiteralPath $resultado)) { throw "A supressão não produziu relatório." }
  $resumo = Get-Content -LiteralPath $resultado -Raw | ConvertFrom-Json
  foreach ($linha in $resumo.relatorio) {
    Write-Output ("  {0} {1}" -f $(if ($linha.ok) { "ok   " } else { "FALHA" }), $linha.descricao)
  }
  if ($resumo.falhas -ne 0) { throw "Supressão neural: $($resumo.falhas) falha(s)." }
  Write-Output "Supressão neural: todos os testes passaram."
} finally {
  if ($navegador) { Stop-Process -Id $navegador.Id -Force -ErrorAction SilentlyContinue }
  Stop-Process -Id $estatico.Id -Force -ErrorAction SilentlyContinue
  $perfilAbsoluto = [IO.Path]::GetFullPath($perfil)
  $tempAbsoluto = [IO.Path]::GetFullPath($env:TEMP).TrimEnd("\") + "\"
  if ($perfilAbsoluto.StartsWith($tempAbsoluto) -and (Test-Path -LiteralPath $perfilAbsoluto)) {
    [IO.Directory]::Delete($perfilAbsoluto, $true)
  }
}
