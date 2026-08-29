# Fotografa a central de comando, aba por aba -- e confere que cada uma
# desenhou de verdade.
#
#   powershell -File testes/capturar-painel.ps1
#
# Semeia trinta dias de historia inventada antes (painel-semente.mjs), sobe o
# servidor com essa pasta e entra na conta do dono de verdade, pelo portal.
# A cena "negado" faz o contrario: entra com uma conta comum e prova que o
# icone do painel continua escondido.
#
# As imagens saem em testes/capturas/painel-*.png.

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Set-Location (Split-Path $PSScriptRoot -Parent)

$Abas = @("geral", "crescimento", "retencao", "pessoas", "grupos", "midia", "vivo", "feedback", "negado")

Get-Process node -ErrorAction SilentlyContinue | Stop-Process -Force
Get-Process sinalizacao -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep -Milliseconds 300

Write-Output "Semeando..."
node testes/painel-semente.mjs --so-dados
if ($LASTEXITCODE -ne 0) { Write-Output "A semeadura falhou."; exit 1 }

$dados = Join-Path (Get-Location) "testes\dados-painel"
$env:DADOS = $dados

# A escada de midia da bancada, igual a de painel-semente.mjs. Sem ela o
# servidor sobe com um degrau so (a malha) e a aba de midia nao teria o que
# desenhar -- as URLs nao levam a lugar nenhum, e ninguem tenta usa-las.
$env:LIVEKIT_URL = "wss://call-bancada.livekit.cloud"
$env:LIVEKIT_API_KEY = "chave-da-bancada"
$env:LIVEKIT_API_SECRET = "segredo-da-bancada-com-tamanho-suficiente"
$env:LIVEKIT_MINUTOS_MES = "5000"
$env:LIVEKIT_GB_MES = "50"
$env:LIVEKIT_RESERVA_URL = "wss://midia.aionixdev.com"
$env:LIVEKIT_RESERVA_API_KEY = "chave-reserva"
$env:LIVEKIT_RESERVA_API_SECRET = "segredo-reserva-com-tamanho-suficiente"
New-Item -ItemType Directory -Force "testes\capturas" | Out-Null

Start-Process "target\release\sinalizacao.exe" -ArgumentList "8788" -WindowStyle Hidden
Start-Process node -ArgumentList "testes/servir.mjs" -WindowStyle Hidden
Start-Sleep -Seconds 2

$edge = "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
if (-not (Test-Path $edge)) { $edge = "C:\Program Files\Microsoft\Edge\Application\msedge.exe" }

$falhas = 0
foreach ($aba in $Abas) {
  $perfil = Join-Path $env:TEMP ("call-painel-" + (Get-Random))
  $saida = Join-Path (Get-Location) "testes\capturas\painel-$aba.png"
  Remove-Item $saida -ErrorAction SilentlyContinue
  Remove-Item "testes\resultado.json" -ErrorAction SilentlyContinue

  # A cena "negado" entra com uma conta qualquer da semeadura -- todas
  # compartilham a mesma senha, porque nenhuma delas existe fora da bancada.
  $endereco = "http://127.0.0.1:8123/testes/cena-painel.html?aba=$aba&servidor=ws://127.0.0.1:8788"
  if ($aba -eq "negado") { $endereco += "&email=ana@exemplo.com" }

  Start-Process $edge -Wait -ArgumentList @(
    "--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
    "--hide-scrollbars", "--force-device-scale-factor=1",
    "--screenshot=`"$saida`"",
    "--window-size=1400,900",
    "--user-data-dir=`"$perfil`"",
    $endereco
  ) | Out-Null

  $veredito = "sem relatorio"
  if (Test-Path "testes\resultado.json") {
    $veredito = (Get-Content "testes\resultado.json" -Raw | ConvertFrom-Json).titulo
  }

  if ($veredito -eq "PRONTO" -and (Test-Path $saida)) {
    Write-Output ("  ok    {0}" -f $aba)
  } else {
    Write-Output ("  FALHA {0} -- {1}" -f $aba, $veredito)
    $falhas++
  }
}

Get-Process node -ErrorAction SilentlyContinue | Stop-Process -Force
Get-Process sinalizacao -ErrorAction SilentlyContinue | Stop-Process -Force
Remove-Item Env:\DADOS -ErrorAction SilentlyContinue

Write-Output ""
if ($falhas -eq 0) {
  Write-Output "Painel: todas as abas desenharam. Capturas em testes/capturas/"
  exit 0
}
Write-Output ("Painel: {0} falha(s)." -f $falhas)
exit 1
