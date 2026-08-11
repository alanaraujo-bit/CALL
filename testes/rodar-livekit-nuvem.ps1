# Valida transporte e detecção de fala contra o LiveKit configurado no servidor
# oficial, sob a mesma política de conteúdo usada pelo aplicativo empacotado.

param(
  [string]$Servidor = "wss://sinalizacao-production.up.railway.app"
)

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Set-Location (Split-Path $PSScriptRoot -Parent)

$resultado = Join-Path (Get-Location) "testes\resultado.json"
Remove-Item -LiteralPath $resultado -ErrorAction SilentlyContinue

$estatico = Start-Process node -ArgumentList "testes/servir.mjs" -WindowStyle Hidden -PassThru
$navegador = $null
$perfil = Join-Path $env:TEMP ("call-livekit-nuvem-" + (Get-Random))

try {
  Start-Sleep -Seconds 1
  $edge = "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
  if (-not (Test-Path -LiteralPath $edge)) {
    $edge = "C:\Program Files\Microsoft\Edge\Application\msedge.exe"
  }

  $endereco = [Uri]::EscapeDataString($Servidor)
  $url = "http://127.0.0.1:8123/testes/livekit-nuvem.html?servidor=$endereco"
  $navegador = Start-Process $edge -PassThru -ArgumentList @(
    "--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
    "--autoplay-policy=no-user-gesture-required",
    "--user-data-dir=$perfil",
    $url
  )

  $limite = (Get-Date).AddSeconds(45)
  while (-not (Test-Path -LiteralPath $resultado) -and (Get-Date) -lt $limite) {
    Start-Sleep -Milliseconds 300
  }
  if (-not (Test-Path -LiteralPath $resultado)) {
    throw "O teste LiveKit Cloud não produziu relatório em 45 segundos."
  }

  $resumo = Get-Content -LiteralPath $resultado -Raw | ConvertFrom-Json
  foreach ($linha in $resumo.relatorio) {
    Write-Output ("  {0} {1}" -f $(if ($linha.ok) { "ok   " } else { "FALHA" }), $linha.descricao)
  }
  if ($resumo.falhas -ne 0) {
    throw "LiveKit Cloud: $($resumo.falhas) falha(s)."
  }
  Write-Output ""
  Write-Output "LiveKit Cloud: todos os testes passaram."
} finally {
  if ($navegador) {
    Stop-Process -Id $navegador.Id -Force -ErrorAction SilentlyContinue
  }
  Stop-Process -Id $estatico.Id -Force -ErrorAction SilentlyContinue

  # O perfil é sempre criado dentro do TEMP. Conferir o caminho absoluto antes
  # da remoção evita que uma variável inesperada transforme a limpeza em algo amplo.
  $perfilAbsoluto = [IO.Path]::GetFullPath($perfil)
  $tempAbsoluto = [IO.Path]::GetFullPath($env:TEMP).TrimEnd("\") + "\"
  if ($perfilAbsoluto.StartsWith($tempAbsoluto) -and (Test-Path -LiteralPath $perfilAbsoluto)) {
    Remove-Item -LiteralPath $perfilAbsoluto -Recurse -Force -ErrorAction SilentlyContinue
  }
}
