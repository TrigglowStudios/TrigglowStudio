import { spawn, type ChildProcess } from 'node:child_process';

/**
 * Keys held down, for push to talk / push to mute: Electron's global shortcuts only report a press, never the release.
 * A small loop (C# run by PowerShell) polls GetAsyncKeyState (Windows) every 25 ms and prints "<index> 1|0" when a
 * combination goes down or up. Polling never takes the key from other apps (it still types, the game still sees it).
 * ponytail: a polling child process; a native keyboard hook if the 25 ms or the extra process ever matter.
 */

const VK: Record<string, number> = {
  CommandOrControl: 0x11, Control: 0x11, Ctrl: 0x11, Command: 0x11, Shift: 0x10, Alt: 0x12, Option: 0x12, Super: 0x5b, Meta: 0x5b,
  Up: 0x26, Down: 0x28, Left: 0x25, Right: 0x27, Space: 0x20, Tab: 0x09, Enter: 0x0d, Home: 0x24, End: 0x23, PageUp: 0x21,
  PageDown: 0x22, Insert: 0x2d, Delete: 0x2e, Plus: 0xbb, Equal: 0xbb, Minus: 0xbd, Mouse4: 0x05, Mouse5: 0x06, CapsLock: 0x14,
  Backquote: 0xc0,
};

/** Windows virtual-key codes of an accelerator ('Ctrl+Shift+A', 'F13', 'Mouse4'); null if a part is unknown. */
export function vkCodes(accelerator: string): number[] | null {
  const codes: number[] = [];
  for (const part of accelerator.split('+')) {
    let code = VK[part];
    if (code === undefined && /^[A-Z0-9]$/.test(part)) code = part.charCodeAt(0);
    if (code === undefined && /^F([1-9]|1\d|2[0-4])$/.test(part)) code = 0x6f + Number(part.slice(1));
    if (code === undefined) return null;
    codes.push(code);
  }
  return codes.length ? codes : null;
}

let child: ChildProcess | null = null;

/** Watches these combinations (replacing the previous set); `onChange(index, down)`. An empty list stops watching. */
export function watchHeldKeys(accelerators: string[], onChange: (index: number, down: boolean) => void): void {
  child?.kill();
  child = null;
  if (process.platform !== 'win32' || !accelerators.length) return;
  const combos = accelerators.map((a) => vkCodes(a) ?? []);
  // The loop is C#, compiled once by Add-Type: an interpreted PowerShell loop cost ~2.5 % of a core (measured
  // 2026-11-02); this one sleeps between reads and costs next to nothing. It exits when the app is gone.
  const script = `
Add-Type -TypeDefinition @"
using System; using System.Diagnostics; using System.Runtime.InteropServices; using System.Threading;
public static class TrigglowKeys {
  [DllImport("user32.dll")] static extern short GetAsyncKeyState(int k);
  public static void Run(string spec, int parent) {
    // "124;17,125": one combination per ";", its keys' virtual-key codes by ",".
    var parts = spec.Split(';');
    var combos = new int[parts.Length][];
    for (var i = 0; i < parts.Length; i++) combos[i] = parts[i].Length == 0 ? new int[0] : Array.ConvertAll(parts[i].Split(','), int.Parse);
    var state = new bool[combos.Length];
    var first = true;
    for (var tick = 0; ; tick++) {
      for (var i = 0; i < combos.Length; i++) {
        var down = combos[i].Length > 0;
        foreach (var k in combos[i]) if ((GetAsyncKeyState(k) & 0x8000) == 0) { down = false; break; }
        if (first || state[i] != down) { state[i] = down; Console.Out.WriteLine(i + " " + (down ? 1 : 0)); Console.Out.Flush(); }
      }
      first = false;
      if (tick % 80 == 0) { try { Process.GetProcessById(parent); } catch { return; } }
      Thread.Sleep(25);
    }
  }
}
"@
[TrigglowKeys]::Run('${combos.map((c) => c.join(',')).join(';')}', ${process.pid})`;
  let proc: ChildProcess;
  try {
    proc = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
  } catch (err) {
    return console.warn('[key-hold] spawn failed:', (err as Error).message); // EPERM when antivirus/policy blocks powershell.exe
  }
  proc.on('error', (err) => console.warn('[key-hold] spawn failed:', err.message));
  let buf = '';
  proc.stdout?.on('data', (chunk: Buffer) => {
    buf += chunk.toString('utf8');
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const [i, d] = buf.slice(0, nl).trim().split(' ');
      buf = buf.slice(nl + 1);
      const index = Number(i);
      if (Number.isInteger(index) && index >= 0 && index < accelerators.length) onChange(index, d === '1');
    }
  });
  proc.on('exit', () => {
    if (child === proc) child = null;
  });
  child = proc;
}
