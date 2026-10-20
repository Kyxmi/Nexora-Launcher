'use strict';

// Ce qui est propre à Windows :
//  - lire la liste des programmes installés (la même que « Applications » dans les Paramètres),
//  - lancer un installateur ou un désinstallateur et attendre qu'il se termine,
//  - deviner si un .exe est un installateur, et retrouver l'appli qu'il a installée.
// Les commandes passent par PowerShell, présent sur tous les Windows 10 et 11.

const { execFile } = require('child_process');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

const isWindows = process.platform === 'win32';
const CANCELLED = 1223; // l'utilisateur a refusé la fenêtre d'autorisation de Windows

function runPowerShell(script, { timeout = 60000 } = {}) {
  return new Promise((resolve, reject) => {
    const encoded = Buffer.from(script, 'utf16le').toString('base64');
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
      { windowsHide: true, timeout, maxBuffer: 64 * 1024 * 1024, encoding: 'utf8' },
      (err, stdout, stderr) => {
        if (err && typeof err.code !== 'number') return reject(err);
        resolve({ code: err ? err.code : 0, stdout: String(stdout || ''), stderr: String(stderr || '') });
      },
    );
  });
}

/* ---------- Programmes installés (registre « Uninstall ») ---------- */

const LIST_SCRIPT = String.raw`
$ErrorActionPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$roots = @(
  'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall',
  'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall',
  'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall'
)
$items = foreach ($root in $roots) {
  if (Test-Path $root) {
    foreach ($entry in Get-ChildItem -Path $root) {
      $p = Get-ItemProperty -Path $entry.PSPath
      [pscustomobject]@{
        key = [string]$entry.Name
        name = [string]$p.DisplayName
        version = [string]$p.DisplayVersion
        location = [string]$p.InstallLocation
        icon = [string]$p.DisplayIcon
        uninstall = [string]$p.UninstallString
      }
    }
  }
}
ConvertTo-Json -InputObject @($items) -Compress -Depth 3
`;

async function listPrograms() {
  if (!isWindows) return [];
  let result;
  try {
    result = await runPowerShell(LIST_SCRIPT, { timeout: 60000 });
  } catch {
    return [];
  }
  const text = result.stdout.replace(/^\uFEFF/, '').trim();
  if (!text) return [];
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return [];
  }
  const list = Array.isArray(data) ? data : [data];
  return list.filter((p) => p && p.key).map((p) => ({
    key: String(p.key),
    name: String(p.name || '').trim(),
    version: String(p.version || '').trim(),
    location: String(p.location || '').trim(),
    icon: String(p.icon || '').trim(),
    uninstall: String(p.uninstall || '').trim(),
  }));
}

/* ---------- Lancer un (dés)installateur et attendre sa fin ---------- */

const psQuote = (value) => `'${String(value).replace(/'/g, "''")}'`;

// Passe par Start-Process : Windows peut ainsi demander l'autorisation (UAC) si l'installateur en a besoin.
async function runAndWait(file, args = '') {
  if (!isWindows) throw new Error('Cette opération n’est possible que sous Windows.');
  const argumentList = args ? ` -ArgumentList ${psQuote(args)}` : '';
  const script = String.raw`
$ErrorActionPreference = 'Stop'
try {
  $process = Start-Process -FilePath FILE ARGS -PassThru
} catch {
  $e = $_.Exception
  while ($e) {
    if ($e -is [System.ComponentModel.Win32Exception] -and $e.NativeErrorCode -eq 1223) { exit 1223 }
    $e = $e.InnerException
  }
  [Console]::Error.WriteLine($_.Exception.Message)
  exit 1
}
$process.WaitForExit()
try { exit [int]$process.ExitCode } catch { exit 0 }
`.replace('FILE', () => psQuote(file)).replace(' ARGS', () => argumentList);
  const { code, stderr } = await runPowerShell(script, { timeout: 0 });
  return { code, error: stderr.trim() };
}

/* ---------- Outils de détection ---------- */

const normalize = (text) => String(text || '')
  .toLowerCase()
  .normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '')
  .replace(/[^a-z0-9]+/g, '');

// « "C:\Prog\App.exe" /S » ou « MsiExec.exe /X{…} » -> { file, args }
function parseCommand(command) {
  const text = String(command || '').trim();
  if (!text) return null;
  if (text.startsWith('"')) {
    const end = text.indexOf('"', 1);
    if (end < 0) return null;
    return { file: text.slice(1, end), args: text.slice(end + 1).trim() };
  }
  const match = text.match(/^(.+?\.exe)(\s+.*)?$/i);
  if (match) return { file: match[1], args: (match[2] || '').trim() };
  return { file: text, args: '' };
}

// « C:\Prog\App.exe,0 » -> « C:\Prog\App.exe » ; une icône .ico -> null
function exeFromIcon(icon) {
  const text = String(icon || '').trim();
  if (!text) return null;
  const quoted = text.match(/^"([^"]+)"/);
  const candidate = quoted ? quoted[1] : text.replace(/,\s*-?\d+\s*$/, '');
  return /\.exe$/i.test(candidate) ? candidate : null;
}

// Exécutables qui ne sont pas l'appli elle-même.
const HELPER_EXE = /^(unins|uninstall|update|squirrel|crashpad|elevate|notification_helper|vc_?redist|dxsetup|setup|install)/i;

// Compare la liste des programmes avant et après l'installation pour trouver celui qui vient d'être installé.
function findNewProgram(before, after, appName, knownKey) {
  if (knownKey) {
    const known = after.find((p) => p.key === knownKey);
    if (known) return known;
  }
  const signature = (p) => [p.name, p.version, p.location, p.icon].join('|');
  const previous = new Map(before.map((p) => [p.key, signature(p)]));
  const changed = after.filter((p) => p.name && previous.get(p.key) !== signature(p));
  const target = normalize(appName);
  const matches = (p) => {
    const n = normalize(p.name);
    return target.length >= 3 && n.length >= 3 && (n.includes(target) || target.includes(n));
  };
  if (changed.length === 1) return changed[0];
  const named = changed.filter(matches);
  if (named.length) return named[0];
  if (changed.length) return changed[0];
  return after.find(matches) || null; // réinstallation de la même version : rien n'a changé
}

// Retrouve le .exe de l'appli installée à partir des infos du registre.
async function findAppExe(program, appName) {
  const fromIcon = exeFromIcon(program.icon);
  if (fromIcon && !HELPER_EXE.test(path.basename(fromIcon)) && fs.existsSync(fromIcon)) return fromIcon;

  const folders = [];
  if (program.location) folders.push(program.location.replace(/^"+|"+$/g, ''));
  if (fromIcon) folders.push(path.dirname(fromIcon));
  const uninstall = parseCommand(program.uninstall);
  if (uninstall && /[\\/]/.test(uninstall.file)) folders.push(path.dirname(uninstall.file));

  const targets = [normalize(program.name), normalize(appName)].filter((t) => t.length >= 2);
  for (const folder of folders) {
    let files;
    try {
      files = await fsp.readdir(folder);
    } catch {
      continue;
    }
    const exes = files.filter((f) => /\.exe$/i.test(f) && !HELPER_EXE.test(f));
    if (!exes.length) continue;
    const scored = exes.map((file) => {
      const n = normalize(file.replace(/\.exe$/i, ''));
      let score = 0;
      for (const t of targets) {
        if (n === t) score = Math.max(score, 3);
        else if (n.length >= 3 && (t.includes(n) || n.includes(t))) score = Math.max(score, 2);
      }
      return { file, score };
    }).sort((a, b) => b.score - a.score);
    if (scored[0].score > 0 || exes.length === 1) return path.join(folder, scored[0].file);
  }
  return null;
}

// Un installateur se reconnaît à son nom (setup, install…) ou à la signature de l'outil qui l'a créé.
const INSTALLER_MARKERS = /Nullsoft|NSIS|Inno Setup|InstallShield|WixBundle|WiX Toolset|Squirrel|Setup Factory|Advanced Installer/;

async function looksLikeInstaller(file) {
  if (/setup|install/i.test(path.basename(file))) return true;
  const handle = await fsp.open(file, 'r');
  try {
    const { size } = await handle.stat();
    const chunk = 4 * 1024 * 1024;
    const regions = [[0, Math.min(size, chunk)]];
    if (size > chunk) regions.push([Math.max(chunk, size - chunk), Math.min(chunk, size - chunk)]);
    for (const [start, length] of regions) {
      const buffer = Buffer.alloc(length);
      await handle.read(buffer, 0, length, start);
      if (INSTALLER_MARKERS.test(buffer.toString('latin1'))) return true;
    }
    return false;
  } finally {
    await handle.close();
  }
}

module.exports = {
  isWindows,
  CANCELLED,
  listPrograms,
  runAndWait,
  parseCommand,
  exeFromIcon,
  findNewProgram,
  findAppExe,
  looksLikeInstaller,
  normalize,
};
