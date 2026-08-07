# Mede os sons de entrada e saida da voz nas amostras renderizadas.
# Renderizacao offline: nao precisa de placa de som nem do servidor de sinalizacao.

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Set-Location (Split-Path $PSScriptRoot -Parent)

Get-Process node -ErrorAction SilentlyContinue | Stop-Process -Force
Remove-Item "testes\resultado.json" -ErrorAction SilentlyContinue

Start-Process node -ArgumentList "testes/servir.mjs" -WindowStyle Hidden
Start-Sleep -Seconds 2

$edge = "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
if (-not (Test-Path $edge)) { $edge = "C:\Program Files\Microsoft\Edge\Application\msedge.exe" }
$perfil = Join-Path $env:TEMP ("call-sons-" + (Get-Random))

$navegador = Start-Process $edge -PassThru -ArgumentList @(
  "--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
  "--autoplay-policy=no-user-gesture-required",
  "--user-data-dir=`"$perfil`"",
  "http://127.0.0.1:8123/testes/sons.html"
)

$limite = (Get-Date).AddSeconds(60)
while (-not (Test-Path "testes\resultado.json") -and (Get-Date) -lt $limite) { Start-Sleep -Milliseconds 500 }

Stop-Process -Id $navegador.Id -Force -ErrorAction SilentlyContinue
Get-Process node -ErrorAction SilentlyContinue | Stop-Process -Force
Remove-Item $perfil -Recurse -Force -ErrorAction SilentlyContinue

if (-not (Test-Path "testes\resultado.json")) { Write-Output "Os testes nao produziram relatorio."; exit 1 }

$r = Get-Content "testes\resultado.json" -Raw -Encoding UTF8 | ConvertFrom-Json
foreach ($linha in $r.relatorio) {
  $marca = if ($linha.ok) { "ok   " } else { "FALHA" }
  if ($linha.medida) { Write-Output ("  {0} {1}  [{2}]" -f $marca, $linha.descricao, $linha.medida) }
  else { Write-Output ("  {0} {1}" -f $marca, $linha.descricao) }
}
Write-Output ""
if ($r.falhas -eq 0) { Write-Output "Sons: todos os testes passaram."; exit 0 }
Write-Output ("Sons: {0} falha(s)." -f $r.falhas); exit 1
