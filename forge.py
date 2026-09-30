"""Bridge to Forge (https://github.com/Card-Forge/forge): find the install, export decks
into Forge's commander deck folder, launch the GUI, and run headless AI-vs-AI sims."""
import glob
import os
import re
import subprocess
import threading
import time

HOME = os.path.expanduser("~")
EXPORT_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data", "forge-decks")
CANDIDATES = [os.path.join(HOME, "Forge"), r"C:\Forge", r"C:\Program Files\Forge",
              os.path.join(HOME, "Downloads", "Forge"), os.path.join(HOME, "Desktop", "Forge")]
RESULT = re.compile(r"Game Result: Game (\d+) ended in (?:a (Draw)!|(\d+) ms\. (.+?) has won!)")
TURN = re.compile(r"^Game Outcome: Turn (\d+)")  # rounds: each player took this many turns
LOST = re.compile(r"^Game Outcome: .+? has lost because (.+)")
NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0)


def find_jar(forge_dir):
    jars = glob.glob(os.path.join(forge_dir or "", "forge-gui-desktop-*-jar-with-dependencies.jar"))
    return max(jars) if jars else None


def detect():
    return next((d for d in CANDIDATES if find_jar(d)), None)


def java_version():
    try:
        out = subprocess.run(["java", "-version"], capture_output=True, text=True, creationflags=NO_WINDOW)
        return (out.stderr or out.stdout).splitlines()[0]
    except OSError:
        return None


def user_dir(forge_dir):
    """Forge's user data folder; forge.profile.properties can move it."""
    default = os.path.join(os.environ.get("APPDATA", HOME), "Forge")
    try:
        with open(os.path.join(forge_dir, "forge.profile.properties"), encoding="utf-8") as f:
            for line in f:
                if line.startswith("userDir="):
                    return line.split("=", 1)[1].strip() or default
    except OSError:
        pass
    return default


def deck_dir(forge_dir):
    return os.path.join(user_dir(forge_dir), "decks", "commander")


def alternate_names(forge_dir):
    """{alternate printed name (lowercase): Forge's card name}, from the Variant:...:FlavorName lines in Forge's
    card scripts. E.g. Universes Within reprints: 'Cecily, Haunted Mage' is Forge's 'Eleven, the Mage'. Cached."""
    import json
    import zipfile
    zpath = os.path.join(forge_dir, "res", "cardsfolder", "cardsfolder.zip")
    cache = os.path.join(os.path.dirname(EXPORT_DIR), "forge-alternate-names.json")
    try:
        if os.path.getmtime(cache) >= os.path.getmtime(zpath):
            with open(cache, encoding="utf-8") as f:
                return json.load(f)
    except OSError:
        pass
    out = {}
    with zipfile.ZipFile(zpath) as z:
        for n in z.namelist():
            if not n.endswith(".txt"):
                continue
            current = None
            for line in z.read(n).decode("utf-8", "replace").splitlines():
                if line.startswith("Name:"):
                    current = line[5:].strip()
                elif line.startswith("Variant:") and ":FlavorName:" in line and current:
                    out[line.split(":FlavorName:", 1)[1].strip().lower()] = current
    os.makedirs(os.path.dirname(cache), exist_ok=True)
    with open(cache, "w", encoding="utf-8") as f:
        json.dump(out, f)
    return out


def export(name, dck_text):
    """Write a .dck into our own folder (sims read it from there). Returns the filename."""
    os.makedirs(EXPORT_DIR, exist_ok=True)
    filename = re.sub(r"[^\w\- ]", "", name).strip() + ".dck"
    with open(os.path.join(EXPORT_DIR, filename), "w", encoding="utf-8") as f:
        f.write(dck_text)
    return filename


def install(forge_dir, filename):
    """Copy an exported deck into Forge's own deck folder so the Forge GUI lists it."""
    _copy_into(os.path.join(EXPORT_DIR, filename), deck_dir(forge_dir))


def _copy_into(src, dst_dir):
    """Copy a file into a folder from a child process, on purpose: Microsoft Store Python
    silently redirects its own writes under AppData into a private sandbox Forge can't see."""
    env = {**os.environ, "SRC": src, "DST": dst_dir}
    subprocess.run(["powershell", "-NoProfile", "-Command",
                    "New-Item -ItemType Directory -Force -Path $env:DST | Out-Null; Copy-Item -LiteralPath $env:SRC -Destination $env:DST -Force"],
                   env=env, check=True, creationflags=NO_WINDOW)


# Let the bot play its whole turn without asking you to click OK: no stops on AI phases,
# auto-pass whenever you have nothing to do, and no animation delays. You still get
# priority when the bot casts a spell or attacks, so you can respond and block.
AUTO_PREFS = {**{f"PHASE_AI_{p}": "false" for p in ("UPKEEP", "DRAW", "MAIN1", "BEGINCOMBAT", "DECLAREATTACKERS",
                                                   "DECLAREBLOCKERS", "FIRSTSTRIKE", "COMBATDAMAGE", "ENDCOMBAT",
                                                   "MAIN2", "EOT", "CLEANUP")},
              "YIELD_AUTO_PASS_NO_ACTIONS": "true", "YIELD_AUTO_PASS_RESPECTS_INTERRUPTS": "true",
              "YIELD_SKIP_PHASE_DELAY": "true", "YIELD_SKIP_RESOLVE_DELAY": "true", "UI_ALLOW_ESC_TO_END_TURN": "true"}


def apply_prefs(forge_dir, prefs=AUTO_PREFS):
    """Merge prefs into Forge's forge.preferences (written via a child process, see install())."""
    path = os.path.join(user_dir(forge_dir), "preferences", "forge.preferences")
    try:
        with open(path, encoding="utf-8") as f:
            lines = f.read().splitlines()
    except OSError:
        lines = []
    pending = dict(prefs)
    lines = [f"{k}={pending.pop(k)}" if (k := line.split("=", 1)[0]) in pending else line for line in lines]
    lines += [f"{k}={v}" for k, v in pending.items()]
    staged = os.path.join(os.path.dirname(EXPORT_DIR), "forge.preferences")
    with open(staged, "w", encoding="utf-8") as f:
        f.write("\n".join(lines) + "\n")
    _copy_into(staged, os.path.dirname(path))


def launch(forge_dir):
    exe = os.path.join(forge_dir, "forge.exe")
    cmd = [exe] if os.path.exists(exe) else ["java", "-jar", find_jar(forge_dir)]
    subprocess.Popen(cmd, cwd=forge_dir)


BRIDGE_SRC = os.path.join(os.path.dirname(os.path.abspath(__file__)), "bridge", "src")
BRIDGE_CLASSES = os.path.join(os.path.dirname(os.path.abspath(__file__)), "bridge", "classes")


def _jdk_tool(name):
    """Find a JDK tool (javac) on PATH, under JAVA_HOME, or in the usual install folders."""
    import shutil
    found = shutil.which(name)
    if found:
        return found
    roots = [os.environ.get("JAVA_HOME", "")] + glob.glob(r"C:\Program Files\Java\*") + glob.glob(r"C:\Program Files\Eclipse Adoptium\*")
    return next((p for r in roots if r and os.path.exists(p := os.path.join(r, "bin", name + ".exe"))), None)


def ensure_bridge(forge_dir):
    """Compile bridge/src against this Forge install if the classes are missing or out of date."""
    sources = glob.glob(os.path.join(BRIDGE_SRC, "**", "*.java"), recursive=True)
    stamp = os.path.join(BRIDGE_CLASSES, "built-against.txt")
    jar = find_jar(forge_dir)
    try:
        with open(stamp, encoding="utf-8") as f:
            fresh = f.read() == os.path.basename(jar) and os.path.getmtime(stamp) >= max(map(os.path.getmtime, sources))
    except OSError:
        fresh = False
    if fresh:
        return
    javac = _jdk_tool("javac")
    if not javac:
        if os.path.exists(stamp):
            return  # keep the bundled build rather than refuse to play
        raise ValueError("Playing in-app needs a Java JDK (javac) to build the Forge bridge once. Install one from https://adoptium.net/")
    os.makedirs(BRIDGE_CLASSES, exist_ok=True)
    out = subprocess.run([javac, "--release", "17", "-nowarn", "-cp", jar, "-d", BRIDGE_CLASSES, *sources],
                         capture_output=True, text=True, creationflags=NO_WINDOW)
    if out.returncode:
        raise ValueError("Building the Forge bridge failed:\n" + (out.stderr or out.stdout)[-1500:])
    with open(stamp, "w", encoding="utf-8") as f:
        f.write(os.path.basename(jar))


class Match:
    """A live in-app game: Forge's engine in a Java process, served to the board on a local port."""

    def __init__(self, forge_dir, your_deck, bot_deck, player_name="", env=None):
        import socket
        ensure_bridge(forge_dir)
        with socket.socket() as s:
            s.bind(("127.0.0.1", 0))
            self.port = s.getsockname()[1]
        # one log per match (data/logs/), so games running side by side don't overwrite each other's
        logs = os.path.join(os.path.dirname(EXPORT_DIR), "logs")
        os.makedirs(logs, exist_ok=True)
        for old in sorted(glob.glob(os.path.join(logs, "bridge-*.log")))[:-9]:  # keep the latest 10
            try:
                os.remove(old)
            except OSError:
                pass
        self.log_path = os.path.join(logs, f"bridge-{time.strftime('%Y%m%d-%H%M%S')}-{self.port}.log")
        log = open(self.log_path, "w", encoding="utf-8")
        cp = os.pathsep.join([find_jar(forge_dir), BRIDGE_CLASSES])
        self._proc = subprocess.Popen(
            ["java", "-Xmx4096m", "-cp", cp, "goldfish.Bridge", str(self.port),
             os.path.join(EXPORT_DIR, your_deck), os.path.join(EXPORT_DIR, bot_deck), player_name],
            cwd=forge_dir, stdin=subprocess.PIPE, stdout=log, stderr=subprocess.STDOUT, creationflags=NO_WINDOW,
            env={**os.environ, **(env or {})})

    def alive(self):
        return self._proc.poll() is None

    def stop(self):
        if self.alive():
            self._proc.kill()


class Installer:
    """Download the latest Forge release from GitHub and extract it to ~/Forge, in the background."""

    def __init__(self, target=CANDIDATES[0]):
        self.target, self.stage, self.progress, self.done, self.error = target, "Finding latest release", 0, False, None
        threading.Thread(target=self._run, daemon=True).start()

    def _run(self):
        import json, tarfile, urllib.request
        archive = os.path.join(self.target, "forge-download.tar.bz2")
        try:
            req = urllib.request.Request("https://api.github.com/repos/Card-Forge/forge/releases/latest",
                                         headers={"User-Agent": "MTGGoldfish/0.1"})
            with urllib.request.urlopen(req, timeout=30) as r:
                release = json.load(r)
            asset = next(a for a in release["assets"] if a["name"].endswith(".tar.bz2"))
            os.makedirs(self.target, exist_ok=True)
            self.stage = f"Downloading {release['tag_name']} ({asset['size'] // 2**20} MB)"
            with urllib.request.urlopen(asset["browser_download_url"], timeout=60) as r, open(archive, "wb") as f:
                got = 0
                while chunk := r.read(1 << 20):
                    f.write(chunk)
                    got += len(chunk)
                    self.progress = got / asset["size"]
            self.stage, self.progress = "Extracting", 1
            with tarfile.open(archive, "r:bz2") as tar:
                tar.extractall(self.target, filter="data")
            self.stage = "Installed"
        except Exception as e:  # noqa: BLE001 - reported to the UI
            self.error = str(e)
        finally:
            if os.path.exists(archive):
                os.remove(archive)
            self.done = True

    def status(self):
        return {"stage": self.stage, "progress": round(self.progress, 3), "done": self.done,
                "error": self.error, "ok": bool(find_jar(self.target))}


class Sim:
    """One background `forge sim` run; poll status() for progress and results."""

    def __init__(self, forge_dir, deck_files, labels, games, clock=300):
        self.labels, self.games = labels, games
        self.results = []  # {"game", "winner" (label or None for draw), "ms", "turns"}
        self.tail, self.done, self.error = [], False, None
        self._turn, self._reason = 0, None
        self._cancelled = False
        cmd = ["java", "-Xmx4096m", "-jar", find_jar(forge_dir), "sim",
               "-D", EXPORT_DIR + os.sep, "-d", *deck_files,
               "-f", "Commander", "-n", str(games), "-c", str(clock)]
        self._proc = subprocess.Popen(cmd, cwd=forge_dir, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                      text=True, encoding="utf-8", errors="replace", creationflags=NO_WINDOW)
        self.started = time.time()
        threading.Thread(target=self._read, daemon=True).start()

    def _read(self):
        try:
            self._parse()
        except Exception as e:  # noqa: BLE001 - never leave the UI polling a dead reader
            self.error = f"Couldn't read Forge output: {e}"
            self._proc.kill()
        finally:
            self.done = True

    def _parse(self):
        for line in self._proc.stdout:
            line = line.rstrip()
            self.tail = (self.tail + [line])[-40:]
            if m := TURN.match(line):
                self._turn = int(m[1])
            if m := LOST.match(line):
                self._reason = m[1].strip()
            if m := RESULT.search(line):
                # Forge names players "Ai(<seat>)-<deck>"; seat order follows the -d order.
                seat = re.match(r"Ai\((\d+)\)", m[4] or "")
                winner = None if m[2] else (self.labels[int(seat[1]) - 1] if seat else m[4])
                self.results.append({"game": int(m[1]), "winner": winner, "ms": int(m[3] or 0), "turns": self._turn or None, "reason": self._reason})
                self._turn, self._reason = 0, None
        code = self._proc.wait()
        if not self.results and not self._cancelled:
            self.error = "Forge finished (exit code %d) without playing a game. Last output:\n%s" % (code, "\n".join(self.tail[-15:]))

    def cancel(self):
        if not self.done:
            self._cancelled = True
            self._proc.kill()

    def status(self):
        wins = {label: sum(r["winner"] == label for r in self.results) for label in self.labels}
        turns = [r["turns"] for r in self.results if r["turns"]]
        return {
            "labels": self.labels, "games": self.games, "played": len(self.results), "done": self.done,
            "error": self.error, "wins": wins, "draws": sum(r["winner"] is None for r in self.results),
            "avg_turns": round(sum(turns) / len(turns), 1) if turns else None,
            "avg_seconds": round(sum(r["ms"] for r in self.results) / len(self.results) / 1000, 1) if self.results else None,
            "reasons": {r: sum(x["reason"] == r for x in self.results) for r in {x["reason"] for x in self.results if x["reason"]}},
            "elapsed": round(time.time() - self.started), "results": self.results, "tail": self.tail[-12:],
        }
