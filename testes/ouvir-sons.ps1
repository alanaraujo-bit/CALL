# Abre a pagina dos quatro sons no navegador padrao, para ouvi-los.
# Deixa o servidor de pe: feche esta janela para encerra-lo.

$ErrorActionPreference = "Stop"
Set-Location (Split-Path $PSScriptRoot -Parent)

$servidor = Start-Process node -ArgumentList "testes/servir.mjs" -PassThru -WindowStyle Hidden
Start-Sleep -Seconds 1
Start-Process "http://127.0.0.1:8123/testes/ouvir-sons.html"

Write-Output "Servindo em http://127.0.0.1:8123/testes/ouvir-sons.html"
Write-Output "Enter para encerrar o servidor."
[void](Read-Host)
Stop-Process -Id $servidor.Id -Force -ErrorAction SilentlyContinue
