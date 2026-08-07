# Sobe duas instancias reais do aplicativo no mesmo grupo e comprova que elas
# se enxergam, conversam por texto e estabelecem a conexao de voz.
#
# As instancias compartilham o perfil do WebView2, e portanto o localStorage:
# o grupo criado pela primeira ja aparece na lista da segunda, que entra nele
# sem precisar digitar o codigo do convite.

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
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
  [DllImport("user32.dll")] public static extern bool MoveWindow(IntPtr h, int x, int y, int w, int t, bool r);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }
  public static void Clique(IntPtr h, int cx, int cy) {
    SetForegroundWindow(h);
    System.Threading.Thread.Sleep(180);
    POINT p; p.X = cx; p.Y = cy; ClientToScreen(h, ref p);
    SetCursorPos(p.X, p.Y);
    System.Threading.Thread.Sleep(120);
    mouse_event(0x0002, 0, 0, 0, IntPtr.Zero);
    System.Threading.Thread.Sleep(90);
    mouse_event(0x0004, 0, 0, 0, IntPtr.Zero);
    System.Threading.Thread.Sleep(220);
  }
}
"@

$saida = "testes\capturas"
New-Item -ItemType Directory -Force $saida | Out-Null

function Capturar($h, $nome) {
  [void][J]::SetForegroundWindow($h)   # traz a janela alvo para a frente
  Start-Sleep -Milliseconds 900
  $r = New-Object J+RECT; [void][J]::GetClientRect($h, [ref]$r)
  $c = New-Object J+POINT; [void][J]::ClientToScreen($h, [ref]$c)
  $w = $r.R - $r.L; $t = $r.B - $r.T
  $bmp = New-Object System.Drawing.Bitmap($w, $t)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.CopyFromScreen($c.X, $c.Y, 0, 0, (New-Object System.Drawing.Size($w, $t)))
  $g.Dispose()
  $bmp.Save((Join-Path $saida "$nome.png"), [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
  Write-Output "  capturado: $nome"
}

function Digitar($t) { [System.Windows.Forms.SendKeys]::SendWait($t); Start-Sleep -Milliseconds 250 }

function Cliente($h) {
  $r = New-Object J+RECT
  [void][J]::GetClientRect($h, [ref]$r)
  return @{ w = $r.R - $r.L; h = $r.B - $r.T }
}

function AbrirInstancia($apelido, $x, $y) {
  # Sem isto a segunda chamada morreria na partida: o aplicativo passou a ser
  # de instancia unica para que o link `call://` chegue a janela ja aberta.
  $env:CALL_INSTANCIAS_MULTIPLAS = "1"
  $p = Start-Process "target\release\call.exe" -PassThru
  Start-Sleep -Seconds 6
  $p.Refresh()
  $h = $p.MainWindowHandle
  [void][J]::MoveWindow($h, $x, $y, 1080, 740, $true)
  Start-Sleep -Milliseconds 600

  $c = Cliente $h
  # Coordenadas medidas na tela de entrada com a janela em 1080x740. Ela nao
  # muda de tamanho durante o teste, e o cartao e centrado.
  [J]::Clique($h, 794, 311)          # campo de apelido
  Digitar "^a"; Digitar $apelido

  # O padrao do aplicativo e o servidor hospedado. O teste tem de apontar para
  # o servidor local: senao ele depende da internet, e pior, cria grupos de
  # verdade no servidor que os amigos usam.
  [J]::Clique($h, 727, 356)          # "Usar um servidor proprio"
  Start-Sleep -Milliseconds 500
  [J]::Clique($h, 735, 357)          # campo do servidor
  Digitar "^a"; Digitar "ws://127.0.0.1:8787"
  Start-Sleep -Milliseconds 300

  [J]::Clique($h, 794, 476)          # Continuar
  Start-Sleep -Seconds 2
  return @{ proc = $p; h = $h; cli = $c }
}

# A coluna de grupos tem 190 px; "Criar grupo" e o primeiro dos dois botoes
# empilhados logo acima do rodape do perfil. Medir a janela em vez de fixar
# coordenadas evita que o teste quebre a cada ajuste de altura.
function PontoCriarGrupo($c) { return @{ x = 95; y = $c.h - 106 } }
function PontoPrimeiroGrupo() { return @{ x = 95; y = 74 } }

Get-Process call, sinalizacao -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep -Milliseconds 800

# Zera o perfil do WebView2 para que a lista de grupos comece vazia e as
# coordenadas de clique sejam previsiveis entre execucoes.
Remove-Item (Join-Path $env:LOCALAPPDATA "br.com.call.app") -Recurse -Force -ErrorAction SilentlyContinue

Start-Process "target\release\sinalizacao.exe" -ArgumentList "8787" -WindowStyle Hidden
Start-Sleep -Seconds 1

Write-Output "Instancia A (ana)"
$a = AbrirInstancia "ana ribeiro" 0 0
$criar = PontoCriarGrupo $a.cli
[J]::Clique($a.h, $criar.x, $criar.y)
Start-Sleep -Milliseconds 700
Digitar "reuniao de equipe"; Start-Sleep -Milliseconds 300; Digitar "{ENTER}"
Start-Sleep -Seconds 4
Capturar $a.h "10-A-sozinha"

Write-Output "Instancia B (bruno)"
$b = AbrirInstancia "bruno salles" 760 40
$primeiro = PontoPrimeiroGrupo
[J]::Clique($b.h, $primeiro.x, $primeiro.y)
Start-Sleep -Seconds 5

Capturar $b.h "11-B-no-grupo"
Capturar $a.h "12-A-com-companhia"

Write-Output "Conversa por texto"
# O canal de texto ja abre sozinho ao entrar no grupo; o redator fica no rodape
# da coluna central.
$redator = @{ x = [int]($a.cli.w * 0.6); y = $a.cli.h - 40 }
[J]::Clique($a.h, $redator.x, $redator.y)
Digitar "bom dia, bruno"; Digitar "{ENTER}"
Start-Sleep -Seconds 2
Capturar $b.h "13-B-recebeu-a-mensagem"

Write-Output "Entrada no canal de voz"
# Segundo canal da arvore: "Sala de voz", logo abaixo de "geral". Medido na
# captura: o bloco do convite acima dele define esta altura.
$canalVoz = @{ x = 300; y = 198 }
[J]::Clique($a.h, $canalVoz.x, $canalVoz.y)
Start-Sleep -Seconds 2
[J]::Clique($b.h, $canalVoz.x, $canalVoz.y)
Start-Sleep -Seconds 6
Capturar $a.h "14-A-na-voz"
Capturar $b.h "15-B-na-voz"

Write-Output "`n--- memoria com dois participantes ---"
foreach ($i in @(@{n="A"; p=$a.proc}, @{n="B"; p=$b.proc})) {
  $i.p.Refresh()
  Write-Output ("  {0}: WS={1:N1} MB  Private={2:N1} MB" -f $i.n, ($i.p.WorkingSet64/1MB), ($i.p.PrivateMemorySize64/1MB))
}

# Deixar as instancias vivas prende o call.exe e faz a proxima compilacao
# falhar com "acesso negado" — um erro que nao tem nada a ver com o codigo.
Get-Process call, sinalizacao -ErrorAction SilentlyContinue | Stop-Process -Force
Write-Output "`nInstancias encerradas."
