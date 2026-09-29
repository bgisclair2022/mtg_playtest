"""Create a desktop (and Start menu) shortcut that opens MTG Goldfish with no console window."""
import os
import subprocess
import sys

ROOT = os.path.dirname(os.path.abspath(__file__))


def main():
    pythonw = os.path.join(os.path.dirname(sys.executable), "pythonw.exe")
    env = {**os.environ, "TARGET": pythonw, "APP": os.path.join(ROOT, "app.py"), "ROOT": ROOT,
           "ICON": os.path.join(ROOT, "assets", "goldfish.ico")}
    script = r"""
$shell = New-Object -ComObject WScript.Shell
foreach ($dir in @([Environment]::GetFolderPath('Desktop'), [Environment]::GetFolderPath('Programs'))) {
    $lnk = $shell.CreateShortcut((Join-Path $dir 'MTG Goldfish.lnk'))
    $lnk.TargetPath = $env:TARGET
    $lnk.Arguments = '"' + $env:APP + '"'
    $lnk.WorkingDirectory = $env:ROOT
    $lnk.IconLocation = $env:ICON + ',0'
    $lnk.Description = 'Test Commander decks against the Forge AI'
    $lnk.Save()
    Write-Output "Created $($lnk.FullName)"
}
"""
    subprocess.run(["powershell", "-NoProfile", "-Command", script], env=env, check=True)


if __name__ == "__main__":
    main()
