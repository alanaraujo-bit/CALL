# Abre o painel de ajustes na janela real e deixa capturas para inspecao visual.
# Uso: powershell -File testes\ajustes.ps1
#
# O painel e testado por logica em testes\rodar-interface.ps1. Este roteiro
# existe para o que aquele nao alcanca: como fica dentro do WebView2, com a CSP
# do Tauri, os dispositivos de audio de verdade e a fonte do sistema.

$ErrorActionPreference = "Stop"
Set-Location (Split-Path $PSScriptRoot -Parent)
Add-Type -AssemblyName System.Drawing, System.Windows.Forms

Add-Type @"
using System;
using System.Runtime.InteropServices;
public class Janela2 {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr h, ref POINT p);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint x, uint y, uint d, IntPtr e);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }
  public static void Clique(IntPtr h, int cx, int cy) {
    SetForegroundWindow(h);
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

function Capturar($handle, $nome) {
  Start-Sleep -Milliseconds 700
  $r = New-Object Janela2+RECT
  [void][Janela2]::GetClientRect($handle, [ref]$r)
  $canto = New-Object Janela2+POINT
  [void][Janela2]::ClientToScreen($handle, [ref]$canto)
  $largura = $r.R - $r.L; $altura = $r.B - $r.T
  $bmp = New-Object System.Drawing.Bitmap($largura, $altura)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.CopyFromScreen($canto.X, $canto.Y, 0, 0, (New-Object System.Drawing.Size($largura, $altura)))
  $g.Dispose()
  $caminho = Join-Path $saida "$nome.png"
  $bmp.Save($caminho, [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
  Write-Output "capturado: $caminho ($largura x $altura)"
}

Get-Process call -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep -Milliseconds 600

$app = Start-Process "target\release\call.exe" -PassThru
Start-Sleep -Seconds 6
$app.Refresh()
$h = $app.MainWindowHandle
if ($h -eq 0) { Write-Output "janela nao encontrada"; exit 1 }
[void][Janela2]::ShowWindow($h, 9)
[void][Janela2]::SetForegroundWindow($h)
Start-Sleep -Milliseconds 800

$r = New-Object Janela2+RECT
[void][Janela2]::GetClientRect($h, [ref]$r)
$largura = $r.R - $r.L; $altura = $r.B - $r.T
Write-Output "cliente: $largura x $altura"

# Entrar. As coordenadas sao do cartao de entrada em 1080x700; se a janela
# mudar de tamanho, e aqui que este roteiro quebra — de proposito, porque uma
# quebra visivel e melhor do que um clique no lugar errado passando despercebido.
[Janela2]::Clique($h, 801, 310)
Start-Sleep -Milliseconds 300
[System.Windows.Forms.SendKeys]::SendWait("^a")
[System.Windows.Forms.SendKeys]::SendWait("Alan Araujo")
Start-Sleep -Milliseconds 300
[Janela2]::Clique($h, 801, 407)
Start-Sleep -Seconds 3
Capturar $h "10-aplicacao"

# Engrenagem: canto inferior direito da primeira coluna (190 px de largura).
[Janela2]::Clique($h, 168, $altura - 30)
Start-Sleep -Seconds 2
Capturar $h "11-ajustes-voz"

Write-Output "`n--- memoria com o painel aberto e o microfone em teste ---"
$app.Refresh()
Write-Output ("call.exe WS={0:N1} MB  Private={1:N1} MB" -f ($app.WorkingSet64/1MB), ($app.PrivateMemorySize64/1MB))
