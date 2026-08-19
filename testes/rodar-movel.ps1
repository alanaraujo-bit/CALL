# Conduz o aplicativo de celular dentro do motor Chromium, num quadro do
# tamanho de um iPhone, contra um servidor de sinalizacao de verdade.
#
# Precisa do servidor com pasta de dados: criar grupo, escrever no canal e
# reabrir o aplicativo so provam alguma coisa se houver de fato um servidor
# guardando do outro lado.
#
#   powershell -File testes/rodar-movel.ps1

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Set-Location (Split-Path $PSScriptRoot -Parent)

Get-Process node -ErrorAction SilentlyContinue | Stop-Process -Force
Get-Process sinalizacao -ErrorAction SilentlyContinue | Stop-Process -Force
Remove-Item "testes\resultado.json" -ErrorAction SilentlyContinue

if (-not (Test-Path "target\release\sinalizacao.exe")) {
  Write-Output "O servidor nao esta compilado. Rode: cargo build --release -p sinalizacao"
  exit 1
}

$dados = Join-Path $env:TEMP ("call-movel-" + (Get-Random))
New-Item -ItemType Directory -Force $dados | Out-Null
$env:DADOS = $dados

Start-Process "target\release\sinalizacao.exe" -ArgumentList "8899" -WindowStyle Hidden
Start-Process node -ArgumentList "testes/servir.mjs" -WindowStyle Hidden
Start-Sleep -Seconds 2

$edge = "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
if (-not (Test-Path $edge)) { $edge = "C:\Program Files\Microsoft\Edge\Application\msedge.exe" }
$perfil = Join-Path $env:TEMP ("call-movel-perfil-" + (Get-Random))

$navegador = Start-Process $edge -PassThru -ArgumentList @(
  "--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
  "--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream",
  "--autoplay-policy=no-user-gesture-required",
  "--window-size=430,900",
  "--user-data-dir=`"$perfil`"",
  "http://127.0.0.1:8123/testes/movel.html"
)

$limite = (Get-Date).AddSeconds(120)
while (-not (Test-Path "testes\resultado.json") -and (Get-Date) -lt $limite) { Start-Sleep -Milliseconds 500 }

Stop-Process -Id $navegador.Id -Force -ErrorAction SilentlyContinue
Get-Process node -ErrorAction SilentlyContinue | Stop-Process -Force
Get-Process sinalizacao -ErrorAction SilentlyContinue | Stop-Process -Force
Remove-Item $perfil -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item $dados -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item Env:\DADOS -ErrorAction SilentlyContinue

if (-not (Test-Path "testes\resultado.json")) {
  Write-Output "Os testes nao produziram relatorio (a pagina travou antes do fim)."
  exit 1
}

$r = Get-Content "testes\resultado.json" -Raw | ConvertFrom-Json
foreach ($linha in $r.relatorio) {
  $marca = if ($linha.ok) { "ok   " } else { "FALHA" }
  Write-Output ("  {0} {1}" -f $marca, $linha.descricao)
  if (-not $linha.ok -and $linha.detalhe) { Write-Output ("        -> {0}" -f $linha.detalhe) }
}
Write-Output ""
if ($r.falhas -eq 0) {
  Write-Output ("Celular: os {0} testes passaram." -f $r.total)
  exit 0
}
Write-Output ("Celular: {0} de {1} falharam." -f $r.falhas, $r.total)
exit 1
