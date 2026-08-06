# Sobe duas instancias reais do aplicativo na mesma sala e comprova
# que elas se enxergam e estabelecem a conexao ponto a ponto.

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

function AbrirInstancia($apelido, $x, $y) {
  $p = Start-Process "target\release\call.exe" -PassThru
  Start-Sleep -Seconds 6
  $p.Refresh()
  $h = $p.MainWindowHandle
  [void][J]::MoveWindow($h, $x, $y, 1080, 740, $true)
  Start-Sleep -Milliseconds 600

  [J]::Clique($h, 380, 300)          # campo de apelido
  Digitar "^a"; Digitar $apelido
  [J]::Clique($h, 540, 470)          # Continuar
  Start-Sleep -Seconds 2
  return @{ proc = $p; h = $h }
}

Get-Process call, sinalizacao -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep -Milliseconds 800

# Zera o perfil do WebView2 para que a lista de grupos comece vazia e as
# coordenadas de clique sejam previsiveis entre execucoes.
Remove-Item (Join-Path $env:LOCALAPPDATA "br.com.call.app") -Recurse -Force -ErrorAction SilentlyContinue

Start-Process "target\release\sinalizacao.exe" -ArgumentList "8787" -WindowStyle Hidden
Start-Sleep -Seconds 1

Write-Output "Instancia A (ana)"
$a = AbrirInstancia "ana ribeiro" 0 0
[J]::Clique($a.h, 196, 24)           # novo grupo
Start-Sleep -Milliseconds 600
Digitar "reuniao"; Start-Sleep -Milliseconds 300; Digitar "{ENTER}"
Start-Sleep -Seconds 4
Capturar $a.h "10-A-sozinha"

Write-Output "Instancia B (bruno)"
$b = AbrirInstancia "bruno salles" 760 40
# O grupo ja existe na lista (preferencias compartilhadas): e o primeiro item.
[J]::Clique($b.h, 100, 74)
Start-Sleep -Seconds 6

Capturar $b.h "11-B-na-sala"
Capturar $a.h "12-A-com-companhia"

Write-Output "`n--- memoria com dois participantes ---"
foreach ($i in @(@{n="A"; p=$a.proc}, @{n="B"; p=$b.proc})) {
  $i.p.Refresh()
  Write-Output ("  {0}: WS={1:N1} MB  Private={2:N1} MB" -f $i.n, ($i.p.WorkingSet64/1MB), ($i.p.PrivateMemorySize64/1MB))
}
