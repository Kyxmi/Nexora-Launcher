using System;
using System.Runtime.InteropServices;

// Petit programme placé par le Nexora-Launcher à la place du .exe d'une appli installée.
// Le vrai .exe est renommé (.nxe) et seul le launcher sait le lancer : ce programme se contente
// de dire d'aller dans le launcher. Il est compilé avec build/lock-stub/build.ps1.
static class Program
{
    // Marque que le launcher cherche pour reconnaître ce petit programme dans le dossier d'une appli.
    const string Marker = "NEXORA-LOCK-STUB-v2";

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    static extern int MessageBoxW(IntPtr hWnd, string text, string caption, uint type);

    [STAThread]
    static void Main(string[] args)
    {
        if (args.Length == 1 && args[0] == Marker) return; // garde la marque dans le programme compilé
        MessageBoxW(IntPtr.Zero,
            "Il faut aller dans le Nexora Launcher, puis cliquer sur « Lancer » pour pouvoir lancer cette appli.",
            "Nexora Launcher",
            0x10); // MB_OK | MB_ICONERROR
    }
}
