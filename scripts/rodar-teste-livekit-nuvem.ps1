$ErrorActionPreference = "Stop"

# O Railway injeta todas as variaveis do servico. Para este teste local,
# mantemos apenas a configuracao do LiveKit e isolamos dados, contas e login
# da producao.
Remove-Item Env:DADOS -ErrorAction SilentlyContinue
Remove-Item Env:DATABASE_URL -ErrorAction SilentlyContinue
Remove-Item Env:GOOGLE_CLIENT_ID -ErrorAction SilentlyContinue
Remove-Item Env:GOOGLE_CLIENT_SECRET -ErrorAction SilentlyContinue

$servidor = Join-Path $PSScriptRoot "..\target\debug\sinalizacao.exe"
& $servidor 8898
exit $LASTEXITCODE
