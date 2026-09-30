"""One-step setup, run by setup.bat: Python packages, Java, Forge, the Forge bridge, the desktop shortcut, then the app.

Everything already present is skipped, so running it again is safe (and is how you repair an install).
"""
import os
import shutil
import subprocess
import sys
import time

ROOT = os.path.dirname(os.path.abspath(__file__))
os.chdir(ROOT)
JDK = "EclipseAdoptium.Temurin.21.JDK"  # winget package id


def step(n, msg):
    print(f"\n[{n}/5] {msg}", flush=True)


def packages():
    subprocess.run([sys.executable, "-m", "pip", "install", "--quiet", "--disable-pip-version-check", "-r", "requirements.txt"], check=True)
    print("    Python packages ready.")


def java():
    import forge
    if forge.java_exe() and forge._jdk_tool("javac"):
        print(f"    Found {forge.java_version()}.")
        return True
    winget = shutil.which("winget")
    if not winget:
        print("    Java isn't installed and winget (Windows' app installer) isn't available.\n"
              "    Install a Java 17+ JDK from https://adoptium.net/ , then run setup.bat again.")
        return False
    print("    Installing Java (Temurin 21 JDK) with winget. Windows may ask for permission.")
    subprocess.run([winget, "install", "-e", "--id", JDK, "--silent", "--accept-package-agreements", "--accept-source-agreements"])
    if forge.java_exe() and forge._jdk_tool("javac"):
        print("    Java installed.")
        return True
    print("    Java still isn't found. Install a JDK from https://adoptium.net/ , then run setup.bat again.")
    return False


def forge_engine():
    import forge
    found = forge.detect()
    if found:
        print(f"    Found Forge in {found}.")
        return found
    print("    Downloading Forge (about 300 MB) into your user folder...")
    inst, last = forge.Installer(), ""
    while not inst.done:
        s = inst.status()
        line = f"    {s['stage']} {round(s['progress'] * 100)}%"
        if line != last:
            print(line, flush=True)
            last = line
        time.sleep(2)
    s = inst.status()
    if not s["ok"]:
        print(f"    Forge download failed: {s['error']}\n    Run setup.bat again, or install Forge from the app's Settings page.")
        return None
    print("    Forge installed.")
    return inst.target


def bridge(forge_dir):
    import forge
    forge.ensure_bridge(forge_dir)
    print("    Game bridge built.")


def main():
    if sys.version_info < (3, 10):
        print(f"MTG Goldfish needs Python 3.10 or newer (this is {sys.version.split()[0]}). "
              "Install a newer one from https://www.python.org/downloads/ and run setup.bat again.")
        return 1
    print("MTG Goldfish setup. This takes a few minutes the first time (mostly downloads).")
    step(1, "Python packages")
    packages()
    step(2, "Java (runs the Forge engine)")
    have_java = java()
    step(3, "Forge rules engine")
    forge_dir = forge_engine()
    step(4, "Game bridge")
    if forge_dir and have_java:
        try:
            bridge(forge_dir)
        except Exception as e:  # noqa: BLE001 - the app retries this before the first game
            print(f"    Couldn't build it yet ({e}). The app will try again before your first game.")
    else:
        print("    Skipped until Java and Forge are both installed.")
    step(5, "Desktop shortcut")
    import shortcut
    shortcut.main()
    ok = bool(forge_dir and have_java)
    print("\nAll set! Opening MTG Goldfish..." if ok else "\nAlmost there: fix the step above, then run setup.bat again. Opening the app anyway...")
    pythonw = os.path.join(os.path.dirname(sys.executable), "pythonw.exe")
    if "--no-launch" not in sys.argv:
        subprocess.Popen([pythonw if os.path.exists(pythonw) else sys.executable, os.path.join(ROOT, "app.py")], cwd=ROOT)
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
