# Réserver une appli au Nexora-Launcher

## Ce que fait le launcher tout seul (rien à changer dans les applis)

Par défaut, le launcher réserve chaque appli installée : il renomme son vrai `.exe` en `.nxe` et met à la place un petit
programme (`launcher/build/lock-stub.exe`, source dans `launcher/build/lock-stub/`) qui affiche seulement :

> Il faut aller dans le Nexora Launcher, puis cliquer sur « Lancer » pour pouvoir lancer cette appli.

Le bouton **Lancer** du launcher démarre directement le vrai fichier. Concrètement :

- un double-clic sur le `.exe` de l'appli (ou sur un raccourci du bureau) affiche le message ;
- après une installation ou une mise à jour de l'appli, le launcher la réserve de nouveau (au démarrage, après l'installation, et à chaque clic sur **Lancer**) ;
- avant une désinstallation, le launcher remet le vrai `.exe`, pour que le désinstallateur de l'appli fonctionne ;
- l'interrupteur **Réserver mes applis au launcher** de **Paramètres** désactive le tout et remet les vrais `.exe`.

Limites : ce n'est pas une protection absolue (renommer le `.nxe` en `.exe` suffit à lancer l'appli), et un antivirus
trop zélé peut se méfier d'un petit programme inconnu placé dans le dossier d'une appli. Si le verrouillage échoue
(fichier occupé, accès refusé), l'appli reste lançable normalement.

## Variante : le contrôle dans l'appli elle-même (facultatif)

Quand le launcher lance une appli, il ajoute la variable d'environnement `NEXORA_LAUNCHER=1`
(et `NEXORA_LAUNCHER_VERSION`, la version du launcher). C'est à l'appli de vérifier ce signal
au démarrage : s'il manque, elle affiche ce message et se ferme.

> Il faut aller dans le Nexora Launcher, puis cliquer sur « Lancer » pour pouvoir lancer cette appli.

Le verrou du launcher (ci-dessus) suffit en général. Cette variante, à faire **dans le code de chaque appli**, ajoute
une seconde barrière qui reste en place même si quelqu'un renomme le `.nxe`. Comme l'autre, c'est une barrière de confort,
pas une protection contre quelqu'un qui définirait lui-même la variable.

Le contrôle doit être **désactivé en développement** (`npm run tauri dev`, `cargo run`…), sinon tu ne pourrais
plus tester ton appli : les exemples ci-dessous ne l'activent que dans les versions publiées.

## Nexora Craft (Tauri, Rust)

1. Dans `src-tauri/Cargo.toml`, ajoute `"Win32_UI_WindowsAndMessaging"` à la liste `features` de la dépendance `windows` :

   ```toml
   [target.'cfg(windows)'.dependencies]
   windows = { version = "0.61", features = [
     "Win32_Foundation",
     "Win32_UI_WindowsAndMessaging",
     # … les autres lignes restent
   ] }
   ```

2. Remplace `src-tauri/src/main.rs` par :

   ```rust
   // Prevents additional console window on Windows in release, DO NOT REMOVE!!
   #![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

   // L'appli ne s'ouvre que depuis le Nexora-Launcher, qui définit NEXORA_LAUNCHER=1 en la lançant.
   // Vérifié seulement dans les versions publiées : `tauri dev` reste utilisable.
   #[cfg(all(windows, not(debug_assertions)))]
   fn require_launcher() {
       if std::env::var("NEXORA_LAUNCHER").as_deref() == Ok("1") {
           return;
       }
       use windows::core::w;
       use windows::Win32::UI::WindowsAndMessaging::{MessageBoxW, MB_ICONERROR, MB_OK};
       unsafe {
           MessageBoxW(
               None,
               w!("Il faut aller dans le Nexora Launcher, puis cliquer sur « Lancer » pour pouvoir lancer cette appli."),
               w!("Nexora Craft"),
               MB_OK | MB_ICONERROR,
           );
       }
       std::process::exit(1);
   }

   fn main() {
       #[cfg(all(windows, not(debug_assertions)))]
       require_launcher();
       nexora_craft_lib::run()
   }
   ```

Attention : la mise à jour intégrée de Nexora Craft (le plugin `updater`) relance l'appli sans passer par le launcher :
après une mise à jour faite par l'appli elle-même, elle afficherait ce message. Laisse donc le launcher faire les mises à jour
(c'est le rôle du champ « Dépôt GitHub » dans la fiche de l'appli) et retire le plugin `tauri_plugin_updater` de l'appli, ou
fais-lui conserver la variable : `std::env::set_var` avant la relance ne suffit pas, la relance doit hériter de l'environnement.

## Electron / Node

À mettre tout en haut du processus principal :

```js
const { app, dialog } = require('electron');
if (app.isPackaged && process.env.NEXORA_LAUNCHER !== '1') {
  dialog.showErrorBox('Nexora', 'Il faut aller dans le Nexora Launcher, puis cliquer sur « Lancer » pour pouvoir lancer cette appli.');
  app.exit(1);
}
```

## Python (PyInstaller)

```python
import os, sys, ctypes
if getattr(sys, 'frozen', False) and os.environ.get('NEXORA_LAUNCHER') != '1':
    ctypes.windll.user32.MessageBoxW(0, 'Il faut aller dans le Nexora Launcher, puis cliquer sur « Lancer » pour pouvoir lancer cette appli.', 'Nexora', 0x10)
    sys.exit(1)
```

## C# / .NET

```csharp
if (!System.Diagnostics.Debugger.IsAttached && Environment.GetEnvironmentVariable("NEXORA_LAUNCHER") != "1")
{
    System.Windows.Forms.MessageBox.Show("Il faut aller dans le Nexora Launcher, puis cliquer sur « Lancer » pour pouvoir lancer cette appli.", "Nexora",
        System.Windows.Forms.MessageBoxButtons.OK, System.Windows.Forms.MessageBoxIcon.Error);
    Environment.Exit(1);
}
```
