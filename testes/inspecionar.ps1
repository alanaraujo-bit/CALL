# Dirige a janela real do aplicativo e captura telas para inspecao visual.
# Uso: powershell -File testes\inspecionar.ps1

$ErrorActionPreference = "Stop"
Set-Location (Split-Path $PSScriptRoot -Parent)
Add-Type -AssemblyName System.Drawing, System.Windows.Forms

Add-Type @"
using System;
using System.Runtime.InteropServices;
public class Janela {
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
  $r = New-Object Janela+RECT
  [void][Janela]::GetClientRect($handle, [ref]$r)
  $canto = New-Object Janela+POINT
  [void][Janela]::ClientToScreen($handle, [ref]$canto)
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

function Digitar($texto) {
  [System.Windows.Forms.SendKeys]::SendWait($texto)
  Start-Sleep -Milliseconds 250
}

# ── Preparacao ────────────────────────────────────────────────────
Get-Process call, sinalizacao -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep -Milliseconds 600
Start-Process "target\release\sinalizacao.exe" -ArgumentList "8787" -WindowStyle Hidden

$app = Start-Process "target\release\call.exe" -PassThru
Start-Sleep -Seconds 6
$app.Refresh()
$h = $app.MainWindowHandle
if ($h -eq 0) { Write-Output "janela nao encontrada"; exit 1 }
[void][Janela]::ShowWindow($h, 9)
[void][Janela]::SetForegroundWindow($h)
Start-Sleep -Milliseconds 800

Capturar $h "01-entrada"

$r = New-Object Janela+RECT
[void][Janela]::GetClientRect($h, [ref]$r)
$altura = $r.B - $r.T

# ── Preenche a entrada ────────────────────────────────────────────
[Janela]::Clique($h, 380, 303)   # campo de apelido
Start-Sleep -Milliseconds 300
Digitar "^a"
Digitar "Alan Araujo"
Capturar $h "02-entrada-preenchida"

# Continuar
[Janela]::Clique($h, 540, 480)
Start-Sleep -Seconds 2
Capturar $h "03-aplicacao-vazia"

# ── Cria um grupo ─────────────────────────────────────────────────
# "Criar grupo" fica logo acima do rodape do perfil, na coluna de 190 px.
[Janela]::Clique($h, 95, $altura - 106)
Start-Sleep -Milliseconds 700
Capturar $h "04-dialogo-grupo"

Digitar "equipe"
Start-Sleep -Milliseconds 400
Digitar "{ENTER}"
Start-Sleep -Milliseconds 1200
Capturar $h "05-grupo-conectado"
Start-Sleep -Seconds 4
Capturar $h "06-grupo-estavel"

# ── Entra no canal de voz ─────────────────────────────────────────
[Janela]::Clique($h, 300, 198)   # "Sala de voz", segundo canal da arvore
Start-Sleep -Seconds 3
Capturar $h "07-na-voz"

Write-Output "`n--- memoria durante a chamada ---"
$app.Refresh()
Write-Output ("call.exe WS={0:N1} MB  Private={1:N1} MB" -f ($app.WorkingSet64/1MB), ($app.PrivateMemorySize64/1MB))
