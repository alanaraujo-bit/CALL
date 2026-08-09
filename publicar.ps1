# Publica uma versao nova do CALL.
#
#   1. compila e assina o instalador
#   2. monta o latest.json que o atualizador dos aplicativos instalados le
#   3. cria a release no GitHub com os tres arquivos
#
# Depois disso, toda maquina que ja tem o CALL detecta a versao nova em ate
# meia hora e oferece a atualizacao com um clique.
#
# Antes de rodar: suba o numero da versao em src-tauri/tauri.conf.json e em
# src-tauri/Cargo.toml. Os dois precisam bater.
#
#   powershell -File publicar.ps1
#   powershell -File publicar.ps1 -SemCompilar    # reaproveita o build atual
#   powershell -File publicar.ps1 -Notas "Corrige o eco no microfone."

param(
  [switch]$SemCompilar,
  [string]$Notas = ""
)

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Set-Location $PSScriptRoot

$REPOSITORIO = "alanaraujo-bit/CALL"
$chave = "$env:USERPROFILE\.tauri\call-updater.key"
$senha = "$env:USERPROFILE\.tauri\call-updater.senha"

# ─── Conferencias antes de gastar cinco minutos compilando ──────────────

if (-not (Test-Path $chave)) {
  Write-Error "Chave de assinatura nao encontrada em $chave. Sem ela o atualizador das maquinas ja instaladas recusa o pacote."
}

$conf = Get-Content "src-tauri\tauri.conf.json" -Raw | ConvertFrom-Json
$versao = $conf.version
$cargo = Select-String -Path "src-tauri\Cargo.toml" -Pattern '^version = "(.+)"' | Select-Object -First 1
$versaoCargo = $cargo.Matches[0].Groups[1].Value

if ($versao -ne $versaoCargo) {
  Write-Error "Versoes divergentes: tauri.conf.json diz $versao e Cargo.toml diz $versaoCargo."
}

if (-not (Test-Path "src-tauri\binaries\sinalizacao-x86_64-pc-windows-msvc.exe")) {
  Write-Error "O sidecar de sinalizacao nao esta em src-tauri\binaries. Rode: cargo build --release -p sinalizacao"
}

# O gh escreve em stderr quando a release nao existe, que e justamente o caso
# esperado. Sem baixar a guarda aqui, esse ruido viraria erro terminante.
$anterior = $ErrorActionPreference
$ErrorActionPreference = "Continue"
gh release view "v$versao" --repo $REPOSITORIO *> $null
$jaExiste = ($LASTEXITCODE -eq 0)
$ErrorActionPreference = $anterior

if ($jaExiste) {
  Write-Error "A release v$versao ja existe. Suba o numero da versao antes de publicar."
}

Write-Output "Publicando CALL v$versao"

# ─── Compilacao assinada ────────────────────────────────────────────────

$instalador = "target\release\bundle\nsis\CALL_${versao}_x64-setup.exe"

if (-not $SemCompilar) {
  Write-Output "  compilando e assinando..."
  $env:TAURI_SIGNING_PRIVATE_KEY = (Get-Content $chave -Raw).Trim()
  $env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = (Get-Content $senha -Raw).Trim()

  # O tauri escreve andamento em stderr mesmo quando tudo da certo. No
  # PowerShell 5.1, com ErrorActionPreference em Stop, cada linha dessas vira
  # um erro terminante — e a publicacao morre depois de uma compilacao bem
  # sucedida. Quem decide se deu certo e o codigo de saida, so ele.
  $anterior = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  npx tauri build *> build.log
  $codigo = $LASTEXITCODE
  $ErrorActionPreference = $anterior

  if ($codigo -ne 0) {
    Write-Error "A compilacao falhou (codigo $codigo). O motivo esta em build.log."
  }
}

if (-not (Test-Path $instalador)) { Write-Error "Instalador nao encontrado em $instalador." }
if (-not (Test-Path "$instalador.sig")) {
  Write-Error "Assinatura nao encontrada. Sem ela nenhuma maquina aceita a atualizacao."
}

# O site nunca deve depender da API do GitHub para descobrir o nome da versão.
# Este alias vive em cada release e `releases/latest/download/CALL-setup.exe`
# redireciona direto para o instalador mais novo, inclusive com JavaScript
# desativado ou quando a API estiver temporariamente limitada.
$instaladorPublico = "target\release\bundle\nsis\CALL-setup.exe"
Copy-Item -LiteralPath $instalador -Destination $instaladorPublico -Force

# ─── Manifesto do atualizador ───────────────────────────────────────────

# O aplicativo instalado busca este arquivo, compara a versao com a sua e,
# se for mais nova, baixa a url abaixo e confere a assinatura.
$manifesto = [ordered]@{
  version   = $versao
  notes     = if ($Notas) { $Notas } else { "Versao $versao do CALL." }
  pub_date  = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
  platforms = [ordered]@{
    "windows-x86_64" = [ordered]@{
      signature = (Get-Content "$instalador.sig" -Raw).Trim()
      url       = "https://github.com/$REPOSITORIO/releases/download/v$versao/CALL_${versao}_x64-setup.exe"
    }
  }
}

$destino = "target\release\bundle\nsis\latest.json"

# Sem BOM: o `Set-Content -Encoding utf8` do PowerShell 5.1 grava a marca de
# ordem de bytes, e o leitor de JSON do atualizador recusa o arquivo inteiro
# por causa dela — silenciosamente, do ponto de vista de quem usa.
$semBom = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText(
  (Join-Path $PSScriptRoot $destino),
  ($manifesto | ConvertTo-Json -Depth 5),
  $semBom
)
Write-Output "  latest.json gerado"

# ─── Release ────────────────────────────────────────────────────────────

$corpo = @"
$(if ($Notas) { $Notas } else { "Versao $versao do CALL." })

**Instalacao:** baixe o ``.exe`` abaixo e execute. O Windows mostra um aviso
do SmartScreen porque o instalador nao tem assinatura de codigo: clique em
**Mais informacoes -> Executar assim mesmo**.

Quem ja tem o CALL instalado nao precisa baixar nada: o proprio aplicativo
detecta esta versao e oferece a atualizacao.
"@

gh release create "v$versao" `
  --repo $REPOSITORIO `
  --title "CALL v$versao" `
  --notes $corpo `
  $instalador "$instalador.sig" $destino $instaladorPublico

if ($LASTEXITCODE -ne 0) { Write-Error "Falha ao criar a release." }

Write-Output ""
Write-Output "Publicado: https://github.com/$REPOSITORIO/releases/tag/v$versao"
Write-Output "As instalacoes existentes detectam a versao nova em ate 30 minutos."
