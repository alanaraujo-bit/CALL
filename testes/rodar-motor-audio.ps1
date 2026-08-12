# Mede a cadeia usada pelo aplicativo: captura, filtros, porta e trilha enviada.

param([switch]$MicrofoneReal, [switch]$Reabrir)

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Set-Location (Split-Path $PSScriptRoot -Parent)

$resultado = Join-Path (Get-Location) "testes\resultado.json"
Remove-Item -LiteralPath $resultado -ErrorAction SilentlyContinue

if (-not $MicrofoneReal) {
  # Uma frase de verdade diferencia um supressor funcionando de um que apenas
  # deixa um tom de laboratório passar. O WAV é artefato temporário dentro de target.
  $fala = Join-Path (Get-Location) "target\teste-fala.wav"
  Add-Type -AssemblyName System.Speech
  $sintetizador = New-Object System.Speech.Synthesis.SpeechSynthesizer
  $sintetizador.SetOutputToWaveFile($fala)
  $sintetizador.Speak("Teste de voz do CALL. Esta fala precisa chegar limpa até a chamada.")
  $sintetizador.Dispose()
}

$estatico = Start-Process node -ArgumentList "testes/servir.mjs" -WindowStyle Hidden -PassThru
$navegador = $null
$perfil = Join-Path $env:TEMP ("call-motor-audio-" + (Get-Random))

try {
  Start-Sleep -Seconds 1
  $edge = "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
  if (-not (Test-Path -LiteralPath $edge)) {
    $edge = "C:\Program Files\Microsoft\Edge\Application\msedge.exe"
  }
  $argumentos = @(
    "--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
    "--use-fake-ui-for-media-stream", "--autoplay-policy=no-user-gesture-required",
    "--user-data-dir=$perfil"
  )
  if (-not $MicrofoneReal) { $argumentos += "--use-fake-device-for-media-stream" }
  $url = "http://127.0.0.1:8123/testes/motor-audio.html"
  $parametros = @()
  if ($MicrofoneReal) { $parametros += "microfone=real" }
  if ($Reabrir) { $parametros += "reabrir=sim" }
  if ($parametros.Count) { $url += "?" + ($parametros -join "&") }
  $argumentos += $url
  $navegador = Start-Process $edge -PassThru -ArgumentList $argumentos

  # O ensaio com microfone real mede por 10 s e ainda refaz a captura para
  # cobrir a troca de canal; 30 s não davam margem para uma máquina carregada.
  $limite = (Get-Date).AddSeconds($(if ($MicrofoneReal) { 90 } else { 30 }))
  while (-not (Test-Path -LiteralPath $resultado) -and (Get-Date) -lt $limite) {
    Start-Sleep -Milliseconds 300
  }
  if (-not (Test-Path -LiteralPath $resultado)) { throw "O motor não produziu relatório." }
  $resumo = Get-Content -LiteralPath $resultado -Raw | ConvertFrom-Json
  foreach ($linha in $resumo.relatorio) {
    Write-Output ("  {0} {1}" -f $(if ($linha.ok) { "ok   " } else { "FALHA" }), $linha.descricao)
  }
  if ($resumo.falhas -ne 0) { throw "Motor de áudio: $($resumo.falhas) falha(s)." }
  Write-Output "Motor de áudio: todos os testes passaram."
} finally {
  if ($navegador) { Stop-Process -Id $navegador.Id -Force -ErrorAction SilentlyContinue }
  Stop-Process -Id $estatico.Id -Force -ErrorAction SilentlyContinue
  $perfilAbsoluto = [IO.Path]::GetFullPath($perfil)
  $tempAbsoluto = [IO.Path]::GetFullPath($env:TEMP).TrimEnd("\") + "\"
  if ($perfilAbsoluto.StartsWith($tempAbsoluto) -and (Test-Path -LiteralPath $perfilAbsoluto)) {
    Remove-Item -LiteralPath $perfilAbsoluto -Recurse -Force -ErrorAction SilentlyContinue
  }
}
