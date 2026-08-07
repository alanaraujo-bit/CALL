# Conduz o portal de conta na aplicacao real, dentro do motor Chromium.
#
# Precisa de um servidor de sinalizacao com pasta de dados: cadastro e login
# gravam contas em disco, e metade do que se prova aqui -- que a sessao
# sobrevive a reabertura, que a senha errada e recusada -- so existe se houver
# de fato um servidor guardando alguma coisa do outro lado.

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Set-Location (Split-Path $PSScriptRoot -Parent)

Get-Process node -ErrorAction SilentlyContinue | Stop-Process -Force
Get-Process sinalizacao -ErrorAction SilentlyContinue | Stop-Process -Force
Remove-Item "testes\resultado.json" -ErrorAction SilentlyContinue

$dados = Join-Path $env:TEMP ("call-portal-" + (Get-Random))
New-Item -ItemType Directory -Force $dados | Out-Null
$env:DADOS = $dados

Start-Process "target\release\sinalizacao.exe" -ArgumentList "8899" -WindowStyle Hidden
Start-Process node -ArgumentList "testes/servir.mjs" -WindowStyle Hidden
Start-Sleep -Seconds 2

$edge = "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
if (-not (Test-Path $edge)) { $edge = "C:\Program Files\Microsoft\Edge\Application\msedge.exe" }
$perfil = Join-Path $env:TEMP ("call-portal-perfil-" + (Get-Random))

$navegador = Start-Process $edge -PassThru -ArgumentList @(
  "--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
  "--user-data-dir=`"$perfil`"",
  "http://127.0.0.1:8123/testes/portal.html"
)

# Mais folgado que as outras suites: cada cadastro e cada login pagam um
# Argon2 do lado do servidor, de proposito.
$limite = (Get-Date).AddSeconds(150)
while (-not (Test-Path "testes\resultado.json") -and (Get-Date) -lt $limite) { Start-Sleep -Milliseconds 500 }

Stop-Process -Id $navegador.Id -Force -ErrorAction SilentlyContinue
Get-Process node -ErrorAction SilentlyContinue | Stop-Process -Force
Get-Process sinalizacao -ErrorAction SilentlyContinue | Stop-Process -Force
Remove-Item $perfil -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item $dados -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item Env:\DADOS -ErrorAction SilentlyContinue

if (-not (Test-Path "testes\resultado.json")) { Write-Output "Os testes nao produziram relatorio."; exit 1 }

$r = Get-Content "testes\resultado.json" -Raw | ConvertFrom-Json
foreach ($linha in $r.relatorio) {
  Write-Output ("  {0} {1}" -f $(if ($linha.ok) { "ok   " } else { "FALHA" }), $linha.descricao)
}
Write-Output ""
if ($r.falhas -eq 0) { Write-Output "Portal: todos os testes passaram."; exit 0 }
Write-Output ("Portal: {0} teste(s) falharam." -f $r.falhas)
exit 1
