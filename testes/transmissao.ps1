# Prova ponta a ponta da transmissao de tela entre duas instancias reais.
# Usa --auto-select-desktop-capture-source para escolher uma janela conhecida
# sem depender das coordenadas do seletor nativo.

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Set-Location (Split-Path $PSScriptRoot -Parent)
Add-Type -AssemblyName System.Drawing, System.Windows.Forms

Add-Type @"
using System;
using System.Runtime.InteropServices;
public class T {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr h, ref POINT p);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint x, uint y, uint d, IntPtr e);
  [DllImport("user32.dll")] public static extern bool MoveWindow(IntPtr h, int x, int y, int w, int t, bool r);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L,T,R,B; }
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X,Y; }
  public static void Clique(IntPtr h, int cx, int cy) {
    SetForegroundWindow(h); System.Threading.Thread.Sleep(180);
    POINT p; p.X=cx; p.Y=cy; ClientToScreen(h, ref p);
    SetCursorPos(p.X, p.Y); System.Threading.Thread.Sleep(120);
    mouse_event(0x0002,0,0,0,IntPtr.Zero); System.Threading.Thread.Sleep(90);
    mouse_event(0x0004,0,0,0,IntPtr.Zero); System.Threading.Thread.Sleep(220);
  }
}
"@

$saida = "testes\capturas"
New-Item -ItemType Directory -Force $saida | Out-Null

function Capturar($h, $nome) {
  [void][T]::SetForegroundWindow($h); Start-Sleep -Milliseconds 900
  $r = New-Object T+RECT; [void][T]::GetClientRect($h, [ref]$r)
  $c = New-Object T+POINT; [void][T]::ClientToScreen($h, [ref]$c)
  $bmp = New-Object System.Drawing.Bitmap(($r.R-$r.L), ($r.B-$r.T))
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.CopyFromScreen($c.X, $c.Y, 0, 0, $bmp.Size); $g.Dispose()
  $bmp.Save((Join-Path $saida "$nome.png"), [System.Drawing.Imaging.ImageFormat]::Png); $bmp.Dispose()
  Write-Output "  capturado: $nome"
}

function Digitar($t) { [System.Windows.Forms.SendKeys]::SendWait($t); Start-Sleep -Milliseconds 250 }

function AbrirInstancia($apelido, $x, $y) {
  $p = Start-Process "target\release\call.exe" -PassThru
  Start-Sleep -Seconds 6
  $p.Refresh()
  [void][T]::MoveWindow($p.MainWindowHandle, $x, $y, 1080, 740, $true)
  Start-Sleep -Milliseconds 600
  [T]::Clique($p.MainWindowHandle, 380, 300)
  Digitar "^a"; Digitar $apelido
  [T]::Clique($p.MainWindowHandle, 540, 470)
  Start-Sleep -Seconds 2
  return $p
}

Get-Process call, sinalizacao, mspaint -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep -Milliseconds 800
Remove-Item (Join-Path $env:LOCALAPPDATA "br.com.call.app") -Recurse -Force -ErrorAction SilentlyContinue
Start-Process "target\release\sinalizacao.exe" -ArgumentList "8787" -WindowStyle Hidden
Start-Sleep -Seconds 1

# Alvo da transmissao: uma janela clara e inconfundivel contra a interface escura.
$alvo = Start-Process mspaint -PassThru
Start-Sleep -Seconds 4
[void][T]::MoveWindow($alvo.MainWindowHandle, 1200, 700, 700, 400, $true)

# A instancia que transmite recebe a escolha automatica da fonte de captura.
$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = "--auto-select-desktop-capture-source=Paint"

Write-Output "Instancia A (transmite)"
$a = AbrirInstancia "ana ribeiro" 0 0
[T]::Clique($a.MainWindowHandle, 196, 24)
Start-Sleep -Milliseconds 600
Digitar "reuniao"; Start-Sleep -Milliseconds 300; Digitar "{ENTER}"
Start-Sleep -Seconds 4

Remove-Item Env:\WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS

Write-Output "Instancia B (recebe)"
$b = AbrirInstancia "bruno salles" 700 40
[T]::Clique($b.MainWindowHandle, 100, 74)
Start-Sleep -Seconds 6

Write-Output "Iniciando transmissao em A"
[T]::Clique($a.MainWindowHandle, 418, 672)
Start-Sleep -Seconds 8

Capturar $a.MainWindowHandle "30-A-transmitindo"
Capturar $b.MainWindowHandle "31-B-recebendo"

Write-Output "`n--- memoria transmitindo ---"
foreach ($i in @(@{n="A (transmite)"; p=$a}, @{n="B (recebe)   "; p=$b})) {
  $i.p.Refresh()
  Write-Output ("  {0}: WS={1:N1} MB  Private={2:N1} MB" -f $i.n, ($i.p.WorkingSet64/1MB), ($i.p.PrivateMemorySize64/1MB))
}

Stop-Process -Id $alvo.Id -Force -ErrorAction SilentlyContinue
