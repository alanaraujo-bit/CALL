# Dispara a transmissao em A escolhendo a janela do Paint no seletor nativo
# e captura as duas janelas. Assume que duas-instancias.ps1 ja rodou.

$ErrorActionPreference = "Stop"
Set-Location (Split-Path $PSScriptRoot -Parent)
Add-Type -AssemblyName System.Drawing

Add-Type @"
using System;
using System.Runtime.InteropServices;
public class C {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr h, ref POINT p);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint x, uint y, uint d, IntPtr e);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L,T,R,B; }
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X,Y; }
  public static void NaJanela(IntPtr h, int cx, int cy) {
    SetForegroundWindow(h); System.Threading.Thread.Sleep(220);
    POINT p; p.X=cx; p.Y=cy; ClientToScreen(h, ref p);
    SetCursorPos(p.X,p.Y); System.Threading.Thread.Sleep(120);
    mouse_event(0x0002,0,0,0,IntPtr.Zero); System.Threading.Thread.Sleep(90);
    mouse_event(0x0004,0,0,0,IntPtr.Zero); System.Threading.Thread.Sleep(300);
  }
  public static void NaTela(int x, int y) {
    SetCursorPos(x,y); System.Threading.Thread.Sleep(220);
    mouse_event(0x0002,0,0,0,IntPtr.Zero); System.Threading.Thread.Sleep(100);
    mouse_event(0x0004,0,0,0,IntPtr.Zero); System.Threading.Thread.Sleep(400);
  }
}
"@

function Capturar($h, $nome) {
  [void][C]::SetForegroundWindow($h); Start-Sleep -Milliseconds 1200
  $r = New-Object C+RECT; [void][C]::GetClientRect($h, [ref]$r)
  $c = New-Object C+POINT; [void][C]::ClientToScreen($h, [ref]$c)
  $bmp = New-Object System.Drawing.Bitmap(($r.R-$r.L), ($r.B-$r.T))
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.CopyFromScreen($c.X,$c.Y,0,0,$bmp.Size); $g.Dispose()
  $bmp.Save("testes\capturas\$nome.png", [System.Drawing.Imaging.ImageFormat]::Png); $bmp.Dispose()
  Write-Output "  capturado: $nome"
}

$apps = Get-Process call | Sort-Object StartTime
$a = $apps[0]; $b = $apps[1]

[C]::NaJanela($a.MainWindowHandle, 418, 672)   # Transmitir tela: abre o dialogo de qualidade
Start-Sleep -Seconds 1
[C]::NaJanela($a.MainWindowHandle, 664, 577)   # Compartilhar tela: confirma e chama o seletor nativo
Start-Sleep -Seconds 3
[C]::NaTela(715, 220)                          # miniatura do Paint
Start-Sleep -Milliseconds 800
[C]::NaTela(696, 444)                          # Compartilhar
Start-Sleep -Seconds 10

Capturar $b.MainWindowHandle "60-B-diagnostico"
Capturar $a.MainWindowHandle "61-A-diagnostico"
