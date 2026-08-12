# Responde a única pergunta sobre a supressão neural que não se responde
# lendo código: o plano do LiveKit Cloud libera o Krisp?
#
# O filtro carrega e trata áudio sem plano nenhum — a licença só é conferida
# ao entrar numa sala, e a recusa faz o CALL cair para o supressor nativo sem
# quebrar nada. Por isso o ensaio percorre o caminho de produção inteiro,
# contra o servidor de sinalização real, e olha o motor que sobrou.
#
#   powershell -File testes\rodar-krisp-licenca.ps1

param(
  [string]$Servidor = "wss://sinalizacao-production.up.railway.app"
)

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Set-Location (Split-Path $PSScriptRoot -Parent)

$resultado = Join-Path (Get-Location) "testes\resultado.json"
if (Test-Path -LiteralPath $resultado) { [IO.File]::Delete($resultado) }

$estatico = Start-Process node -ArgumentList "testes/servir.mjs" -WindowStyle Hidden -PassThru
$navegador = $null
$perfil = Join-Path $env:TEMP ("call-krisp-licenca-" + (Get-Random))

try {
  Start-Sleep -Seconds 1
  $edge = "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
  if (-not (Test-Path -LiteralPath $edge)) {
    $edge = "C:\Program Files\Microsoft\Edge\Application\msedge.exe"
  }

  $endereco = [Uri]::EscapeDataString($Servidor)
  # Dispositivo falso, e nao trilha do Web Audio: o filtro neural aplica
  # constraints de dispositivo e recusa o que nao vem de um.
  $navegador = Start-Process $edge -PassThru -ArgumentList @(
    "--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
    "--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream",
    "--autoplay-policy=no-user-gesture-required", "--user-data-dir=$perfil",
    "http://127.0.0.1:8123/testes/krisp-licenca.html?servidor=$endereco"
  )

  $limite = (Get-Date).AddSeconds(70)
  while (-not (Test-Path -LiteralPath $resultado) -and (Get-Date) -lt $limite) {
    Start-Sleep -Milliseconds 300
  }
  if (-not (Test-Path -LiteralPath $resultado)) { throw "O ensaio da licenca nao produziu relatorio." }
  $resumo = Get-Content -LiteralPath $resultado -Raw | ConvertFrom-Json
  foreach ($linha in $resumo.relatorio) {
    Write-Output ("  {0} {1}" -f $(if ($linha.ok) { "ok   " } else { "FALHA" }), $linha.descricao)
  }
  if ($resumo.falhas -ne 0) { throw "Licenca do filtro neural: $($resumo.falhas) falha(s)." }
  Write-Output "Licenca do filtro neural: o plano libera."
} finally {
  if ($navegador) { Stop-Process -Id $navegador.Id -Force -ErrorAction SilentlyContinue }
  Stop-Process -Id $estatico.Id -Force -ErrorAction SilentlyContinue
  # O Edge solta os arquivos do perfil um instante depois de morrer, entao a
  # limpeza e melhor-esforco: uma sobra em %TEMP% nao pode transformar um
  # ensaio que passou em um ensaio que falhou.
  $perfilAbsoluto = [IO.Path]::GetFullPath($perfil)
  $tempAbsoluto = [IO.Path]::GetFullPath($env:TEMP).TrimEnd("\") + "\"
  if ($perfilAbsoluto.StartsWith($tempAbsoluto) -and (Test-Path -LiteralPath $perfilAbsoluto)) {
    Start-Sleep -Milliseconds 500
    try { [IO.Directory]::Delete($perfilAbsoluto, $true) } catch {}
  }
}
