# Verifica o convite por link de ponta a ponta, na janela real.
#
# Prova duas coisas que so o aplicativo compilado pode provar:
#   1. com o CALL aberto, um `call://entrar/CODIGO` troca de grupo na janela
#      que ja existe — e nao abre uma segunda;
#   2. com o CALL fechado, o mesmo link abre o aplicativo, espera a tela de
#      entrada ser preenchida e so entao entra no grupo.
#
# Uso: powershell -File testes\convite.ps1

$ErrorActionPreference = "Stop"
Set-Location (Split-Path $PSScriptRoot -Parent)
Add-Type -AssemblyName System.Drawing, System.Windows.Forms

Add-Type @"
using System;
using System.Runtime.InteropServices;
public class J {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr h, ref POINT p);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint x, uint y, uint d, IntPtr e);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
  [DllImport("user32.dll")] public static extern bool MoveWindow(IntPtr h, int x, int y, int w, int t, bool r);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, IntPtr pid);
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint de, uint para, bool ligar);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }
  // O Windows recusa `SetForegroundWindow` vindo de um processo que nao tem o
  // foco, e recusa em silencio: o console que roda o teste fica por cima, o
  // clique cai nele, e a falha aparece muito depois, como um grupo que nao
  // existe. Emprestar a fila de entrada de quem esta na frente e o que faz a
  // troca ser aceita — e o resultado e conferido, nao presumido.
  public static bool Ativar(IntPtr h) {
    uint meu = GetCurrentThreadId();
    for (int i = 0; i < 8; i++) {
      uint frente = GetWindowThreadProcessId(GetForegroundWindow(), IntPtr.Zero);
      uint alvo = GetWindowThreadProcessId(h, IntPtr.Zero);
      AttachThreadInput(meu, frente, true);
      AttachThreadInput(meu, alvo, true);
      ShowWindow(h, 9);
      BringWindowToTop(h);
      SetForegroundWindow(h);
      AttachThreadInput(meu, alvo, false);
      AttachThreadInput(meu, frente, false);
      System.Threading.Thread.Sleep(300);
      if (GetForegroundWindow() == h) return true;
    }
    return false;
  }
  public static void Clique(IntPtr h, int cx, int cy) {
    if (!Ativar(h)) throw new Exception("a janela do CALL nao veio para a frente");
    System.Threading.Thread.Sleep(150);
    POINT p; p.X = cx; p.Y = cy; ClientToScreen(h, ref p);
    SetCursorPos(p.X, p.Y);
    System.Threading.Thread.Sleep(120);
    mouse_event(0x0002, 0, 0, 0, IntPtr.Zero);
    System.Threading.Thread.Sleep(90);
    mouse_event(0x0004, 0, 0, 0, IntPtr.Zero);
    System.Threading.Thread.Sleep(200);
  }
}
"@

$saida = "testes\capturas"
New-Item -ItemType Directory -Force $saida | Out-Null
$dados = Join-Path $env:TEMP "call-teste-convite"
Remove-Item $dados -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force $dados | Out-Null

$falhas = @()
function Conferir($descricao, $condicao) {
  if ($condicao) { Write-Output "  ok    $descricao" }
  else { Write-Output "  FALHA $descricao"; $script:falhas += $descricao }
}

function Capturar($handle, $nome) {
  Start-Sleep -Milliseconds 700
  $r = New-Object J+RECT
  [void][J]::GetClientRect($handle, [ref]$r)
  $canto = New-Object J+POINT
  [void][J]::ClientToScreen($handle, [ref]$canto)
  $bmp = New-Object System.Drawing.Bitmap(($r.R - $r.L), ($r.B - $r.T))
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.CopyFromScreen($canto.X, $canto.Y, 0, 0, (New-Object System.Drawing.Size($bmp.Width, $bmp.Height)))
  $g.Dispose()
  $bmp.Save((Join-Path $saida "$nome.png"), [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
}

function Digitar($texto) {
  [System.Windows.Forms.SendKeys]::SendWait($texto)
  Start-Sleep -Milliseconds 250
}

# Um clique para dar foco ao WebView — sem ele o SendKeys cai no vazio e a
# tela fica intacta. Dali em diante e teclado: a ordem de foco (apelido,
# "Usar um servidor proprio", campo do servidor, Hospedar, Continuar)
# sobrevive a mudancas de altura do cartao, que a coordenada nao sobrevive.
function PreencherEntrada($h, $apelido) {
  [J]::Clique($h, 794, 311)   # campo de apelido, com a janela em 1080x740
  Start-Sleep -Milliseconds 300
  Digitar "^a"
  Digitar $apelido
  Digitar "{TAB}"          # "Usar um servidor proprio"
  Digitar " "              # abre a secao recolhida
  Start-Sleep -Milliseconds 400
  Digitar "{TAB}"          # campo do servidor
  Digitar "^a"
  Digitar "ws://127.0.0.1:8787"
  Digitar "{TAB}{TAB}"     # Hospedar, Continuar
  Digitar "{ENTER}"
  Start-Sleep -Seconds 2
}

function CriarGrupo($h, $altura, $nome) {
  [J]::Clique($h, 95, $altura - 106)   # "Criar grupo", acima do rodape do perfil
  Start-Sleep -Milliseconds 700
  Digitar $nome
  Digitar "{ENTER}"
  Start-Sleep -Seconds 2
}

# O codigo do convite e sorteado pelo servidor. Le-lo do `grupos.json` e a
# unica forma de o teste saber qual endereco `call://` disparar.
function CodigoDe($nome) {
  $arquivo = Join-Path $dados "grupos.json"
  if (-not (Test-Path $arquivo)) {
    throw "o servidor nao gravou grupo nenhum: a janela nao chegou a criar os grupos"
  }
  $bruto = Get-Content $arquivo -Raw -Encoding UTF8
  $lista = $bruto | ConvertFrom-Json
  foreach ($g in $lista) {
    if ($g.nome -eq $nome) { return $g.codigo }
  }
  return $null
}

# Em qual grupo a janela realmente esta? A captura mostra, mas so a um humano.
# Uma mensagem escrita depois de entrar responde sozinha: ela cai num canal, e
# o canal pertence a um grupo so.
function CanaisDe($nome) {
  $lista = Get-Content (Join-Path $dados "grupos.json") -Raw -Encoding UTF8 | ConvertFrom-Json
  foreach ($g in $lista) {
    if ($g.nome -eq $nome) {
      return @($g.categorias | ForEach-Object { $_.canais } | ForEach-Object { $_.id })
    }
  }
  return @()
}

function EscreverMensagem($h, $texto) {
  [J]::Clique($h, 733, 660)   # caixa de mensagem, com a janela em 1080x740
  Start-Sleep -Milliseconds 300
  Digitar $texto
  Digitar "{ENTER}"
  Start-Sleep -Seconds 2
}

function MensagemCaiuEm($texto, $canais) {
  $arquivo = Join-Path $dados "mensagens.jsonl"
  if (-not (Test-Path $arquivo)) { return $false }
  foreach ($linha in Get-Content $arquivo -Encoding UTF8) {
    if (-not $linha.Trim()) { continue }
    $m = $linha | ConvertFrom-Json
    if ($m.texto -eq $texto -and $canais -contains $m.canal) { return $true }
  }
  return $false
}

function Janela($processo) {
  for ($i = 0; $i -lt 30; $i++) {
    $processo.Refresh()
    if ($processo.MainWindowHandle -ne 0) { return $processo.MainWindowHandle }
    Start-Sleep -Milliseconds 400
  }
  throw "a janela do CALL nao apareceu"
}

# ── Preparacao ────────────────────────────────────────────────────
Get-Process call, sinalizacao -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep -Milliseconds 800
Remove-Item (Join-Path $env:LOCALAPPDATA "br.com.call.app") -Recurse -Force -ErrorAction SilentlyContinue

$env:DADOS = $dados
$servidor = Start-Process "target\release\sinalizacao.exe" -ArgumentList "8787" -PassThru `
  -WindowStyle Hidden -RedirectStandardError (Join-Path $dados "servidor.err")
Start-Sleep -Seconds 1

# Um servidor local que morre no meio do teste faz o aplicativo dizer "nao foi
# possivel falar com o servidor", que e exatamente o sintoma de um convite que
# nao funcionou. Conferir separadamente evita acusar o inocente — e a causa
# mais comum e outra execucao de teste na mesma maquina, porque todos os
# roteiros daqui comecam matando `sinalizacao.exe`.
function ServidorVivo() {
  $servidor.Refresh()
  if (-not $servidor.HasExited) { return $true }
  Write-Output "        o servidor saiu com codigo $($servidor.ExitCode)"
  $log = Join-Path $dados "servidor.err"
  if ((Test-Path $log) -and (Get-Item $log).Length -gt 0) {
    Write-Output "        stderr: $(Get-Content $log -Raw)"
  } else {
    Write-Output "        sem stderr: foi morto de fora, e nao por defeito proprio"
  }
  return $false
}

# ── 1. Dois grupos, criados pela janela real ──────────────────────
Write-Output "`n--- preparando dois grupos ---"
$app = Start-Process "target\release\call.exe" -PassThru
$h = Janela $app
[void][J]::MoveWindow($h, 60, 40, 1080, 740, $true)
Start-Sleep -Milliseconds 800

PreencherEntrada $h "Alan Araujo"
$r = New-Object J+RECT
[void][J]::GetClientRect($h, [ref]$r)
$altura = $r.B - $r.T

CriarGrupo $h $altura "equipe"
CriarGrupo $h $altura "estudio"
Capturar $h "convite-01-dois-grupos"

$codigoEquipe = CodigoDe "equipe"
$codigoEstudio = CodigoDe "estudio"
Write-Output "  equipe=$codigoEquipe  estudio=$codigoEstudio"
Conferir "os dois grupos existem no servidor" ($codigoEquipe -and $codigoEstudio)

# O aplicativo fica no ultimo grupo criado; o link tera de traze-lo de volta.
Conferir "o esquema call:// esta registrado no sistema" `
  (Test-Path "HKCU:\Software\Classes\call\shell\open\command")

# ── 2. Link com o aplicativo aberto ───────────────────────────────
Write-Output "`n--- link com o CALL ja aberto ---"
$antes = (Get-Process call -ErrorAction SilentlyContinue).Count
Start-Process "call://entrar/$codigoEquipe"
Start-Sleep -Seconds 4
$depois = (Get-Process call -ErrorAction SilentlyContinue).Count
Capturar $h "convite-02-link-quente"

Conferir "nenhuma segunda instancia foi aberta" ($depois -eq $antes)
Conferir "a janela original continua viva" (-not $app.HasExited)

Conferir "o servidor local continua de pe" (ServidorVivo)
EscreverMensagem $h "cheguei pelo link quente"
Conferir "a janela trocou de grupo: escreveu num canal de equipe" `
  (MensagemCaiuEm "cheguei pelo link quente" (CanaisDe "equipe"))

# ── 3. Link com o aplicativo fechado ──────────────────────────────
Write-Output "`n--- link com o CALL fechado ---"
Get-Process call -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep -Seconds 2
# Perfil zerado: o convite tera de esperar a tela de entrada ser preenchida,
# que e o caso de quem clica no link sem nunca ter aberto o CALL.
Remove-Item (Join-Path $env:LOCALAPPDATA "br.com.call.app") -Recurse -Force -ErrorAction SilentlyContinue

Start-Process "call://entrar/$codigoEstudio"
Start-Sleep -Seconds 8
$frio = Get-Process call -ErrorAction SilentlyContinue | Select-Object -First 1
Conferir "o link abriu o CALL sozinho" ($null -ne $frio)

if ($frio) {
  $hf = Janela $frio
  [void][J]::MoveWindow($hf, 60, 40, 1080, 740, $true)
  Start-Sleep -Milliseconds 800
  Capturar $hf "convite-03-frio-entrada"
  PreencherEntrada $hf "Alan Araujo"
  Start-Sleep -Seconds 3
  Capturar $hf "convite-04-frio-no-grupo"

  EscreverMensagem $hf "cheguei pelo link frio"
  Conferir "o convite esperou a tela de entrada e entrou em estudio" `
    (MensagemCaiuEm "cheguei pelo link frio" (CanaisDe "estudio"))
}

# ── Encerramento ──────────────────────────────────────────────────
Get-Process call, sinalizacao -ErrorAction SilentlyContinue | Stop-Process -Force
Remove-Item Env:\DADOS -ErrorAction SilentlyContinue

Write-Output "`ncapturas em $saida"
if ($falhas.Count -gt 0) {
  Write-Output "`n$($falhas.Count) verificacao(oes) falharam."
  exit 1
}
Write-Output "`nTodas as verificacoes passaram."
